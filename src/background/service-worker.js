"use strict";

const STORAGE_KEY = "gwb:state:v1";
const SOURCE = "gwb";
const BRANCH_READY_TIMEOUT_MS = 60000;

const DEFAULT_STATE = {
  branches: {}
};

chrome.runtime.onInstalled.addListener(() => {
  loadState().then(saveState).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateBranchByTabId(tabId, {
    status: "closed",
    tabId: null,
    updatedAt: Date.now()
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== SOURCE || !message.type) {
    return false;
  }

  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("[Gemini Web Brancher]", error);
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GWB_CONTENT_READY":
      return handleContentReady(message, sender);

    case "GWB_CREATE_BRANCH":
      return handleCreateBranch(message, sender);

    case "GWB_LIST_BRANCHES":
      return handleListBranches(message, sender);

    case "GWB_SEND_PROMPT":
      return handleSendPrompt(message, sender);

    case "GWB_BRANCH_READY":
      return handleBranchReady(message, sender);

    case "GWB_BRANCH_OUTPUT":
      return handleBranchOutput(message, sender);

    case "GWB_BRANCH_DONE":
      return handleBranchDone(message, sender);

    case "GWB_BRANCH_ERROR":
      return handleBranchError(message, sender);

    case "GWB_CLOSE_BRANCH":
      return handleCloseBranch(message);

    case "GWB_FOCUS_BRANCH":
      return handleFocusBranch(message);

    case "GWB_LIST_ALL_BRANCHES":
      return handleListAllBranches();

    case "GWB_CLEAR_CLOSED":
      return handleClearClosed();

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function handleContentReady(message, sender) {
  const tabId = requireSenderTab(sender);
  const state = await loadState();
  const branch = findBranchByTabId(state, tabId);

  if (branch) {
    if (message.url && branch.branchUrl !== message.url) {
      branch.branchUrl = message.url;
      branch.updatedAt = Date.now();
      await saveState(state);
    }
    return {
      role: "branch",
      branch
    };
  }

  return {
    role: "parent",
    branches: branchesForParentConversation(state, tabId, message.parentConversationKey || conversationKeyFromUrl(message.url))
  };
}

async function handleListBranches(message, sender) {
  const parentTabId = requireSenderTab(sender);
  const state = await loadState();
  return {
    branches: branchesForParentConversation(state, parentTabId, message.parentConversationKey || conversationKeyFromUrl(message.url))
  };
}

async function handleCreateBranch(message, sender) {
  const parentTabId = requireSenderTab(sender);
  const shareUrl = normalizeShareUrl(message.shareUrl);
  const parentTab = await chrome.tabs.get(parentTabId);
  const state = await loadState();
  const parentUrl = message.parentUrl || parentTab.url || "";
  const parentConversationKey = message.parentConversationKey || conversationKeyFromUrl(parentUrl);
  const branchNumber = nextBranchNumber(state, parentTabId, parentConversationKey);
  const branchSuffix = `_branch${branchNumber}`;
  const { branchWindow, branchTab, workerMode } = await createBranchWorker(parentTab);

  const now = Date.now();
  const branch = {
    id: createId(),
    parentTabId,
    parentUrl,
    parentTitle: message.parentTitle || parentTab.title || "",
    parentConversationKey,
    branchNumber,
    branchSuffix,
    shareUrl,
    branchUrl: shareUrl,
    tabId: branchTab.id,
    windowId: branchWindow ? branchWindow.id : null,
    workerMode,
    status: "opening",
    createdAt: now,
    updatedAt: now,
    lastPrompt: "",
    lastOutput: "",
    messages: [],
    error: ""
  };

  state.branches[branch.id] = branch;
  await saveState(state);
  await navigateBranchWorker(branch, shareUrl);
  await notifyParent(branch, {
    type: "GWB_BRANCH_STATE",
    branch
  });

  return { branch };
}

async function handleSendPrompt(message) {
  const prompt = String(message.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is empty.");
  }

  let state = await loadState();
  let branch = state.branches[message.branchId];
  if (!branch) {
    throw new Error("Branch not found.");
  }
  if (!Number.isInteger(branch.tabId)) {
    throw new Error("Branch worker is closed.");
  }

  if (branch.status !== "ready") {
    await notifyParent(branch, {
      type: "GWB_BRANCH_STATE",
      branch: {
        ...branch,
        status: "opening",
        error: "Preparing branch worker..."
      }
    });
    branch = await waitForBranchReady(branch.id, BRANCH_READY_TIMEOUT_MS);
    state = await loadState();
    branch = state.branches[message.branchId] || branch;
  }

  const turnId = createId();
  ensureBranchMessages(branch).push({
    id: turnId,
    prompt,
    output: "",
    outputHtml: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  branch.activeTurnId = turnId;
  branch.status = "sending";
  branch.lastPrompt = prompt;
  branch.error = "";
  branch.updatedAt = Date.now();
  await saveState(state);
  await notifyParent(branch, {
    type: "GWB_BRANCH_STATE",
    branch
  });

  await chrome.tabs.sendMessage(branch.tabId, {
    source: SOURCE,
    type: "GWB_BRANCH_SUBMIT_PROMPT",
    branchId: branch.id,
    branch,
    turnId,
    prompt
  });

  return { branch };
}

async function handleBranchReady(message, sender) {
  const tabId = requireSenderTab(sender);
  const branch = await updateBranchByTabId(tabId, {
    status: "ready",
    branchUrl: message.url || "",
    error: "",
    updatedAt: Date.now()
  });

  if (branch) {
    await notifyParent(branch, {
      type: "GWB_BRANCH_STATE",
      branch
    });
  }

  return { branch };
}

async function handleBranchOutput(message, sender) {
  const tabId = requireSenderTab(sender);
  const output = String(message.output || "");
  const outputHtml = String(message.html || "");
  const branch = await updateBranchByTabId(tabId, {
    status: "streaming",
    branchUrl: message.url || "",
    lastOutput: output,
    error: "",
    updatedAt: Date.now()
  }, (branch) => {
    updateBranchTurn(branch, message.turnId, {
      output,
      outputHtml,
      updatedAt: Date.now()
    });
  });

  if (branch) {
    await notifyParent(branch, {
      type: "GWB_BRANCH_OUTPUT",
      branchId: branch.id,
      output,
      html: outputHtml,
      branch
    });
  }

  return { branch };
}

async function handleBranchDone(message, sender) {
  const tabId = requireSenderTab(sender);
  const patch = {
    status: "ready",
    branchUrl: message.url || "",
    updatedAt: Date.now()
  };
  if (typeof message.output === "string") {
    patch.lastOutput = message.output;
  }

  const branch = await updateBranchByTabId(tabId, patch, (branch) => {
    updateBranchTurn(branch, message.turnId, {
      output: String(message.output || ""),
      outputHtml: String(message.html || ""),
      updatedAt: Date.now()
    });
    branch.activeTurnId = null;
  });
  if (branch) {
    await notifyParent(branch, {
      type: "GWB_BRANCH_STATE",
      branch
    });
  }

  return { branch };
}

async function handleBranchError(message, sender) {
  const tabId = requireSenderTab(sender);
  const branch = await updateBranchByTabId(tabId, {
    status: "error",
    error: String(message.error || "Branch automation failed."),
    branchUrl: message.url || "",
    updatedAt: Date.now()
  });

  if (branch) {
    await notifyParent(branch, {
      type: "GWB_BRANCH_STATE",
      branch
    });
  }

  return { branch };
}

async function handleCloseBranch(message) {
  const state = await loadState();
  const branch = state.branches[message.branchId];
  if (!branch) {
    throw new Error("Branch not found.");
  }

  if (Number.isInteger(branch.tabId)) {
    try {
      await chrome.tabs.remove(branch.tabId);
    } catch (error) {
      console.warn("[Gemini Web Brancher] Could not close branch worker", error);
    }
  }

  branch.status = "closed";
  branch.tabId = null;
  branch.updatedAt = Date.now();
  await saveState(state);
  await notifyParent(branch, {
    type: "GWB_BRANCH_STATE",
    branch
  });
  return { branch };
}

async function handleFocusBranch(message) {
  const state = await loadState();
  const branch = state.branches[message.branchId];
  if (!branch) {
    throw new Error("Branch not found.");
  }
  if (!Number.isInteger(branch.tabId)) {
    throw new Error("Branch worker is closed.");
  }

  const tab = await chrome.tabs.update(branch.tabId, { active: true });
  const windowId = Number.isInteger(branch.windowId) ? branch.windowId : tab.windowId;
  if (Number.isInteger(windowId)) {
    await chrome.windows.update(windowId, {
      focused: true
    });
  }
  return { branch };
}

async function handleListAllBranches() {
  const state = await loadState();
  return {
    branches: Object.values(state.branches).sort((a, b) => b.createdAt - a.createdAt)
  };
}

async function handleClearClosed() {
  const state = await loadState();
  for (const [id, branch] of Object.entries(state.branches)) {
    if (branch.status === "closed" || !branch.tabId) {
      delete state.branches[id];
    }
  }
  await saveState(state);
  return {
    branches: Object.values(state.branches).sort((a, b) => b.createdAt - a.createdAt)
  };
}

async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const state = result[STORAGE_KEY] || DEFAULT_STATE;
  return {
    branches: { ...(state.branches || {}) }
  };
}

async function saveState(state) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      branches: state.branches || {}
    }
  });
}

