// Popup page controller
// Purpose -> session dropdown, naming UI, iframe focus, and mirror selection
//
import { DEFAULTS } from "./defaults.js"

const openSettingsBtn = document.getElementById("open-settings");
openSettingsBtn?.addEventListener("click", () => chrome.runtime.openOptionsPage());

const frame = document.getElementById("terminal-frame");
const select = document.getElementById("session-select");
const nameInput = document.getElementById("session-name");
const saveBtn = document.getElementById("save-name");

// Focus helper -> focuses iframe and asks inner page to focus xterm
function focusTerminalIframe(retries = 10) {
  try {
    frame?.focus();
    if (frame?.contentWindow) {
      frame.contentWindow.focus();
      frame.contentWindow.postMessage({ type: "rit.focus" }, "*");
    }
  } catch { }
  if (retries > 0) setTimeout(() => focusTerminalIframe(retries - 1), 50);
}

// Send selection to iframe when it is ready
function sendSelectionToIframe(tabId, retries = 10) {
  const win = frame?.contentWindow;
  if (win) {
    try {
      win.postMessage({ type: "rit.selectSession", tabId }, "*");
      return;
    } catch { }
  }
  if (retries > 0) setTimeout(() => sendSelectionToIframe(tabId, retries - 1), 50);
}

// Keep last sessions cache to populate the name field
let lastSessions = [];

// Render sessions into the dropdown and notify the iframe
function renderSessions(items) {
  lastSessions = Array.isArray(items) ? items : [];
  const oldVal = select.value;
  select.innerHTML = "";

  for (const it of lastSessions) {
    const labelName = it.name && it.name.trim() ? it.name.trim() : (it.title || "Terminal");
    const opt = document.createElement("option");
    opt.value = String(it.tabId);
    opt.textContent = `${labelName} (tab ${it.tabId})${it.active ? " *" : ""}`;
    select.appendChild(opt);
  }

  if ([...select.options].some(o => o.value === oldVal)) {
    select.value = oldVal;
  } else if (select.options.length) {
    select.selectedIndex = 0;
  }

  // Update the name input for the selected item
  if (select.value) {
    const tabId = Number(select.value);
    const item = lastSessions.find(x => x.tabId === tabId);
    nameInput.value = item && item.name ? item.name : "";
    sendSelectionToIframe(tabId);
  } else {
    nameInput.value = "";
  }
}

// Load existing sessions only -> no auto create on popup open
function loadSessions() {
  chrome.runtime.sendMessage({ type: "mirror.sessions.request" }, (resp) => {
    if (chrome.runtime.lastError) return;
    const items = resp && resp.items ? resp.items : [];
    renderSessions(items);
  });
}

// Listen for background broadcasts when sessions change
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "mirror.sessions.updated" && Array.isArray(msg.items)) {
    renderSessions(msg.items);
  }
});

// Selection handler -> switch mirror, refresh name field, focus iframe
select.addEventListener("change", () => {
  const tabId = Number(select.value);
  const item = lastSessions.find(x => x.tabId === tabId);
  nameInput.value = item && item.name ? item.name : "";
  sendSelectionToIframe(tabId);
  focusTerminalIframe();
});

// Save button -> send rename request to background
saveBtn?.addEventListener("click", () => {
  const tabId = Number(select.value);
  if (Number.isNaN(tabId)) return;
  const name = nameInput.value || "";
  chrome.runtime.sendMessage({ type: "mirror.session.rename", tabId, name }, () => {
    // background will broadcast an updated sessions list
  });
  focusTerminalIframe();
});

// Also save on Enter key inside the input
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveBtn?.click();
  }
});

// create a terminal tab in background, then refresh list and select it
document.getElementById("new-session")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "mirror.session.createBackground" }, (resp) => {
    loadSessions();
    if (resp && resp.createdTabId != null) {
      setTimeout(() => {
        select.value = String(resp.createdTabId);
        const tabId = Number(select.value);
        if (!Number.isNaN(tabId)) {
          sendSelectionToIframe(tabId);
          focusTerminalIframe();
        }
        nameInput.value = "";
      }, 100);
    } else {
      focusTerminalIframe();
    }
  });
});

// Close the currently selected terminal session (tab)
document.getElementById("close-session")?.addEventListener("click", async () => {
  const tabId = Number(select.value);
  if (Number.isNaN(tabId)) return;

  function doConfirmation(tabId) {
    return new Promise((resolve, reject) => {

      chrome.storage.sync.get(DEFAULTS, (cfgRaw) => {
        const cfg = { ...DEFAULTS, ...cfgRaw };
        if (!Boolean(cfg.confirmBeforeClose) || confirm("Do you really want to close this session?")) {
          chrome.runtime.sendMessage({ type: "mirror.confirm.close", tabId: tabId }, (response) => {
            if (response.ok) {
              resolve(response);
            } else {
              reject(response);
            }
          });
        } else {
          reject();
        }
      });
    });
  }

  try { await doConfirmation(tabId); } catch { return; }

  chrome.runtime.sendMessage({ type: "mirror.session.close", tabId }, (_resp) => {
    // refresh the list after closing
    loadSessions();

    // if nothing left, clear the mirror iframe view
    setTimeout(() => {
      if (!select.options.length) {
        try {
          frame?.contentWindow?.postMessage({ type: "rit.clear" }, "*");
        } catch { }
      } else {
        // choose first remaining session and mirror it
        select.selectedIndex = 0;
        const firstId = Number(select.value);
        if (!Number.isNaN(firstId)) {
          sendSelectionToIframe(firstId);
          focusTerminalIframe();
        }
      }
    }, 100);
  });
});

// View -> focus the selected terminal and close popup
document.getElementById("view-session")?.addEventListener("click", () => {
  const tabId = Number(select.value);
  if (Number.isNaN(tabId)) { try { window.close(); } catch { } return; }
  chrome.runtime.sendMessage({ type: "mirror.session.view", tabId }, () => {
    try { window.close(); } catch { }
  });
});

// Focus when iframe loads and populate sessions
frame.addEventListener("load", () => {
  focusTerminalIframe();
  loadSessions();
});

// Initial focus attempt and session load
focusTerminalIframe();
loadSessions();

