"use strict";

(() => {
  const SOURCE = "gwb";
  const ROOT_CLASS = "gwb-branch-root";
  const ROOT_ID = `gwb-branch-root-${chrome.runtime.id}`;
  const BUTTON_ID = `gwb-branch-button-${chrome.runtime.id}`;
  const RESPONSE_IDLE_MS = 15000;
  const RESPONSE_GENERATING_GRACE_MS = 60000;
  const BRANCH_SUPERVISOR_INTERVAL_MS = 1500;
  const BRANCH_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
  const SHARE_LINK_TIMEOUT_MS = 30000;
  const SHARE_DOM_FALLBACK_DELAY_MS = 8000;
  const SHARE_URL_PATTERN = /(?:https?:\/\/)?(?:g\.co\/gemini\/share\/|gemini\.google\.com\/share\/|gemini\.google\.com\/app\/[A-Za-z0-9_-]+\/share\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i;

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
    parentConversationKey: "",
    parentUrl: "",
    branchListRequestToken: 0,
    branchSupervisorPoller: null,
    branchOutputTimer: null,
    branchOutputPoller: null,
    branchLastOutput: "",
    branchLastHtml: "",
    branchBaselineOutput: "",
    branchCurrentTurnId: "",
    branchResponseStartedAt: 0,
    branchLastRealOutputAt: 0,
    branchStreaming: false
  };

  init().catch((error) => {
    console.error("[Gemini Web Brancher]", error);
  });

  async function init() {
    state.parentConversationKey = getParentConversationKey(location.href);
    state.parentUrl = location.href;

    const ready = await resolveInitialRole();

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

  async function resolveInitialRole() {
    let ready = await announceContentReady();
    if (ready.role === "branch" || !isBranchWorkerCandidateUrl(location.href)) {
      return ready;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      ready = await announceContentReady();
      if (ready.role === "branch") {
        return ready;
      }
    }
    return ready;
  }

  function announceContentReady() {
    return sendRuntime("GWB_CONTENT_READY", {
      url: location.href,
      title: document.title,
      parentConversationKey: state.parentConversationKey
    });
  }

  function isBranchWorkerCandidateUrl(url) {
    return isGeminiSharePageUrl(url) || isGeminiAppSharePageUrl(url);
  }

  function runParentTab() {
    installRuntimeListener();
    installParentLocationWatcher();
    startBranchSupervisor();
    attachParentUi();
    state.attachObserver = new MutationObserver(debounce(attachParentUi, 600));
    state.attachObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function installParentLocationWatcher() {
    const refresh = debounce(() => {
      syncParentContextIfNeeded();
      attachParentUi();
    }, 120);

    try {
      for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        if (original && !original.__gwbWrapped) {
          const wrapped = function (...args) {
            const result = original.apply(this, args);
            refresh();
            return result;
          };
          wrapped.__gwbWrapped = true;
          history[method] = wrapped;
        }
      }
    } catch (error) {
      console.warn("[Gemini Web Brancher] Could not watch Gemini history API", error);
    }

    window.addEventListener("popstate", refresh);
    window.addEventListener("hashchange", refresh);
  }

  function syncParentContextIfNeeded() {
    const nextUrl = location.href;
    const nextKey = getParentConversationKey(nextUrl);
    if (nextKey === state.parentConversationKey && nextUrl === state.parentUrl) {
      return;
    }

    state.parentConversationKey = nextKey;
    state.parentUrl = nextUrl;
    state.lastAnchor = null;
    renderBranches();
    requestBranchesForCurrentConversation().catch((error) => {
      console.warn("[Gemini Web Brancher] Could not refresh branches for conversation", error);
    });
  }

  async function requestBranchesForCurrentConversation() {
    const token = ++state.branchListRequestToken;
    const result = await sendRuntime("GWB_LIST_BRANCHES", {
      url: location.href,
      parentConversationKey: state.parentConversationKey
    });
    if (token !== state.branchListRequestToken) {
      return;
    }
    for (const branch of result.branches || []) {
      state.branches.set(branch.id, branch);
    }
    renderBranches();
  }

  function startBranchSupervisor() {
    if (state.branchSupervisorPoller) {
      return;
    }
    state.branchSupervisorPoller = setInterval(() => {
      pollActiveBranchWorkers().catch((error) => {
        console.warn("[Gemini Web Brancher] Branch supervisor poll failed", error);
      });
    }, BRANCH_SUPERVISOR_INTERVAL_MS);
  }

  async function pollActiveBranchWorkers() {
    if (state.role !== "parent") {
      return;
    }
    const branchIds = currentConversationBranches()
      .filter((branch) => branch.status === "sending" || branch.status === "streaming")
      .map((branch) => branch.id);
    if (!branchIds.length) {
      return;
    }
    await sendRuntime("GWB_POLL_BRANCH_OUTPUT", {
      branchIds
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
        enterBranchMode(message.branch || {
          id: message.branchId
        });
        submitPromptToGemini(message.prompt, message.turnId)
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

      if (message.type === "GWB_BRANCH_POLL_OUTPUT") {
        enterBranchMode(message.branch || {
          id: message.branchId
        });
        scanBranchOutput();
        sendResponse({
          ok: true,
          streaming: state.branchStreaming
        });
        return false;
      }

      return false;
    });
  }

  function enterBranchMode(branch) {
    if (branch && branch.id) {
      state.branchMeta = branch;
    }
    if (state.role === "branch") {
      return;
    }

    state.role = "branch";
    if (state.attachObserver) {
      state.attachObserver.disconnect();
      state.attachObserver = null;
    }
    detachParentUi();
    state.branches.clear();
  }

  function attachParentUi() {
    if (!document.body || location.hostname !== "gemini.google.com") {
      return;
    }

    syncParentContextIfNeeded();

    const anchor = findLatestModelResponse();
    if (!anchor) {
      detachParentUi();
      return;
    }

    if (!state.root) {
      state.root = document.createElement("section");
      state.root.id = ROOT_ID;
      state.root.className = ROOT_CLASS;
      state.root.dataset.extensionId = chrome.runtime.id;
      state.root.innerHTML = `
        <div class="gwb-toolbar">
          <button id="${BUTTON_ID}" class="gwb-branch-button" type="button">Branch</button>
          <button class="gwb-small-button" type="button" data-action="mark-trunk">Mark Trunk</button>
          <span class="gwb-status" aria-live="polite"></span>
        </div>
        <div class="gwb-panels"></div>
      `;
      state.statusText = state.root.querySelector(".gwb-status");
      state.panelList = state.root.querySelector(".gwb-panels");
      state.root.querySelector(`#${BUTTON_ID}`).addEventListener("click", createBranchFromCurrentChat);
      state.root.querySelector("[data-action='mark-trunk']").addEventListener("click", () => {
        markCurrentConversationAsTrunk().catch((error) => {
          setStatus(error.message || "Could not mark trunk.", { sticky: true, tone: "error" });
        });
      });
    }

    const insertionTarget = pickInsertionTarget(anchor);
    if (state.root.parentElement !== insertionTarget.parentElement || state.lastAnchor !== insertionTarget) {
      insertionTarget.insertAdjacentElement("afterend", state.root);
      state.lastAnchor = insertionTarget;
    }

    renderBranches();
  }

  function detachParentUi() {
    if (state.root && state.root.isConnected) {
      state.root.remove();
    }
    state.lastAnchor = null;
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
        parentTitle: document.title,
        parentConversationKey: state.parentConversationKey
      });
      upsertBranch(result.branch);
      setStatus("Branch worker opened.");
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
      await closeShareDialog();
      return shareUrl;
    }

    const manualShareUrl = promptForVisibleShareUrl();
    if (manualShareUrl) {
      await closeShareDialog();
      return manualShareUrl;
    }

    throw new Error("Gemini share link was visible but could not be captured. Paste the visible share link when prompted, or click Branch again after copying it.");
  }

  async function waitForGeneratedShareUrl(timeoutMs) {
    const startedAt = Date.now();
    let clickedCreate = false;
    let lastCopyClickAt = 0;
    let domFallbackUrl = "";

    while (Date.now() - startedAt < timeoutMs) {
      const surface = getShareSurface();

      const createTerms = [
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
      ];
      const createLink = findButtonByTermsIn(surface, createTerms) || findButtonByTermsIn(document, createTerms);
      if (!clickedCreate && createLink && isEnabled(createLink)) {
        setStatus("Generating Gemini share link...");
        createLink.click();
        clickedCreate = true;
        await sleep(1000);
        continue;
      }

      const copyTerms = [
        "copy public link",
        "copy link",
        "copy url",
        "copy",
        "复制公开链接",
        "复制公共链接",
        "复制链接",
        "复制"
      ];
      const copyButton = findButtonByTermsIn(surface, copyTerms) || findButtonByTermsIn(document, copyTerms);
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

      const shareUrl = findShareUrlInDocument(surface) || findShareUrlInDocument(document);
      if (shareUrl) {
        domFallbackUrl = shareUrl;
        if (lastCopyClickAt || Date.now() - startedAt > SHARE_DOM_FALLBACK_DELAY_MS) {
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
      return normalizeShareUrlMatch(clipboard || "");
    } catch {
      return "";
    }
  }

  function promptForVisibleShareUrl() {
    const pasted = window.prompt("Gemini share link is visible but could not be captured automatically. Paste the visible share link here:");
    return normalizeShareUrlMatch(pasted || "");
  }

  async function closeShareDialog() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const surface = findShareDialogSurface();
      if (!surface) {
        return;
      }
      const closeButton = findDialogCloseButton(surface) || findDialogCloseButton(document);
      if (closeButton && isEnabled(closeButton)) {
        activateElement(closeButton);
      }
      dispatchEscape();
      await sleep(300);
      if (!findShareDialogSurface()) {
        return;
      }
    }
  }

  function findDialogCloseButton(root) {
    const candidates = queryAllDeep(root, "button, [role='button'], [aria-label], [title]")
      .filter(isVisible)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .map((element) => ({
        element,
        score: dialogCloseButtonScore(element)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function dialogCloseButtonScore(element) {
    const label = getElementLabel(element).toLowerCase();
    const visibleText = normalizeText(element.innerText || element.textContent || "").toLowerCase();
    let score = 0;

    if (/(^|\s)(close|dismiss|done|cancel|关闭|完成|取消)(\s|$)/i.test(label)) {
      score += 30;
    }
    if (/^(close|cancel|关闭|取消|done|完成)$/i.test(visibleText)) {
      score += 25;
    }
    if (/close|关闭/.test(label)) {
      score += 20;
    }
    if (/close|关闭/.test(visibleText)) {
      score += 15;
    }
    if (/copy|复制|create|生成|公开链接|public link|share|分享/.test(label) && !/close|关闭|cancel|取消|done|完成/.test(label)) {
      score -= 60;
    }

    return score;
  }

  function findShareDialogSurface() {
    return queryAllDeep(document, "[role='dialog'], mat-dialog-container, .cdk-overlay-pane")
      .filter(isVisible)
      .find((surface) => /share|copy link|public link|分享|复制链接|公开链接|创建链接|生成链接/i.test(getElementVisibleLabel(surface))) || null;
  }

  function renderBranches() {
    if (!state.panelList) {
      return;
    }

    const branches = currentConversationBranches();
    state.panelList.dataset.count = String(Math.min(branches.length, 3));
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
    renderBranchMessages(panel.querySelector("[data-role='output']"), branch);
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
    if (branch.status === "closed") {
      state.branches.delete(branch.id);
      renderBranches();
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

  async function markCurrentConversationAsTrunk(options = {}) {
    if (!options.silent) {
      setStatus("Marking trunk...");
    }
    const renamed = await renameCurrentConversationWithSuffix("--TRUNK", options);
    if (!options.silent) {
      setStatus(renamed ? "Trunk marked." : "Rename controls not found.", {
        sticky: !renamed,
        tone: renamed ? "" : "error"
      });
    }
    return renamed;
  }

  async function renameCurrentConversationWithSuffix(suffix, options = {}) {
    if (isCurrentConversationMarkedTrunk()) {
      return true;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await revealConversationHistory();
      await sleep(attempt === 0 ? 300 : 800);

      const renameAction = await openCurrentConversationActionMenu();
      if (!renameAction) {
        continue;
      }

      activateElement(renameAction);
      const editor = await waitForElement(() => findRenameEditor(), 5000).catch(() => null);
      if (!editor) {
        closeAnyDialog();
        continue;
      }

      const currentTitle = getEditorText(editor) || detectConversationTitle() || cleanConversationTitle(document.title) || "Gemini";
      const desiredTitle = appendTitleSuffix(currentTitle, suffix);
      if (normalizeText(getEditorText(editor)) === desiredTitle) {
        closeAnyDialog();
        return true;
      }

      await focusAndSetText(editor, desiredTitle);
      await waitForElement(() => getEditorText(editor) === desiredTitle ? editor : null, 1200).catch(() => null);
      await sleep(250);

      const surface = getTopDialogSurface() || document;
      const confirm = await waitForElement(() => findRenameConfirmButton(surface), 2500).catch(() => null);
      if (confirm) {
        activateElement(confirm);
      } else {
        pressEnter(editor);
      }
      await sleep(900);
      return true;
    }

    return false;
  }

  async function openCurrentConversationActionMenu() {
    const opener = await waitForRenameMenuOpener(6000);
    if (opener) {
      activateElement(opener);
      const renameAction = await waitForElement(() => findRenameAction(), 5000).catch(() => null);
      if (renameAction) {
        return renameAction;
      }
      closeAnyDialog();
      await sleep(250);
    }

    for (const container of findCurrentConversationContainers()) {
      revealElementControls(container);
      await sleep(180);
      const menuButton = findConversationMenuButton(container);
      if (menuButton) {
        activateElement(menuButton);
        const renameAction = await waitForElement(() => findRenameAction(), 2200).catch(() => null);
        if (renameAction) {
          return renameAction;
        }
        closeAnyDialog();
        await sleep(250);
      }

      dispatchContextMenu(container);
      const renameAction = await waitForElement(() => findRenameAction(), 1800).catch(() => null);
      if (renameAction) {
        return renameAction;
      }
      closeAnyDialog();
      await sleep(250);
    }

    return null;
  }

  async function waitForRenameMenuOpener(timeoutMs) {
    const startedAt = Date.now();
    let triedHistoryReveal = false;
    while (Date.now() - startedAt < timeoutMs) {
      const opener = await findRenameMenuOpener();
      if (opener) {
        return opener;
      }

      if (!triedHistoryReveal) {
        triedHistoryReveal = true;
        await revealConversationHistory();
      }
      await sleep(700);
    }
    return null;
  }

  async function findRenameMenuOpener() {
    const containers = findCurrentConversationContainers();

    for (const container of containers) {
      revealElementControls(container);
      await sleep(150);
      const button = findConversationMenuButton(container);
      if (button) {
        return button;
      }
    }

    const titleMenu = findTitleMenuButton();
    if (titleMenu) {
      return titleMenu;
    }

    return null;
  }

  function findCurrentConversationContainers() {
    const containers = [];
    const currentPath = getCurrentAppPath();

    if (currentPath) {
      for (const anchor of queryAllDeep(document, "a[href*='gemini.google.com/app'], a[href^='/app'], a[href*='/app/']")) {
        if (!(anchor instanceof HTMLAnchorElement) || !isVisible(anchor) || anchor.closest(`#${ROOT_ID}`)) {
          continue;
        }
        if (getAnchorPath(anchor) !== currentPath) {
          continue;
        }
        containers.push(anchor.closest("[role='listitem'], li, mat-list-item, [data-test-id], [data-testid], .conversation, .chat, .history") || anchor.parentElement || anchor);
      }
    }

    for (const selected of queryAllDeep(document, "[aria-current='page'], [aria-selected='true'], [data-active='true'], [class*='selected' i], [class*='active' i]")) {
      if (!isVisible(selected) || selected.closest(`#${ROOT_ID}`) || isAccountOrChromeEntry(selected)) {
        continue;
      }
      const label = getElementVisibleLabel(selected);
      if (!isLikelyConversationTitle(label)) {
        continue;
      }
      containers.push(selected.closest("[role='listitem'], li, mat-list-item, [data-test-id], [data-testid], .conversation, .chat, .history") || selected);
    }

    return uniqueElements(containers)
      .filter(Boolean)
      .filter((element) => element instanceof Element)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .slice(0, 8);
  }

  function findConversationMenuButton(container) {
    return conversationMenuSearchRoots(container)
      .flatMap((root) => queryAllDeep(root, "button, [role='button']"))
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => !isAccountOrChromeEntry(element))
      .map((element) => ({
        element,
        score: conversationMenuButtonScore(element)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function conversationMenuSearchRoots(container) {
    const roots = [container];
    let current = container.parentElement;
    while (current && roots.length < 5) {
      roots.push(current);
      if (current.matches("aside, nav, [role='navigation'], main, body")) {
        break;
      }
      current = current.parentElement;
    }
    return uniqueElements(roots);
  }

  function conversationMenuButtonScore(element) {
    const label = getElementLabel(element).toLowerCase();
    const text = normalizeText(element.innerText || element.textContent || "").toLowerCase();
    const rect = element.getBoundingClientRect();
    let score = 0;

    if (/more|options|menu|overflow|更多|选项|菜单|操作/.test(label)) {
      score += 40;
    }
    if (/more_vert|more_horiz|⋮|…|\.\.\./.test(text)) {
      score += 28;
    }
    if (element.getAttribute("aria-haspopup") === "menu" || element.getAttribute("aria-expanded") !== null) {
      score += 20;
    }
    if (rect.width <= 56 && rect.height <= 56) {
      score += 8;
    }
    if (/new chat|发起新对话|新对话|account|账号|settings|设置/.test(label)) {
      score -= 80;
    }

    return score;
  }

  function findTitleMenuButton() {
    const title = detectConversationTitle();
    return queryAllDeep(document, "button, [role='button']")
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => !isAccountOrChromeEntry(element))
      .map((element) => ({
        element,
        label: getElementVisibleLabel(element),
        score: titleMenuButtonScore(element, title)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function titleMenuButtonScore(element, title) {
    const label = getElementVisibleLabel(element).toLowerCase();
    let score = 0;
    if (title && label.includes(title.toLowerCase())) {
      score += 30;
    }
    if (/more|options|menu|rename|title|conversation|更多|选项|菜单|重命名|标题|对话/.test(label)) {
      score += 20;
    }
    if (element.getAttribute("aria-haspopup") === "menu" || element.getAttribute("aria-expanded") !== null) {
      score += 16;
    }
    if (/gemini|pro|发起新对话|new chat|google 账号|google account/.test(label) && (!title || !label.includes(title.toLowerCase()))) {
      score -= 60;
    }
    return score;
  }

  function findRenameAction() {
    return findActionByTerms(getTopDialogSurface() || document, [
      "rename",
      "rename chat",
      "rename conversation",
      "edit title",
      "edit name",
      "change title",
      "重命名",
      "重命名聊天",
      "重命名对话",
      "修改名称",
      "编辑名称",
      "更改名称",
      "修改标题",
      "编辑标题"
    ]);
  }

  function findRenameEditor() {
    const surface = getTopDialogSurface() || document;
    const candidates = queryAllDeep(surface, "input:not([type='hidden']), textarea, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']")
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .map((element) => ({
        element,
        score: renameEditorScore(element)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.element || null;
  }

  function renameEditorScore(element) {
    const label = getElementLabel(element).toLowerCase();
    let score = 1;
    if (/rename|title|name|chat|conversation|重命名|标题|名称|对话/.test(label)) {
      score += 35;
    }
    if (element instanceof HTMLInputElement) {
      score += 15;
    }
    if (element === document.activeElement) {
      score += 20;
    }
    if (element.closest("[role='dialog'], mat-dialog-container, .cdk-overlay-pane")) {
      score += 18;
    }
    if (/prompt|message|send|输入提示|发送/.test(label)) {
      score -= 80;
    }
    return score;
  }

  function findRenameConfirmButton(surface) {
    const terms = [
      "rename",
      "save",
      "done",
      "ok",
      "confirm",
      "重命名",
      "保存",
      "完成",
      "确定",
      "确认"
    ];
    const cancelTerms = /cancel|close|dismiss|取消|关闭/;
    return queryAllDeep(surface, "button, [role='button']")
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .find((element) => {
        const label = getElementLabel(element).toLowerCase();
        return terms.some((term) => label.includes(term)) && !cancelTerms.test(label);
      }) || null;
  }

  function findActionByTerms(root, terms) {
    const normalizedTerms = terms.map((term) => term.toLowerCase());
    return queryAllDeep(root, "button, [role='button'], [role='menuitem'], [role='option'], mat-option, a, div[aria-label], span[aria-label]")
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .find((element) => {
        const label = getElementLabel(element).toLowerCase();
        return normalizedTerms.some((term) => label.includes(term));
      }) || null;
  }

  async function revealConversationHistory() {
    const opener = findActionByTerms(document, [
      "open sidebar",
      "show sidebar",
      "open navigation",
      "main menu",
      "history",
      "打开侧边栏",
      "显示侧边栏",
      "打开导航",
      "主菜单",
      "历史记录"
    ]);
    if (opener && isEnabled(opener) && !isAccountOrChromeEntry(opener)) {
      activateElement(opener);
    }
  }

  function revealElementControls(element) {
    element.scrollIntoView({
      block: "center",
      inline: "nearest"
    });
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    if (element instanceof HTMLElement) {
      element.focus({ preventScroll: true });
    }
  }

  function getTopDialogSurface() {
    const surfaces = queryAllDeep(document, "[role='dialog'], mat-dialog-container, .cdk-overlay-pane, .cdk-overlay-container")
      .filter(isVisible);
    return surfaces[surfaces.length - 1] || null;
  }

  function detectConversationTitle() {
    const candidates = findCurrentConversationContainers()
      .map(getElementVisibleLabel)
      .map(cleanConversationTitle)
      .filter(isLikelyConversationTitle);

    candidates.push(cleanConversationTitle(document.title));
    candidates.push(cleanConversationTitle(state.branchMeta && state.branchMeta.parentTitle));

    return candidates.find(isLikelyConversationTitle) || "";
  }

  function getCurrentAppPath() {
    if (location.hostname !== "gemini.google.com" || !location.pathname.startsWith("/app")) {
      return "";
    }
    return location.pathname.replace(/\/$/, "");
  }

  function getAnchorPath(anchor) {
    try {
      return new URL(anchor.href, location.href).pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function getEditorText(editor) {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return normalizeText(editor.value);
    }
    return normalizeText(editor.innerText || editor.textContent || "");
  }

  function cleanConversationTitle(title) {
    return normalizeText(title)
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/^gemini\s*[-–—]\s*/i, "")
      .replace(/\s*(?:--+|[-–—]+)\s*gemini\s*$/i, "")
      .replace(/\s+https?:\/\/\S+$/i, "")
      .trim();
  }

  function appendTitleSuffix(title, suffix) {
    const cleaned = cleanConversationTitle(title);
    const base = cleaned
      .replace(/\s*(?:--\s*gemini\s*)?--TRUNK\s*$/i, "")
      .replace(/\s*--\s*gemini\s*$/i, "")
      .trim();
    return `${base || "Gemini"}${suffix}`;
  }

  function isCurrentConversationMarkedTrunk() {
    const titles = [
      document.title,
      ...findCurrentConversationContainers().map(getElementVisibleLabel)
    ].map(cleanConversationTitle);

    return titles.some((title) => /\s*--TRUNK\s*$/i.test(title));
  }

  function isLikelyConversationTitle(title) {
    const cleaned = cleanConversationTitle(title);
    if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
      return false;
    }
    return !/^(gemini|pro|new chat|发起新对话|新对话|google 账号|google account|history|历史记录)$/i.test(cleaned);
  }

  function pressEnter(element) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      element.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        bubbles: true
      }));
    }
  }

  async function submitPromptToGemini(prompt, turnId) {
    closeAnyDialog();
    await sleep(150);

    const editor = await waitForComposer(45000);
    const before = findLatestModelResponse();
    state.branchBaselineOutput = before ? normalizeText(before.innerText || before.textContent || "") : "";
    state.branchCurrentTurnId = turnId || "";
    state.branchResponseStartedAt = Date.now();
    state.branchLastRealOutputAt = 0;
    state.branchStreaming = true;
    await focusAndSetText(editor, prompt);
    await sleep(250);

    const sendButton = findSendButton(editor);
    if (!sendButton) {
      throw new Error("Could not find Gemini send button.");
    }

    activateElement(sendButton);
    state.branchLastOutput = "";
    state.branchLastHtml = "";
    startBranchOutputPolling();
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
  }

  function startBranchOutputPolling() {
    stopBranchOutputPolling();
    state.branchOutputPoller = setInterval(scanBranchOutput, 1000);
  }

  function stopBranchOutputPolling() {
    if (state.branchOutputPoller) {
      clearInterval(state.branchOutputPoller);
      state.branchOutputPoller = null;
    }
    clearTimeout(state.branchOutputTimer);
    state.branchOutputTimer = null;
  }

  function scanBranchOutput() {
    if (state.role !== "branch") {
      return;
    }
    if (!state.branchStreaming) {
      return;
    }
    if (state.branchResponseStartedAt && Date.now() - state.branchResponseStartedAt > BRANCH_RESPONSE_TIMEOUT_MS && !state.branchLastOutput) {
      state.branchStreaming = false;
      stopBranchOutputPolling();
      reportBranchError(new Error("Timed out waiting for Gemini response."));
      return;
    }

    const latest = findLatestModelResponse();
    const output = latest ? normalizeText(latest.innerText || latest.textContent || "") : "";
    if (!output || output === state.branchBaselineOutput || output === state.branchLastOutput) {
      return;
    }
    if (isTransientGeminiStatus(output, latest)) {
      return;
    }

    state.branchLastOutput = output;
    state.branchLastHtml = latest ? sanitizeHtml(latest.innerHTML || "") : "";
    state.branchLastRealOutputAt = Date.now();
    sendRuntime("GWB_BRANCH_OUTPUT", {
      branchId: state.branchMeta && state.branchMeta.id,
      turnId: state.branchCurrentTurnId,
      output,
      html: state.branchLastHtml,
      url: location.href
    }).catch(console.error);

    scheduleBranchDoneCheck();
  }

  function scheduleBranchDoneCheck() {
    clearTimeout(state.branchOutputTimer);
    state.branchOutputTimer = setTimeout(() => {
      finishBranchIfIdle();
    }, RESPONSE_IDLE_MS);
  }

  function finishBranchIfIdle() {
    if (!state.branchStreaming || !state.branchLastOutput) {
      return;
    }
    const idleMs = Date.now() - state.branchLastRealOutputAt;
    if (idleMs < RESPONSE_IDLE_MS - 250 || (idleMs < RESPONSE_GENERATING_GRACE_MS && isGeminiStillGenerating())) {
      scheduleBranchDoneCheck();
      return;
    }

    state.branchStreaming = false;
    stopBranchOutputPolling();
    sendRuntime("GWB_BRANCH_DONE", {
      branchId: state.branchMeta && state.branchMeta.id,
      turnId: state.branchCurrentTurnId,
      output: state.branchLastOutput,
      html: state.branchLastHtml,
      url: location.href
    }).catch(console.error);
  }

  async function reportBranchError(error) {
    stopBranchOutputPolling();
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

    const candidates = uniqueElements(selectors.flatMap((selector) => queryAllDeep(document, selector)))
      .filter((element) => element.id !== ROOT_ID && !element.closest(`#${ROOT_ID}`))
      .filter((element) => state.role === "branch" || isVisible(element))
      .filter((element) => normalizeText(element.innerText || element.textContent || "").length > 24);

    return candidates[candidates.length - 1] || null;
  }

  function isTransientGeminiStatus(output, element) {
    const normalized = normalizeText(output)
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/\s+/g, " ");
    if (!normalized || normalized.length > 180 || normalized.includes("\n")) {
      return false;
    }

    const transientPatterns = [
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
    ];
    if (transientPatterns.some((pattern) => pattern.test(normalized))) {
      return true;
    }

    if (element) {
      const label = getElementLabel(element).toLowerCase();
      return /progress|loading|thinking|generating|正在|处理中/.test(label) && normalized.length < 80;
    }
    return false;
  }

  function isGeminiStillGenerating() {
    const stop = findButtonByTerms([
      "stop generating",
      "stop response",
      "stop",
      "停止生成",
      "停止回答",
      "停止回复",
      "停止"
    ]);
    if (stop && isEnabled(stop) && !stop.closest(`#${ROOT_ID}`)) {
      return true;
    }

    return queryAllDeep(document, "[aria-busy='true'], [role='progressbar'], mat-progress-spinner, mat-spinner, [class*='spinner' i], [class*='loading' i]")
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .some((element) => state.role === "branch" || isVisible(element));
  }

  function pickInsertionTarget(anchor) {
    return anchor.closest("model-response, [data-test-id*='response' i], [data-testid*='response' i], .model-response, article") || anchor;
  }

  function renderBranchMessages(container, branch) {
    const messages = Array.isArray(branch.messages) ? branch.messages : [];
    container.replaceChildren();

    for (const message of messages) {
      const userTurn = document.createElement("section");
      userTurn.className = "gwb-turn gwb-turn-user";
      userTurn.innerHTML = `
        <div class="gwb-turn-label">You</div>
        <div class="gwb-turn-content gwb-text"></div>
      `;
      userTurn.querySelector(".gwb-turn-content").textContent = message.prompt || "";
      container.append(userTurn);

      if (message.outputHtml || message.output || branch.status === "sending" || branch.status === "streaming") {
        const assistantTurn = document.createElement("section");
        assistantTurn.className = "gwb-turn gwb-turn-assistant";
        assistantTurn.innerHTML = `
          <div class="gwb-turn-label">Gemini</div>
          <div class="gwb-turn-content"></div>
        `;
        const content = assistantTurn.querySelector(".gwb-turn-content");
        if (message.outputHtml) {
          content.classList.add("gwb-html");
          content.innerHTML = sanitizeHtml(message.outputHtml);
        } else if (message.output) {
          content.classList.add("gwb-text");
          content.textContent = message.output;
        } else {
          content.classList.add("gwb-text", "gwb-muted");
          content.textContent = "Waiting for response...";
        }
        container.append(assistantTurn);
      }
    }
  }

  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script, iframe, object, embed, link, meta").forEach((element) => element.remove());
    template.content.querySelectorAll("*").forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || name === "srcdoc" || name === "style" || value.startsWith("javascript:")) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    return template.innerHTML;
  }

  function findShareUrlInDocument(root = document) {
    const candidates = [];
    for (const element of queryAllDeep(root, "a[href], input, textarea, [aria-label], [title], [data-tooltip], [data-link], [data-url]")) {
      if (element instanceof HTMLAnchorElement) {
        candidates.push(element.href || "");
      } else {
        candidates.push(element.value || "");
      }
      candidates.push(
        element.getAttribute("href") || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.getAttribute("data-tooltip") || "",
        element.getAttribute("data-link") || "",
        element.getAttribute("data-url") || "",
        element.textContent || ""
      );
    }

    const dialog = root === document ? getShareSurface() : root;
    if (dialog) {
      candidates.push(dialog.innerText || dialog.textContent || "");
    }
    if (root === document) {
      candidates.push(document.body.innerText || "");
    }

    for (const value of candidates) {
      const shareUrl = normalizeShareUrlMatch(value);
      if (shareUrl) {
        return shareUrl;
      }
    }
    return "";
  }

  function normalizeShareUrlMatch(value) {
    const match = SHARE_URL_PATTERN.exec(String(value || ""));
    if (!match) {
      return "";
    }

    let url = match[0]
      .replace(/[).,，。]+$/, "")
      .replace(/&amp;/g, "&")
      .trim();
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    return url;
  }

  function queryAllDeep(root, selector) {
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
      "继续此聊天",
      "继续这个聊天",
      "继续此对话",
      "继续这个对话",
      "继续聊天",
      "继续对话",
      "在 gemini 中继续",
      "继续"
    ];
    const normalizedTerms = terms.map((term) => term.toLowerCase());
    const candidates = queryAllDeep(document, "a[href], button, [role='button'], div[aria-label], span[aria-label], div, span")
      .map(toClickableCandidate)
      .filter(Boolean)
      .filter((element, index, elements) => elements.indexOf(element) === index)
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => isVisible(element) || element instanceof HTMLAnchorElement)
      .filter(isEnabled)
      .sort(compareContinueCandidates);

    const textMatch = candidates.find((element) => {
      if (isAccountOrChromeEntry(element)) {
        return false;
      }
      const label = getElementVisibleLabel(element).toLowerCase();
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
        const label = getElementVisibleLabel(element).toLowerCase();
        return (
          url.hostname === "gemini.google.com" &&
          url.pathname.startsWith("/app") &&
          !url.pathname.startsWith("/share") &&
          normalizedTerms.some((term) => label.includes(term))
        );
      } catch {
        return false;
      }
    }) || null;
  }

  function toClickableCandidate(element) {
    if (!element || !(element instanceof Element)) {
      return null;
    }
    if (element.matches("a[href], button, [role='button']")) {
      return element;
    }
    const label = getElementVisibleLabel(element).toLowerCase();
    if (!label.includes("continue") && !label.includes("继续")) {
      return null;
    }
    if (label.length > 120) {
      return null;
    }
    return element.closest("a[href], button, [role='button']") || element;
  }

  function compareContinueCandidates(a, b) {
    return continueCandidateScore(b) - continueCandidateScore(a);
  }

  function continueCandidateScore(element) {
    const label = getElementVisibleLabel(element).toLowerCase();
    let score = 0;
    if (element.matches("button, [role='button']")) {
      score += 30;
    }
    if (element instanceof HTMLAnchorElement) {
      score += 15;
    }
    if (/^(继续此对话|继续此聊天|继续对话|继续聊天|继续|continue this conversation|continue this chat|continue)$/i.test(label.trim())) {
      score += 50;
    }
    if (label.includes("继续此对话") || label.includes("continue this conversation")) {
      score += 25;
    }
    score -= Math.min(label.length, 200) / 10;
    return score;
  }

  function activateElement(element) {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    if (element instanceof HTMLAnchorElement && element.href) {
      element.click();
      return;
    }
    element.click();
  }

  function dispatchContextMenu(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width - 4, Math.max(4, rect.width / 2));
    const y = rect.top + Math.min(rect.height - 4, Math.max(4, rect.height / 2));
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y,
      pointerType: "mouse"
    }));
    element.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y
    }));
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y
    }));
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

  function getElementVisibleLabel(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-tooltip"),
      element.innerText,
      element.textContent
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isAccountOrChromeEntry(element) {
    const label = getElementVisibleLabel(element).toLowerCase();
    const href = element instanceof HTMLAnchorElement ? element.href.toLowerCase() : "";
    return (
      href.includes("accounts.google.com") ||
      label.includes("google 账号") ||
      label.includes("google account") ||
      label.includes("@gmail.com")
    );
  }

  function buildComposerTimeoutMessage(lastClickedText) {
    const candidates = collectVisibleActions();
    return [
      "Timed out waiting for Gemini composer.",
      `URL: ${location.href}`,
      `Title: ${document.title || "(none)"}`,
      lastClickedText ? `Last clicked: ${lastClickedText}` : "",
      candidates ? `Visible actions: ${candidates}` : "Visible actions: none detected"
    ].filter(Boolean).join("\n");
  }

  function collectVisibleActions() {
    return Array.from(document.querySelectorAll("a[href], button, [role='button']"))
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => isVisible(element) || element instanceof HTMLAnchorElement)
      .map(getElementLabel)
      .filter(Boolean)
      .slice(0, 8)
      .join(" | ");
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

  async function focusAndSetText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      setFormControlValue(editor, "");
      await sleep(30);
      setFormControlValue(editor, text);
      return;
    }

    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand && document.execCommand("insertText", false, text);
    if (!inserted) {
      editor.textContent = text;
    }
    dispatchTextInputEvents(editor, text);
  }

  function setFormControlValue(editor, text) {
    const prototype = editor instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(editor, text);
    } else {
      editor.value = text;
    }
    dispatchTextInputEvents(editor, text);
  }

  function dispatchTextInputEvents(element, text) {
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: text
    };
    element.dispatchEvent(new InputEvent("beforeinput", eventInit));
    element.dispatchEvent(new InputEvent("input", eventInit));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    for (const key of ["Control", "a", "Backspace"]) {
      element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, composed: true }));
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
      activateElement(closeButton);
      return;
    }
    dispatchEscape();
  }

  function dispatchEscape() {
    const eventInit = {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    };
    const targets = uniqueElements([
      document.activeElement,
      document.body,
      document.documentElement,
      document,
      window
    ].filter(Boolean));
    for (const target of targets) {
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, eventInit));
      }
    }
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
    const fallbackIndex = currentConversationBranches().findIndex((item) => item.id === branch.id);
    const index = Number(branch.branchNumber) || (fallbackIndex >= 0 ? fallbackIndex + 1 : 1);
    return `Branch ${index}`;
  }

  function currentConversationBranches() {
    return Array.from(state.branches.values())
      .filter((branch) => branch.status !== "closed")
      .filter((branch) => branchParentConversationKey(branch) === state.parentConversationKey)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function branchParentConversationKey(branch) {
    return branch.parentConversationKey || getParentConversationKey(branch.parentUrl || "");
  }

  function getParentConversationKey(url) {
    try {
      const parsed = new URL(String(url || ""), location.href);
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

  function isGeminiSharePageUrl(url) {
    try {
      const parsed = new URL(String(url || ""), location.href);
      return (
        (parsed.hostname === "g.co" && parsed.pathname.startsWith("/gemini/share/")) ||
        (parsed.hostname === "gemini.google.com" && parsed.pathname.startsWith("/share/"))
      );
    } catch {
      return false;
    }
  }

  function isGeminiAppSharePageUrl(url) {
    try {
      const parsed = new URL(String(url || ""), location.href);
      return parsed.hostname === "gemini.google.com" && /^\/app\/[A-Za-z0-9_-]+\/share\//.test(parsed.pathname);
    } catch {
      return false;
    }
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
