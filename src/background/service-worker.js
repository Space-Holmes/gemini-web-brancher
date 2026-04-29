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
    branches: branchesForParentTab(state, tabId)
  };
}

async function handleCreateBranch(message, sender) {
  const parentTabId = requireSenderTab(sender);
  const shareUrl = normalizeShareUrl(message.shareUrl);
  const parentTab = await chrome.tabs.get(parentTabId);
  const { branchWindow, branchTab } = await createBranchWorker(shareUrl);

  const now = Date.now();
  const branch = {
    id: createId(),
    parentTabId,
    parentUrl: message.parentUrl || parentTab.url || "",
    parentTitle: message.parentTitle || parentTab.title || "",
    shareUrl,
    branchUrl: branchTab.url || shareUrl,
    tabId: branchTab.id,
    windowId: branchWindow ? branchWindow.id : null,
    status: "opening",
    createdAt: now,
    updatedAt: now,
    lastPrompt: "",
    lastOutput: "",
    error: ""
  };

  const state = await loadState();
  state.branches[branch.id] = branch;
  await saveState(state);
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
    await minimizeBranchWindow(branch);
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
  const branch = await updateBranchByTabId(tabId, {
    status: "streaming",
    branchUrl: message.url || "",
    lastOutput: output,
    error: "",
    updatedAt: Date.now()
  });

  if (branch) {
    await notifyParent(branch, {
      type: "GWB_BRANCH_OUTPUT",
      branchId: branch.id,
      output,
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

  const branch = await updateBranchByTabId(tabId, patch);
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
    await minimizeBranchWindow(branch);
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
      focused: true,
      state: "normal"
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

async function updateBranchByTabId(tabId, patch) {
  const state = await loadState();
  const branch = findBranchByTabId(state, tabId);
  if (!branch) {
    return null;
  }

  Object.assign(branch, patch);
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

async function createBranchWorker(shareUrl) {
  try {
    const branchWindow = await chrome.windows.create({
      url: shareUrl,
      type: "popup",
      focused: false,
      width: 420,
      height: 760,
      left: 0,
      top: 0
    });
    return {
      branchWindow,
      branchTab: await getWindowTab(branchWindow)
    };
  } catch (error) {
    console.warn("[Gemini Web Brancher] Worker window creation failed", error);
  }

  try {
    const branchWindow = await chrome.windows.create({
      url: shareUrl,
      type: "popup",
      focused: false
    });
    return {
      branchWindow,
      branchTab: await getWindowTab(branchWindow)
    };
  } catch (error) {
    console.warn("[Gemini Web Brancher] Popup window creation failed", error);
  }

  const branchTab = await chrome.tabs.create({
    url: shareUrl,
    active: false
  });
  return {
    branchWindow: null,
    branchTab
  };
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

async function minimizeBranchWindow(branch) {
  if (!branch || !Number.isInteger(branch.windowId)) {
    return;
  }

  try {
    await chrome.windows.update(branch.windowId, {
      state: "minimized"
    });
  } catch (error) {
    console.warn("[Gemini Web Brancher] Could not minimize branch window", error);
  }
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
      (parsed.hostname === "gemini.google.com" && parsed.pathname.startsWith("/share/"))
    );
  } catch {
    return false;
  }
}