async function updateBranchByTabId(tabId, patch, mutate) {
  const state = await loadState();
  const branch = findBranchByTabId(state, tabId);
  if (!branch) {
    return null;
  }

  Object.assign(branch, patch);
  if (mutate) {
    mutate(branch);
  }
  if (!patch.branchUrl && Number.isInteger(branch.tabId)) {
    try {
      const tab = await chrome.tabs.get(branch.tabId);
      branch.branchUrl = tab.url || branch.branchUrl;
    } catch {
      // Branch worker may already be gone.
    }
  }
  await saveState(state);
  return branch;
}

function ensureBranchMessages(branch) {
  if (!Array.isArray(branch.messages)) {
    branch.messages = [];
  }
  return branch.messages;
}

function updateBranchTurn(branch, turnId, patch) {
  const messages = ensureBranchMessages(branch);
  const target = messages.find((message) => message.id === turnId) || messages[messages.length - 1];
  if (target) {
    Object.assign(target, patch);
  }
}

async function notifyParent(branch, payload) {
  if (!branch || !Number.isInteger(branch.parentTabId)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(branch.parentTabId, {
      source: SOURCE,
      ...payload
    });
  } catch (error) {
    console.warn("[Gemini Web Brancher] Parent tab not reachable", error);
  }
}

