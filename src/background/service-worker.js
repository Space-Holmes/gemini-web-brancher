"use strict";

const STORAGE_KEY = "gwb:state:v1";
const SOURCE = "gwb";
const BRANCH_READY_TIMEOUT_MS = 60000;
const BRANCH_WAKE_INTERVAL_MS = 5000;
const RESPONSE_IDLE_MS = 15000;

const DEFAULT_STATE = {
  branches: {}
};

let stateMutationQueue = Promise.resolve();
const branchWakeTimes = new Map();

chrome.runtime.onInstalled.addListener(() => {
  withStateMutation((state) => state).catch(console.error);
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

    case "GWB_POLL_BRANCH_OUTPUT":
      return handlePollBranchOutput(message);

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

  return withStateMutation((state) => {
    const branch = findBranchByTabId(state, tabId);

    if (branch) {
      if (message.url && branch.branchUrl !== message.url) {
        branch.branchUrl = message.url;
        branch.updatedAt = Date.now();
      }
      return {
        role: "branch",
        branch
      };
    }

    return {
      role: "parent",
      branches: registerParentTabForConversation(
        state,
        tabId,
        message.parentConversationKey || conversationKeyFromUrl(message.url)
      )
    };
  });
}

async function handleListBranches(message, sender) {
  const parentTabId = requireSenderTab(sender);
  return withStateMutation((state) => ({
    branches: registerParentTabForConversation(
      state,
      parentTabId,
      message.parentConversationKey || conversationKeyFromUrl(message.url)
    )
  }));
}

async function handleCreateBranch(message, sender) {
  const parentTabId = requireSenderTab(sender);
  const shareUrl = normalizeShareUrl(message.shareUrl);
  const parentTab = await chrome.tabs.get(parentTabId);
  const parentUrl = message.parentUrl || parentTab.url || "";
  const parentConversationKey = message.parentConversationKey || conversationKeyFromUrl(parentUrl);
  const { branchWindow, branchTab, workerMode } = await createBranchWorker(parentTab);

  const branch = await withStateMutation((state) => {
    const branchNumber = nextBranchNumber(state, parentConversationKey);
    const branchSuffix = `_branch${branchNumber}`;
    const now = Date.now();
    const nextBranch = {
      id: createId(),
      parentTabId,
      parentTabIds: [parentTabId],
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

    state.branches[nextBranch.id] = nextBranch;
    return nextBranch;
  });

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

  let state = await readState();
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
    state = await readState();
    branch = state.branches[message.branchId] || branch;
  }

  const baselineSnapshot = await captureBranchSnapshot(branch.tabId).catch((error) => {
    console.warn("[Gemini Web Brancher] Could not capture branch baseline", error);
    return null;
  });
  const baselineOutput = baselineSnapshot && baselineSnapshot.output ? String(baselineSnapshot.output) : "";
  const baselineFingerprints = snapshotCandidateFingerprints(baselineSnapshot);
  const baselineCandidateCount = Number(baselineSnapshot && baselineSnapshot.candidateCount) || baselineFingerprints.length;
  const turnId = createId();
  branch = await withStateMutation((state) => {
    const branch = state.branches[message.branchId];
    if (!branch) {
      throw new Error("Branch not found.");
    }
    if (!Number.isInteger(branch.tabId)) {
      throw new Error("Branch worker is closed.");
    }

    ensureBranchMessages(branch).push({
      id: turnId,
      prompt,
      output: "",
      outputHtml: "",
      baselineOutput,
      baselineFingerprints,
      baselineCandidateCount,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    branch.activeTurnId = turnId;
    branch.activeTurnBaselineOutput = baselineOutput;
    branch.activeTurnBaselineFingerprints = baselineFingerprints;
    branch.activeTurnBaselineCandidateCount = baselineCandidateCount;
    branch.snapshotBaselineCaptured = Boolean(baselineSnapshot);
    branch.activeTurnStartedAt = Date.now();
    branch.lastOutputAt = 0;
    branch.status = "sending";
    branch.lastPrompt = prompt;
    branch.error = "";
    branch.updatedAt = Date.now();
    return branch;
  });

  await notifyParent(branch, {
    type: "GWB_BRANCH_STATE",
    branch
  });

  await wakeBranchWorker(branch, { force: true });
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

async function handlePollBranchOutput(message) {
  const requestedIds = new Set(Array.isArray(message.branchIds) ? message.branchIds : []);
  const state = await readState();
  const branches = Object.values(state.branches)
    .filter((branch) => Number.isInteger(branch.tabId))
    .filter((branch) => branch.status === "sending" || branch.status === "streaming")
    .filter((branch) => !requestedIds.size || requestedIds.has(branch.id));

  await Promise.all(branches.map(async (branch) => {
    try {
      await wakeBranchWorker(branch);
      void chrome.tabs.sendMessage(branch.tabId, {
        source: SOURCE,
        type: "GWB_BRANCH_POLL_OUTPUT",
        branchId: branch.id,
        branch
      }).catch((error) => {
        console.warn("[Gemini Web Brancher] Could not poll branch worker", error);
      });
    } catch (error) {
      console.warn("[Gemini Web Brancher] Could not poll branch worker", error);
    }
    try {
      const snapshot = await captureBranchSnapshot(branch.tabId, branchSnapshotContext(branch));
      await handleBranchSnapshot(branch.id, snapshot);
    } catch (error) {
      console.warn("[Gemini Web Brancher] Could not capture branch worker output", error);
    }
  }));

  return {
    polled: branches.length
  };
}

async function wakeBranchWorker(branch, options = {}) {
  if (!branch || branch.workerMode !== "background-window" || !Number.isInteger(branch.tabId)) {
    return;
  }

  const now = Date.now();
  const lastWakeAt = branchWakeTimes.get(branch.id) || 0;
  if (!options.force && now - lastWakeAt < BRANCH_WAKE_INTERVAL_MS) {
    return;
  }
  branchWakeTimes.set(branch.id, now);

  try {
    await chrome.tabs.update(branch.tabId, {
      active: true
    });
  } catch (error) {
    console.warn("[Gemini Web Brancher] Could not wake branch worker", error);
  }
}

async function captureBranchSnapshot(tabId, context = {}) {
  if (!Number.isInteger(tabId) || !chrome.scripting || !chrome.scripting.executeScript) {
    return null;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [context || {}],
    func: (snapshotContext) => {
      const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const fingerprintFor = (value) => {
        const text = normalizeText(value);
        let hash = 0;
        for (let index = 0; index < text.length; index += 1) {
          hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
        }
        return `${text.length}:${hash.toString(36)}`;
      };
      const uniqueElements = (elements) => Array.from(new Set(elements.filter(Boolean)));
      const queryAllDeep = (root, selector) => {
        const results = [];
        const visit = (node) => {
          if (!node || !node.querySelectorAll) {
            return;
          }
          results.push(...node.querySelectorAll(selector));
          for (const element of node.querySelectorAll("*")) {
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }
          }
        };
        visit(root);
        return uniqueElements(results);
      };
      const labelFor = (element) => [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-tooltip"),
        element.innerText,
        element.textContent
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const descriptorFor = (element) => [
        element.localName,
        element.className,
        element.id,
        element.getAttribute("data-test-id"),
        element.getAttribute("data-testid"),
        element.getAttribute("aria-label"),
        element.getAttribute("role")
      ].filter(Boolean).join(" ").toLowerCase();
      const textIncludesNormalized = (text, needle) => {
        const normalizedText = normalizeText(text).toLowerCase();
        const normalizedNeedle = normalizeText(needle).toLowerCase();
        return Boolean(normalizedNeedle && normalizedText.includes(normalizedNeedle));
      };
      const isBaselineEcho = (text, baseline) => {
        if (!baseline) {
          return false;
        }
        if (text === baseline) {
          return true;
        }
        const shorter = text.length < baseline.length ? text : baseline;
        const longer = text.length < baseline.length ? baseline : text;
        return shorter.length > 80 && longer.includes(shorter) && shorter.length / longer.length > 0.65;
      };
      const isTransient = (text) => {
        const normalized = normalizeText(text)
          .toLowerCase()
          .replace(/[’`]/g, "'")
          .replace(/\s+/g, " ");
        if (!normalized || normalized.length > 180 || normalized.includes("\n")) {
          return false;
        }
        return [
          /understanding (the )?(user'?s|your) input/,
          /understanding input/,
          /thinking/,
          /generating/,
          /analy[sz]ing/,
          /working on it/,
          /just a sec/,
          /loading/,
          /正在(理解|思考|生成|分析|处理)/,
          /理解.*输入/,
          /思考中/,
          /生成中/,
          /分析中/
        ].some((pattern) => pattern.test(normalized));
      };
      const looksLikeModelResponseElement = (element) => /model-response|response|assistant|message-content|markdown/.test(descriptorFor(element));
      const responseSelector = [
        "model-response",
        "[data-test-id*='model-response' i]",
        "[data-testid*='model-response' i]",
        "[data-test-id*='response' i]",
        "[data-testid*='response' i]",
        "[class*='model-response' i]",
        "message-content",
        ".markdown"
      ].join(",");
      const countNestedResponseCandidates = (element) => queryAllDeep(element, responseSelector)
        .filter((candidate) => candidate !== element)
        .length;
      const looksLikeWholeConversationElement = (element, text) => {
        if (!element || !(element instanceof Element)) {
          return false;
        }
        if (element.matches("model-response, message-content, .markdown")) {
          return countNestedResponseCandidates(element) > 1;
        }
        const descriptor = descriptorFor(element);
        if (/conversation|chat-history|conversation-container|main/.test(descriptor) && countNestedResponseCandidates(element) > 1) {
          return true;
        }
        return /(\b(you|gemini)\b|你说|我说|用户|assistant|model)/i.test(text) && text.length > 1800;
      };
      const isLikelyResponseCandidate = (element) => {
        if (!element || !(element instanceof Element)) {
          return false;
        }
        if (element.closest("button, [role='button'], input, textarea, select, option")) {
          return false;
        }
        if (element.closest("[role='dialog'], mat-dialog-container, .cdk-overlay-pane")) {
          return false;
        }
        if (element.closest("nav, aside, header") && !looksLikeModelResponseElement(element)) {
          return false;
        }
        return true;
      };

      const rawCandidates = uniqueElements(queryAllDeep(document, responseSelector))
        .filter(isLikelyResponseCandidate)
        .filter((element) => normalizeText(element.innerText || element.textContent || "").length > 1);
      const leafCandidates = rawCandidates.filter((element) => {
        const textLength = normalizeText(element.innerText || element.textContent || "").length;
        return !rawCandidates.some((other) => {
          if (other === element || !element.contains(other)) {
            return false;
          }
          const otherLength = normalizeText(other.innerText || other.textContent || "").length;
          return otherLength >= Math.min(textLength * 0.7, 80);
        });
      });
      const elements = leafCandidates.length ? leafCandidates : rawCandidates;
      const baselineOutput = normalizeText(snapshotContext && snapshotContext.baselineOutput);
      const currentOutput = normalizeText(snapshotContext && snapshotContext.currentOutput);
      const submittedPrompt = normalizeText(snapshotContext && snapshotContext.prompt);
      const baselineCandidateCount = Number(snapshotContext && snapshotContext.baselineCandidateCount) || 0;
      const baselineFingerprints = new Set((Array.isArray(snapshotContext && snapshotContext.baselineFingerprints)
        ? snapshotContext.baselineFingerprints
        : []).map(normalizeText).filter(Boolean));
      const candidates = elements.map((element, index) => {
        const text = normalizeText(element.innerText || element.textContent || "");
        const modelLike = looksLikeModelResponseElement(element);
        const wholeConversation = looksLikeWholeConversationElement(element, text);
        const promptEcho = Boolean(submittedPrompt && (
          text === submittedPrompt ||
          (textIncludesNormalized(text, submittedPrompt) && text.length <= submittedPrompt.length + 30)
        ));
        const containsPrompt = Boolean(submittedPrompt && textIncludesNormalized(text, submittedPrompt));
        const containsBaseline = Boolean(baselineOutput && textIncludesNormalized(text, baselineOutput) && text.length > baselineOutput.length + 80);
        const changed = Boolean(
          text &&
          text !== baselineOutput &&
          text !== currentOutput &&
          !baselineFingerprints.has(text) &&
          !baselineFingerprints.has(fingerprintFor(text)) &&
          !isBaselineEcho(text, baselineOutput)
        );
        let score = 0;
        if (changed) {
          score += 80;
        }
        if (baselineCandidateCount && index >= baselineCandidateCount) {
          score += 90;
        }
        if (modelLike) {
          score += 40;
        }
        if (wholeConversation) {
          score -= 220;
        }
        if (containsPrompt) {
          score -= modelLike ? 50 : 140;
        }
        if (promptEcho) {
          score -= 240;
        }
        if (containsBaseline) {
          score -= 140;
        }
        if (text.length > 10000) {
          score -= 80;
        }
        score += Math.min(index, 100) / 100;
        return {
          index,
          text,
          html: String(element.innerHTML || ""),
          fingerprint: fingerprintFor(text),
          modelLike,
          wholeConversation,
          promptEcho,
          transient: isTransient(text),
          changed,
          score
        };
      });
      const latest = candidates[candidates.length - 1] || null;
      const selected = candidates
        .filter((candidate) => candidate.changed && !candidate.transient && !candidate.promptEcho && candidate.score > 30)
        .sort((a, b) => {
          if (a.score !== b.score) {
            return b.score - a.score;
          }
          return b.index - a.index;
        })[0] || null;
      const actions = queryAllDeep(document, "button, [role='button']")
        .map((element) => labelFor(element).toLowerCase())
        .filter(Boolean);
      const generating = actions.some((label) => /stop generating|stop response|停止生成|停止回答|停止回复/.test(label)) ||
        queryAllDeep(document, "[aria-busy='true'], [role='progressbar'], mat-progress-spinner, mat-spinner, [class*='spinner' i], [class*='loading' i]").length > 0;

      return {
        output: (selected || latest) ? (selected || latest).text : "",
        html: (selected || latest) ? (selected || latest).html : "",
        selectedIndex: (selected || latest) ? (selected || latest).index : -1,
        selectedScore: selected ? selected.score : 0,
        selectedFromBaseline: Boolean(selected),
        url: location.href,
        title: document.title,
        candidateCount: candidates.length,
        candidates: candidates.slice(-80).map((candidate) => ({
          index: candidate.index,
          text: candidate.text,
          fingerprint: candidate.fingerprint,
          score: candidate.score,
          changed: candidate.changed,
          transient: candidate.transient,
          promptEcho: candidate.promptEcho,
          modelLike: candidate.modelLike,
          wholeConversation: candidate.wholeConversation
        })),
        generating,
        capturedAt: Date.now()
      };
    }
  });

  return results && results[0] ? results[0].result : null;
}

async function handleBranchSnapshot(branchId, snapshot) {
  if (!snapshot) {
    return null;
  }

  const updated = await withStateMutation((state) => {
    const branch = state.branches[branchId];
    if (!branch || !Number.isInteger(branch.tabId) || !branch.activeTurnId) {
      return null;
    }
    if (branch.status !== "sending" && branch.status !== "streaming") {
      return null;
    }
    if (!branch.snapshotBaselineCaptured) {
      return null;
    }

    const turn = getActiveBranchTurn(branch);
    if (!turn) {
      return null;
    }

    const output = String(snapshot.output || "");
    const currentOutput = String(turn.output || branch.lastOutput || "");
    if (!shouldAcceptBranchOutput(branch, output, { allowSame: false }) || normalizeOutputText(output) === normalizeOutputText(currentOutput)) {
      return null;
    }

    const now = Date.now();
    branch.status = "streaming";
    branch.branchUrl = snapshot.url || branch.branchUrl;
    branch.lastOutput = output;
    branch.lastOutputAt = now;
    branch.error = "";
    branch.updatedAt = now;
    updateBranchTurn(branch, branch.activeTurnId, {
      output,
      outputHtml: String(snapshot.html || ""),
      updatedAt: now
    });
    return branch;
  });

  if (updated) {
    await notifyParent(updated, {
      type: "GWB_BRANCH_OUTPUT",
      branchId: updated.id,
      output: updated.lastOutput,
      html: getActiveBranchTurn(updated)?.outputHtml || "",
      branch: updated
    });
  }

  const doneBranch = await maybeFinishBranchFromSnapshot(branchId, snapshot);
  if (doneBranch) {
    await notifyParent(doneBranch, {
      type: "GWB_BRANCH_STATE",
      branch: doneBranch
    });
  }
  return updated || doneBranch;
}

async function maybeFinishBranchFromSnapshot(branchId, snapshot) {
  return withStateMutation((state) => {
    const branch = state.branches[branchId];
    if (!branch || !branch.activeTurnId || (branch.status !== "sending" && branch.status !== "streaming")) {
      return null;
    }
    const turn = getActiveBranchTurn(branch);
    if (!turn || !turn.output) {
      return null;
    }
    const lastOutputAt = Number(branch.lastOutputAt || turn.updatedAt || 0);
    if (!lastOutputAt || Date.now() - lastOutputAt < RESPONSE_IDLE_MS || snapshot.generating) {
      return null;
    }
    branch.status = "ready";
    branch.activeTurnId = null;
    branch.updatedAt = Date.now();
    return branch;
  });
}

async function handleBranchOutput(message, sender) {
  const tabId = requireSenderTab(sender);
  const output = String(message.output || "");
  const outputHtml = String(message.html || "");
  const branch = await withStateMutation((state) => {
    const branch = findBranchByTabId(state, tabId);
    if (!branch || !branch.activeTurnId || (branch.status !== "sending" && branch.status !== "streaming")) {
      return null;
    }
    if (!shouldAcceptBranchOutput(branch, output, { allowSame: false })) {
      return null;
    }
    const now = Date.now();
    branch.status = "streaming";
    branch.branchUrl = message.url || branch.branchUrl;
    branch.lastOutput = output;
    branch.lastOutputAt = now;
    branch.error = "";
    branch.updatedAt = now;
    updateBranchTurn(branch, message.turnId, {
      output,
      outputHtml,
      updatedAt: now
    });
    return branch;
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
  const incomingOutput = typeof message.output === "string" ? String(message.output || "") : "";
  const incomingHtml = String(message.html || "");

  const branch = await withStateMutation((state) => {
    const branch = findBranchByTabId(state, tabId);
    if (!branch) {
      return null;
    }
    if (!branch.activeTurnId || (branch.status !== "sending" && branch.status !== "streaming")) {
      return null;
    }
    const turn = getActiveBranchTurn(branch);
    const canUseIncoming = incomingOutput && shouldAcceptBranchOutput(branch, incomingOutput, { allowSame: true });
    if (canUseIncoming) {
      const now = Date.now();
      branch.lastOutput = incomingOutput;
      branch.lastOutputAt = now;
      updateBranchTurn(branch, message.turnId, {
        output: incomingOutput,
        outputHtml: incomingHtml,
        updatedAt: now
      });
    } else if (!turn || !turn.output) {
      return null;
    }
    branch.status = "ready";
    branch.branchUrl = message.url || branch.branchUrl;
    branch.updatedAt = Date.now();
    branch.activeTurnId = null;
    return branch;
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
  const state = await readState();
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

  const closedBranch = await withStateMutation((state) => {
    const branch = state.branches[message.branchId];
    if (!branch) {
      throw new Error("Branch not found.");
    }
    branch.status = "closed";
    branch.tabId = null;
    branch.updatedAt = Date.now();
    return branch;
  });

  await notifyParent(branch, {
    type: "GWB_BRANCH_STATE",
    branch: closedBranch
  });
  return { branch: closedBranch };
}

async function handleFocusBranch(message) {
  const state = await readState();
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
  const state = await readState();
  return {
    branches: Object.values(state.branches).sort((a, b) => b.createdAt - a.createdAt)
  };
}

async function handleClearClosed() {
  const branches = await withStateMutation((state) => {
    for (const [id, branch] of Object.entries(state.branches)) {
      if (branch.status === "closed" || !branch.tabId) {
        delete state.branches[id];
      }
    }
    return Object.values(state.branches).sort((a, b) => b.createdAt - a.createdAt);
  });

  return {
    branches
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

async function readState() {
  await stateMutationQueue;
  return loadState();
}

function withStateMutation(mutator) {
  const run = stateMutationQueue.then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await saveState(state);
    return result;
  });
  stateMutationQueue = run.catch(() => {});
  return run;
}

async function updateBranchByTabId(tabId, patch, mutate) {
  return withStateMutation(async (state) => {
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
    return branch;
  });
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

function getActiveBranchTurn(branch) {
  const messages = ensureBranchMessages(branch);
  return messages.find((message) => message.id === branch.activeTurnId) || messages[messages.length - 1] || null;
}

function branchSnapshotContext(branch) {
  const turn = getActiveBranchTurn(branch);
  return {
    baselineOutput: turn?.baselineOutput || branch.activeTurnBaselineOutput || "",
    baselineFingerprints: turn?.baselineFingerprints || branch.activeTurnBaselineFingerprints || [],
    baselineCandidateCount: Number(turn?.baselineCandidateCount || branch.activeTurnBaselineCandidateCount || 0),
    prompt: turn?.prompt || branch.lastPrompt || "",
    currentOutput: turn?.output || branch.lastOutput || "",
    turnStartedAt: branch.activeTurnStartedAt || turn?.createdAt || 0
  };
}

function snapshotCandidateFingerprints(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.candidates)) {
    return [];
  }
  return Array.from(new Set(snapshot.candidates
    .map((candidate) => normalizeOutputText(candidate.fingerprint || fingerprintOutputText(candidate.text || "")))
    .filter(Boolean)));
}

function shouldAcceptBranchOutput(branch, output, options = {}) {
  const turn = getActiveBranchTurn(branch);
  const normalized = normalizeOutputText(output);
  if (!turn || !normalized) {
    return false;
  }

  const currentOutput = normalizeOutputText(turn.output || branch.lastOutput || "");
  if (currentOutput && normalized === currentOutput) {
    return Boolean(options.allowSame);
  }
  if (isTransientGeminiStatusText(normalized)) {
    return false;
  }

  const baselineOutput = normalizeOutputText(turn.baselineOutput || branch.activeTurnBaselineOutput || "");
  const baselineFingerprints = new Set([
    ...(Array.isArray(turn.baselineFingerprints) ? turn.baselineFingerprints : []),
    ...(Array.isArray(branch.activeTurnBaselineFingerprints) ? branch.activeTurnBaselineFingerprints : [])
  ].map(normalizeOutputText).filter(Boolean));
  if (baselineFingerprints.has(normalized) || baselineFingerprints.has(fingerprintOutputText(normalized)) || isBaselineEchoText(normalized, baselineOutput)) {
    return false;
  }

  const prompt = normalizeOutputText(turn.prompt || branch.lastPrompt || "");
  if (isLikelyWholeConversationOutput(normalized, {
    baselineOutput,
    prompt
  })) {
    return false;
  }

  return true;
}

function isBaselineEchoText(output, baseline) {
  if (!baseline) {
    return false;
  }
  if (output === baseline) {
    return true;
  }
  const shorter = output.length < baseline.length ? output : baseline;
  const longer = output.length < baseline.length ? baseline : output;
  return shorter.length > 80 && longer.includes(shorter) && shorter.length / longer.length > 0.65;
}

function isLikelyWholeConversationOutput(output, context) {
  const baseline = normalizeOutputText(context.baselineOutput || "");
  const prompt = normalizeOutputText(context.prompt || "");
  if (prompt && (output === prompt || (textIncludesNormalized(output, prompt) && output.length <= prompt.length + 30))) {
    return true;
  }
  if (baseline && textIncludesNormalized(output, baseline) && output.length > baseline.length + 80) {
    return true;
  }
  if (baseline && prompt && textIncludesNormalized(output, baseline) && textIncludesNormalized(output, prompt)) {
    return true;
  }
  return /(\b(you|gemini)\b|你说|我说|用户|assistant|model)/i.test(output) && output.length > 1800 && (
    Boolean(baseline && textIncludesNormalized(output, baseline)) ||
    Boolean(prompt && textIncludesNormalized(output, prompt))
  );
}

function textIncludesNormalized(text, needle) {
  const normalizedText = normalizeOutputText(text).toLowerCase();
  const normalizedNeedle = normalizeOutputText(needle).toLowerCase();
  return Boolean(normalizedNeedle && normalizedText.includes(normalizedNeedle));
}

function normalizeOutputText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fingerprintOutputText(value) {
  const text = normalizeOutputText(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  }
  return `${text.length}:${hash.toString(36)}`;
}

function isTransientGeminiStatusText(output) {
  const normalized = String(output || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 180 || normalized.includes("\n")) {
    return false;
  }
  return [
    /understanding (the )?(user'?s|your) input/,
    /understanding input/,
    /thinking/,
    /generating/,
    /analy[sz]ing/,
    /working on it/,
    /just a sec/,
    /loading/,
    /正在(理解|思考|生成|分析|处理)/,
    /理解.*输入/,
    /思考中/,
    /生成中/,
    /分析中/
  ].some((pattern) => pattern.test(normalized));
}

async function notifyParent(branch, payload) {
  if (!branch) {
    return;
  }

  const parentTabIds = branchParentTabIds(branch);
  if (!parentTabIds.length) {
    return;
  }

  for (const parentTabId of parentTabIds) {
    try {
      await chrome.tabs.sendMessage(parentTabId, {
        source: SOURCE,
        ...payload
      });
    } catch (error) {
      console.warn("[Gemini Web Brancher] Parent tab not reachable", error);
    }
  }
}

function findBranchByTabId(state, tabId) {
  return Object.values(state.branches).find((branch) => branch.tabId === tabId) || null;
}

function registerParentTabForConversation(state, parentTabId, parentConversationKey) {
  const branches = branchesForParentConversation(state, parentConversationKey);
  for (const branch of branches) {
    const parentTabIds = branchParentTabIds(branch);
    if (!parentTabIds.includes(parentTabId)) {
      branch.parentTabIds = [...parentTabIds, parentTabId];
      branch.parentTabId = parentTabId;
      branch.updatedAt = Date.now();
    }
  }
  return branches;
}

function branchesForParentConversation(state, parentConversationKey, options = {}) {
  return Object.values(state.branches)
    .filter((branch) => branchConversationKey(branch) === parentConversationKey)
    .filter((branch) => options.includeClosed || branch.status !== "closed")
    .sort((a, b) => a.createdAt - b.createdAt);
}

function nextBranchNumber(state, parentConversationKey) {
  const existing = branchesForParentConversation(state, parentConversationKey, {
    includeClosed: true
  })
    .map((branch) => Number(branch.branchNumber) || 0);
  return existing.length ? Math.max(...existing) + 1 : 1;
}

function branchParentTabIds(branch) {
  const ids = Array.isArray(branch.parentTabIds) ? [...branch.parentTabIds] : [];
  if (Number.isInteger(branch.parentTabId)) {
    ids.push(branch.parentTabId);
  }
  return Array.from(new Set(ids.filter(Number.isInteger)));
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
    const state = await readState();
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
