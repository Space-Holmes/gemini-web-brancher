"use strict";

(() => {
  const SOURCE = "gwb";
  const ROOT_ID = "gwb-branch-root";
  const BUTTON_ID = "gwb-branch-button";
  const RESPONSE_IDLE_MS = 3500;
  const SHARE_LINK_TIMEOUT_MS = 30000;
  const SHARE_DOM_FALLBACK_DELAY_MS = 8000;
  const SHARE_URL_PATTERN = /https:\/\/(?:g\.co\/gemini\/share\/|gemini\.google\.com\/share\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

  const state = {
    role: "unknown",
    branches: new Map(),
    branchPanels: new Map(),
    branchMeta: null,
    root: null,
    panelList: null,
    statusText: null,
    attachObserver: null,
    lastAnchor: null,
    branchOutputTimer: null,
    branchLastOutput: ""
  };

  init().catch((error) => {
    console.error("[Gemini Web Brancher]", error);
  });

  async function init() {
    const ready = await sendRuntime("GWB_CONTENT_READY", {
      url: location.href,
      title: document.title
    });

    state.role = ready.role;
    if (ready.role === "branch") {
      state.branchMeta = ready.branch;
      runBranchTab().catch(reportBranchError);
      return;
    }

    for (const branch of ready.branches || []) {
      state.branches.set(branch.id, branch);
    }
    runParentTab();
  }

  function runParentTab() {
    installRuntimeListener();
    attachParentUi();
    state.attachObserver = new MutationObserver(debounce(attachParentUi, 600));
    state.attachObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  async function runBranchTab() {
    installRuntimeListener();
    await sleep(1200);
    await prepareBranchComposer(60000);
    await sendRuntime("GWB_BRANCH_READY", {
      branchId: state.branchMeta.id,
      url: location.href
    });
    observeBranchOutput();
  }

  function installRuntimeListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.source !== SOURCE) {
        return false;
      }

      if (message.type === "GWB_BRANCH_STATE") {
        upsertBranch(message.branch);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "GWB_BRANCH_OUTPUT") {
        upsertBranch(message.branch);
        renderBranches();
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "GWB_BRANCH_SUBMIT_PROMPT") {
        submitPromptToGemini(message.prompt)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            reportBranchError(error);
            sendResponse({
              ok: false,
              error: error.message || String(error)
            });
          });
        return true;
      }

      return false;
    });
  }

  function attachParentUi() {
    if (!document.body || location.hostname !== "gemini.google.com") {
      return;
    }

    const anchor = findLatestModelResponse();
    if (!anchor) {
      return;
    }

    if (!state.root) {
      state.root = document.createElement("section");
      state.root.id = ROOT_ID;
      state.root.innerHTML = `
        <div class="gwb-toolbar">
          <button id="${BUTTON_ID}" class="gwb-branch-button" type="button">Branch</button>
          <span class="gwb-status" aria-live="polite"></span>
        </div>
        <div class="gwb-panels"></div>
      `;
      state.statusText = state.root.querySelector(".gwb-status");
      state.panelList = state.root.querySelector(".gwb-panels");
      state.root.querySelector(`#${BUTTON_ID}`).addEventListener("click", createBranchFromCurrentChat);
    }

    const insertionTarget = pickInsertionTarget(anchor);
    if (state.root.parentElement !== insertionTarget.parentElement || state.lastAnchor !== insertionTarget) {
      insertionTarget.insertAdjacentElement("afterend", state.root);
      state.lastAnchor = insertionTarget;
    }

    renderBranches();
  }

  async function createBranchFromCurrentChat(event) {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus("Creating branch...");

    try {
      const shareUrl = await extractShareUrl();
      setStatus("Opening branch worker...");
      const result = await sendRuntime("GWB_CREATE_BRANCH", {
        shareUrl,
        parentUrl: location.href,
        parentTitle: document.title
      });
      upsertBranch(result.branch);
      setStatus("Branch worker opened. It will minimize when ready.");
    } catch (error) {
      setStatus(error.message || "Could not create branch.", { sticky: true, tone: "error" });
    } finally {
      button.disabled = false;
      renderBranches();
    }
  }

  async function extractShareUrl() {
    const shareButton = await waitForElement(() => findButtonByTerms([
      "share conversation",
      "share & export",
      "share and export",
      "share",
      "share chat",
      "共享对话",
      "分享对话",
      "分享和导出",
      "分享"
    ]), 8000).catch(() => null);
    if (!shareButton) {
      throw new Error("Could not find Gemini share button.");
    }

    shareButton.click();
    await sleep(700);

    const shareConversation = findButtonByTerms([
      "share conversation",
      "share this chat",
      "share chat",
      "共享对话",
      "分享对话"
    ]);
    if (shareConversation && shareConversation !== shareButton) {
      shareConversation.click();
      await sleep(700);
    }

    const shareUrl = await waitForGeneratedShareUrl(SHARE_LINK_TIMEOUT_MS);
    if (shareUrl) {
      closeAnyDialog();
      return shareUrl;
    }

    throw new Error("Gemini did not expose a share link. Try opening the share panel once, then click Branch again.");
  }

  async function waitForGeneratedShareUrl(timeoutMs) {
    const startedAt = Date.now();
    let clickedCreate = false;
    let lastCopyClickAt = 0;
    let domFallbackUrl = "";

    while (Date.now() - startedAt < timeoutMs) {
      const surface = getShareSurface();

      const createLink = findButtonByTermsIn(surface, [
        "create public link",
        "create link",
        "generate public link",
        "generate link",
        "get link",
        "public link",
        "创建公开链接",
        "创建公共链接",
        "创建链接",
        "生成公开链接",
        "生成链接",
        "获取链接",
        "公开链接"
      ]);
      if (!clickedCreate && createLink && isEnabled(createLink)) {
        setStatus("Generating Gemini share link...");
        createLink.click();
        clickedCreate = true;
        await sleep(1000);
        continue;
      }

      const copyButton = findButtonByTermsIn(surface, [
        "copy public link",
        "copy link",
        "copy url",
        "copy",
        "复制公开链接",
        "复制公共链接",
        "复制链接",
        "复制"
      ]);
      if (copyButton && isEnabled(copyButton) && Date.now() - lastCopyClickAt > 2500) {
        setStatus("Copying Gemini share link...");
        copyButton.click();
        lastCopyClickAt = Date.now();
        await sleep(650);
        const clipboardUrl = await readClipboardShareUrl();
        if (clipboardUrl) {
          return clipboardUrl;
        }
        continue;
      }

      const shareUrl = findShareUrlInDocument(surface);
      if (shareUrl) {
        domFallbackUrl = shareUrl;
        if (Date.now() - startedAt > SHARE_DOM_FALLBACK_DELAY_MS) {
          setStatus("Using generated Gemini share link...");
          return shareUrl;
        }
      }

      await sleep(500);
    }

    return domFallbackUrl;
  }

  async function readClipboardShareUrl() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      return "";
    }

    try {
      const clipboard = await navigator.clipboard.readText();
      const match = SHARE_URL_PATTERN.exec(clipboard || "");
      return match ? match[0].replace(/[).,，。]+$/, "") : "";
    } catch {
      return "";
    }
  }

  function renderBranches() {
    if (!state.panelList) {
      return;
    }

    const branches = Array.from(state.branches.values()).sort((a, b) => a.createdAt - b.createdAt);
    const activeIds = new Set(branches.map((branch) => branch.id));

    branches.forEach((branch, index) => {
      let panel = state.branchPanels.get(branch.id);
      if (!panel) {
        panel = createBranchPanel(branch.id);
        state.branchPanels.set(branch.id, panel);
      }
      updateBranchPanel(panel, branch);
      const currentAtIndex = state.panelList.children[index];
      if (currentAtIndex !== panel) {
        state.panelList.insertBefore(panel, currentAtIndex || null);
      }
    });

    for (const [branchId, panel] of state.branchPanels.entries()) {
      if (!activeIds.has(branchId)) {
        panel.remove();
        state.branchPanels.delete(branchId);
      }
    }
  }

  function createBranchPanel(branchId) {
    const panel = document.createElement("article");
    panel.className = "gwb-panel";
    panel.dataset.branchId = branchId;
    panel.innerHTML = `
      <header class="gwb-panel-header">
        <strong data-role="title"></strong>
        <span class="gwb-pill" data-role="status"></span>
        <button class="gwb-small-button" type="button" data-action="open">Open</button>
        <button class="gwb-icon-button" type="button" data-action="close" title="Close branch">x</button>
      </header>
      <div class="gwb-output" data-role="output"></div>
      <form class="gwb-form">
        <textarea class="gwb-input" rows="2" placeholder="Message this branch"></textarea>
        <button class="gwb-send" type="submit">Send</button>
      </form>
      <div class="gwb-error" data-role="error"></div>
    `;

    panel.querySelector(".gwb-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = panel.querySelector(".gwb-input");
      const prompt = input.value.trim();
      if (!prompt) {
        return;
      }
      input.value = "";
      sendPrompt(branchId, prompt).catch((error) => {
        setStatus(error.message || "Could not send prompt.");
      });
    });
    panel.querySelector("[data-action='close']").addEventListener("click", () => {
      closeBranch(branchId).catch((error) => {
        setStatus(error.message || "Could not close branch.");
      });
    });
    panel.querySelector("[data-action='open']").addEventListener("click", () => {
      focusBranch(branchId).catch((error) => {
        setStatus(error.message || "Could not open branch.");
      });
    });

    return panel;
  }

  function updateBranchPanel(panel, branch) {
    panel.querySelector("[data-role='title']").textContent = branchLabel(branch);
    panel.querySelector("[data-role='status']").textContent = branch.workerMode === "visible-tab-fallback"
      ? `${branch.status || "opening"} / visible tab`
      : branch.status || "opening";
    panel.querySelector("[data-role='output']").textContent = branch.lastOutput || "";
    panel.querySelector("[data-role='error']").textContent = branch.status === "opening" ? "" : branch.error || "";

    const input = panel.querySelector(".gwb-input");
    const send = panel.querySelector(".gwb-send");
    const canSend = branch.status === "ready";
    input.disabled = branch.status === "closed";
    send.disabled = !canSend;
    send.textContent = canSend ? "Send" : "Wait";
  }

  async function sendPrompt(branchId, prompt) {
    setStatus("Sending...");
    const result = await sendRuntime("GWB_SEND_PROMPT", {
      branchId,
      prompt
    });
    upsertBranch(result.branch);
    setStatus("Sent.");
    renderBranches();
  }

  async function closeBranch(branchId) {
    const result = await sendRuntime("GWB_CLOSE_BRANCH", {
      branchId
    });
    upsertBranch(result.branch);
    setStatus("Branch closed.");
    renderBranches();
  }

  async function focusBranch(branchId) {
    await sendRuntime("GWB_FOCUS_BRANCH", {
      branchId
    });
  }

  function upsertBranch(branch) {
    if (!branch || !branch.id) {
      return;
    }
    state.branches.set(branch.id, branch);
    renderBranches();
  }

  async function prepareBranchComposer(timeoutMs) {
    const startedAt = Date.now();
    let lastClickAt = 0;
    let lastClickedText = "";

    while (Date.now() - startedAt < timeoutMs) {
      const composer = findComposer();
      if (composer) {
        return composer;
      }

      const entry = findContinueEntry();
      if (entry && Date.now() - lastClickAt > 3500) {
        lastClickAt = Date.now();
        lastClickedText = getElementLabel(entry).slice(0, 120);
        activateElement(entry);
        await sleep(3500);
        continue;
      }

      await sleep(700);
    }

    throw new Error(buildComposerTimeoutMessage(lastClickedText));
  }

  async function submitPromptToGemini(prompt) {
    const editor = await waitForComposer(45000);
    focusAndSetText(editor, prompt);
    await sleep(250);

    const sendButton = findSendButton(editor);
    if (!sendButton) {
      throw new Error("Could not find Gemini send button.");
    }

    sendButton.click();
    state.branchLastOutput = "";
    await sleep(1000);
    scanBranchOutput();
  }

  function observeBranchOutput() {
    const observer = new MutationObserver(debounce(scanBranchOutput, 450));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    scanBranchOutput();
  }

  function scanBranchOutput() {
    if (state.role !== "branch") {
      return;
    }

    const latest = findLatestModelResponse();
    const output = latest ? normalizeText(latest.innerText || latest.textContent || "") : "";
    if (!output || output === state.branchLastOutput) {
      return;
    }

    state.branchLastOutput = output;
    sendRuntime("GWB_BRANCH_OUTPUT", {
      branchId: state.branchMeta && state.branchMeta.id,
      output,
      url: location.href
    }).catch(console.error);

    clearTimeout(state.branchOutputTimer);
    state.branchOutputTimer = setTimeout(() => {
      sendRuntime("GWB_BRANCH_DONE", {
        branchId: state.branchMeta && state.branchMeta.id,
        output: state.branchLastOutput,
        url: location.href
      }).catch(console.error);
    }, RESPONSE_IDLE_MS);
  }

  async function reportBranchError(error) {
    const message = error && error.message ? error.message : String(error);
    console.error("[Gemini Web Brancher]", message);
    await sendRuntime("GWB_BRANCH_ERROR", {
      branchId: state.branchMeta && state.branchMeta.id,
      error: message,
      url: location.href
    }).catch(console.error);
  }

  function findLatestModelResponse() {
    const selectors = [
      "model-response",
      "[data-test-id*='model-response' i]",
      "[data-testid*='model-response' i]",
      "[data-test-id*='response' i]",
      "[data-testid*='response' i]",
      "[class*='model-response' i]",
      "message-content",
      ".markdown"
    ];

    const candidates = uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
      .filter((element) => element.id !== ROOT_ID && !element.closest(`#${ROOT_ID}`))
      .filter(isVisible)
      .filter((element) => normalizeText(element.innerText || element.textContent || "").length > 24);

    return candidates[candidates.length - 1] || null;
  }

  function pickInsertionTarget(anchor) {
    return anchor.closest("model-response, [data-test-id*='response' i], [data-testid*='response' i], .model-response, article") || anchor;
  }

  function findShareUrlInDocument(root = document) {
    const candidates = [];
    for (const element of root.querySelectorAll("a[href], input, textarea")) {
      if (element instanceof HTMLAnchorElement) {
        candidates.push(element.href || "");
      } else {
        candidates.push(element.value || "");
      }
    }

    const dialog = root === document ? getShareSurface() : root;
    if (dialog) {
      candidates.push(dialog.innerText || dialog.textContent || "");
    }
    if (root === document) {
      candidates.push(document.body.innerText || "");
    }

    for (const value of candidates) {
      const match = SHARE_URL_PATTERN.exec(value);
      if (match) {
        return match[0].replace(/[).,，。]+$/, "");
      }
    }
    return "";
  }

  function findButtonByTerms(terms) {
    return findButtonByTermsIn(document, terms);
  }

  function findButtonByTermsIn(root, terms) {
    const normalizedTerms = terms.map((term) => term.toLowerCase());
    const candidates = Array.from(root.querySelectorAll("button, [role='button'], a, div[aria-label], span[aria-label]"))
      .filter(isVisible)
      .filter((element) => !element.closest(`#${ROOT_ID}`));

    return candidates.find((element) => {
      const text = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-tooltip"),
        element.innerText,
        element.textContent
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase();
      return normalizedTerms.some((term) => text.includes(term));
    }) || null;
  }

  function getShareSurface() {
    return document.querySelector("[role='dialog'], mat-dialog-container, .cdk-overlay-pane, .cdk-overlay-container") || document;
  }

  function findContinueEntry() {
    const terms = [
      "continue this chat",
      "continue this conversation",
      "continue in gemini",
      "continue with gemini",
      "continue in the gemini app",
      "continue chat",
      "continue conversation",
      "continue",
      "open in gemini",
      "open gemini",
      "try gemini",
      "use gemini",
      "start chatting",
      "start chat",
      "start a chat",
      "chat with gemini",
      "ask gemini",
      "gemini app",
      "继续此聊天",
      "继续这个聊天",
      "继续聊天",
      "继续对话",
      "在 gemini 中继续",
      "打开 gemini",
      "使用 gemini",
      "试用 gemini",
      "开始聊天",
      "开始对话",
      "与 gemini 聊天"
    ];
    const normalizedTerms = terms.map((term) => term.toLowerCase());
    const candidates = Array.from(document.querySelectorAll("a[href], button, [role='button'], div[aria-label], span[aria-label]"))
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => isVisible(element) || element instanceof HTMLAnchorElement)
      .filter(isEnabled);

    const textMatch = candidates.find((element) => {
      const label = getElementLabel(element).toLowerCase();
      return normalizedTerms.some((term) => label.includes(term));
    });
    if (textMatch) {
      return textMatch;
    }

    return candidates.find((element) => {
      const href = element instanceof HTMLAnchorElement ? element.href : "";
      if (!href) {
        return false;
      }
      try {
        const url = new URL(href);
        return url.hostname === "gemini.google.com" && url.pathname.startsWith("/app") && !url.pathname.startsWith("/share");
      } catch {
        return false;
      }
    }) || null;
  }

  function activateElement(element) {
    if (element instanceof HTMLAnchorElement && element.href) {
      element.click();
      return;
    }
    element.click();
  }

  function getElementLabel(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-tooltip"),
      element instanceof HTMLAnchorElement ? element.href : "",
      element.innerText,
      element.textContent
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildComposerTimeoutMessage(lastClickedText) {
    const candidates = Array.from(document.querySelectorAll("a[href], button, [role='button']"))
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => isVisible(element) || element instanceof HTMLAnchorElement)
      .map(getElementLabel)
      .filter(Boolean)
      .slice(0, 8)
      .join(" | ");
    return [
      "Timed out waiting for Gemini composer.",
      `URL: ${location.href}`,
      `Title: ${document.title || "(none)"}`,
      lastClickedText ? `Last clicked: ${lastClickedText}` : "",
      candidates ? `Visible actions: ${candidates}` : "Visible actions: none detected"
    ].filter(Boolean).join("\n");
  }

  async function waitForComposer(timeoutMs) {
    return waitForElement(findComposer, timeoutMs);
  }

  function findComposer() {
    const selectors = [
      "textarea",
      "[contenteditable='true']",
      "[contenteditable='plaintext-only']",
      "[contenteditable]:not([contenteditable='false'])",
      "[role='textbox']",
      "div.ql-editor",
      "rich-textarea [contenteditable]",
      "rich-textarea textarea"
    ];

    const editors = uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
      .filter(isVisible)
      .filter((element) => !element.matches("[readonly], [aria-readonly='true']"))
      .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
      .filter((element) => !element.closest(`#${ROOT_ID}`));

    return editors[editors.length - 1] || null;
  }

  function focusAndSetText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editor.value = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    document.getSelection().selectAllChildren(editor);
    const inserted = document.execCommand && document.execCommand("insertText", false, text);
    if (!inserted) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    }
  }

  function findSendButton(editor) {
    const localRoot = editor.closest("form, footer, main, .input-area, .prompt-input-container") || document;
    const terms = [
      "send",
      "submit",
      "发送",
      "提交"
    ];

    const local = findEnabledButtonByTerms(localRoot, terms);
    if (local) {
      return local;
    }

    return findEnabledButtonByTerms(document, terms) || findIconSendButton(document);
  }

  function findEnabledButtonByTerms(root, terms) {
    const normalizedTerms = terms.map((term) => term.toLowerCase());
    return Array.from(root.querySelectorAll("button, [role='button']"))
      .filter(isVisible)
      .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
      .reverse()
      .find((element) => {
        const text = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.innerText,
          element.textContent
        ].filter(Boolean).join(" ").toLowerCase();
        return normalizedTerms.some((term) => text.includes(term));
      }) || null;
  }

  function isEnabled(element) {
    return Boolean(
      element &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.hasAttribute("disabled")
    );
  }

  function findIconSendButton(root) {
    return Array.from(root.querySelectorAll("button, [role='button']"))
      .filter(isVisible)
      .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
      .reverse()
      .find((element) => /send|arrow_upward|north|发送/i.test(element.innerText || element.textContent || "")) || null;
  }

  function closeAnyDialog() {
    const closeButton = findButtonByTerms([
      "close",
      "dismiss",
      "关闭",
      "取消"
    ]);
    if (closeButton) {
      closeButton.click();
      return;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true
    }));
  }

  async function sendRuntime(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({
      source: SOURCE,
      type,
      ...payload
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Extension message failed.");
    }
    return response.data || {};
  }

  function setStatus(text, options = {}) {
    if (!state.statusText) {
      return;
    }
    state.statusText.classList.toggle("gwb-status-error", options.tone === "error");
    state.statusText.textContent = text;
    if (text && !options.sticky) {
      clearTimeout(setStatus.timer);
      setStatus.timer = setTimeout(() => {
        if (state.statusText) {
          state.statusText.textContent = "";
          state.statusText.classList.remove("gwb-status-error");
        }
      }, 4500);
    }
  }

  function branchLabel(branch) {
    const index = Array.from(state.branches.keys()).indexOf(branch.id) + 1;
    return `Branch ${index}`;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForElement(finder, timeoutMs) {
    const existing = finder();
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const observer = new MutationObserver(() => {
        const element = finder();
        if (element) {
          observer.disconnect();
          resolve(element);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          observer.disconnect();
          reject(new Error("Timed out waiting for Gemini UI."));
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for Gemini UI."));
      }, timeoutMs);
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
