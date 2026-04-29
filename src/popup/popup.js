"use strict";

const SOURCE = "gwb";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refresh").addEventListener("click", render);
  document.getElementById("clear-closed").addEventListener("click", clearClosed);
  render().catch(showError);
});

async function render() {
  const { branches } = await sendRuntime("GWB_LIST_ALL_BRANCHES");
  const list = document.getElementById("branches");
  list.replaceChildren();

  if (!branches || branches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No branches yet.";
    list.append(empty);
    return;
  }

  branches.forEach((branch, index) => {
    const item = document.createElement("article");
    item.className = "branch";
    item.innerHTML = `
      <div class="branch-title">
        <strong>${escapeHtml(branch.parentTitle || `Branch ${index + 1}`)}</strong>
        <span class="pill">${escapeHtml(branch.status || "unknown")}</span>
      </div>
      <div class="meta">${escapeHtml(formatTime(branch.createdAt))}</div>
      <button type="button" data-action="open">Open branch window</button>
      <button type="button" data-action="close">Close branch window</button>
    `;
    item.querySelector("[data-action='open']").addEventListener("click", async () => {
      await sendRuntime("GWB_FOCUS_BRANCH", {
        branchId: branch.id
      });
      window.close();
    });
    item.querySelector("[data-action='close']").addEventListener("click", async () => {
      await sendRuntime("GWB_CLOSE_BRANCH", {
        branchId: branch.id
      });
      await render();
    });
    list.append(item);
  });
}

async function clearClosed() {
  await sendRuntime("GWB_CLEAR_CLOSED");
  await render();
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

function showError(error) {
  const list = document.getElementById("branches");
  list.replaceChildren();
  const item = document.createElement("div");
  item.className = "empty";
  item.textContent = error.message || String(error);
  list.append(item);
}

function formatTime(value) {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