function findBranchByTabId(state, tabId) {
  return Object.values(state.branches).find((branch) => branch.tabId === tabId) || null;
}

function branchesForParentTab(state, parentTabId) {
  return Object.values(state.branches)
    .filter((branch) => branch.parentTabId === parentTabId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function branchesForParentConversation(state, parentTabId, parentConversationKey, options = {}) {
  return branchesForParentTab(state, parentTabId)
    .filter((branch) => branchConversationKey(branch) === parentConversationKey)
    .filter((branch) => options.includeClosed || branch.status !== "closed");
}

function nextBranchNumber(state, parentTabId, parentConversationKey) {
  const existing = branchesForParentConversation(state, parentTabId, parentConversationKey, {
    includeClosed: true
  })
    .map((branch) => Number(branch.branchNumber) || 0);
  return existing.length ? Math.max(...existing) + 1 : 1;
}

function branchConversationKey(branch) {
  return branch.parentConversationKey || conversationKeyFromUrl(branch.parentUrl);
}

function conversationKeyFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname === "gemini.google.com" && parsed.pathname.startsWith("/app/")) {
      const [, app, conversationId] = parsed.pathname.split("/");
      if (app === "app" && conversationId) {
        return `app:${conversationId}`;
      }
    }
    parsed.hash = "";
    return `url:${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return `url:${String(url || "").split("#")[0]}`;
  }
}

async function createBranchWorker(parentTab) {
  try {
    const branchWindow = await chrome.windows.create({
      url: "about:blank",
      type: "normal",
      focused: false,
      width: 980,
      height: 820
    });
    const branchTab = await getWindowTab(branchWindow);
    await keepBranchTabAlive(branchTab);
    return {
      branchWindow,
      branchTab,
      workerMode: "background-window"
    };
  } catch (error) {
    console.warn("[Gemini Web Brancher] Worker window creation failed", error);
  }

  const tabCreateOptions = {
    url: "about:blank",
    active: false
  };
  if (parentTab && Number.isInteger(parentTab.windowId)) {
    tabCreateOptions.windowId = parentTab.windowId;
  }
  const branchTab = await chrome.tabs.create(tabCreateOptions);
  await keepBranchTabAlive(branchTab);
  return {
    branchWindow: null,
    branchTab,
    workerMode: "background-tab-fallback"
  };
}

async function navigateBranchWorker(branch, url) {
  if (!branch || !Number.isInteger(branch.tabId)) {
    throw new Error("Branch worker is not ready to navigate.");
  }

  await chrome.tabs.update(branch.tabId, {
    url
  });
}

async function keepBranchTabAlive(branchTab) {
  if (!branchTab || !Number.isInteger(branchTab.id)) {
    return;
  }

  try {
    await chrome.tabs.update(branchTab.id, {
      autoDiscardable: false
    });
  } catch (error) {
    console.warn("[Gemini Web Brancher] Could not disable branch tab discard", error);
  }
}

async function getWindowTab(window) {
  if (window && Array.isArray(window.tabs) && window.tabs[0] && Number.isInteger(window.tabs[0].id)) {
    return window.tabs[0];
  }

  if (window && Number.isInteger(window.id)) {
    const tabs = await chrome.tabs.query({ windowId: window.id });
    if (tabs[0] && Number.isInteger(tabs[0].id)) {
      return tabs[0];
    }
  }

  throw new Error("Could not create branch worker window.");
}

async function waitForBranchReady(branchId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await loadState();
    const branch = state.branches[branchId];
    if (!branch) {
      throw new Error("Branch not found.");
    }
    if (branch.status === "ready") {
      return branch;
    }
    if (branch.status === "error" || branch.status === "closed") {
      throw new Error(branch.error || `Branch worker is ${branch.status}.`);
    }
    await sleep(500);
  }

  throw new Error("Timed out waiting for branch worker to become ready.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireSenderTab(sender) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    throw new Error("This action must come from a tab.");
  }
  return sender.tab.id;
}

function createId() {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (part) => part.toString(36)).join("-");
}

function normalizeShareUrl(url) {
  const value = String(url || "").trim();
  if (!isGeminiShareUrl(value)) {
    throw new Error("No Gemini share URL was found.");
  }
  return value;
}

function isGeminiShareUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "g.co" && parsed.pathname.startsWith("/gemini/share/")) ||
      (parsed.hostname === "gemini.google.com" && parsed.pathname.startsWith("/share/")) ||
      (parsed.hostname === "gemini.google.com" && /^\/app\/[A-Za-z0-9_-]+\/share\//.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}
