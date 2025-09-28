// MV3 service worker (module)
// Purpose -> own extension plumbing, context menu, messaging between:
// 1) terminal tab (owns the PTY and forwards output)
// 2) popup mirror (renders the same output and sends keystrokes back)
// 3) confirm page flow for dangerous snippets

import { DEFAULTS } from "./defaults.js";
import { MENU_ID, SESSION_KEY, TERM_URL } from "./constants.js"

// Storage helpers for confirm flow
async function getSettings() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

async function setPending(payload) {
  await chrome.storage.local.set({ [SESSION_KEY]: payload });
}

async function popPending() {
  const got = await chrome.storage.local.get(SESSION_KEY);
  await chrome.storage.local.remove(SESSION_KEY);
  return got?.[SESSION_KEY] || null;
}

function findDangerousMatches(snippet, list) {
  const hay = String(snippet).toLowerCase();
  const res = [];
  for (const t of list || []) {
    const term = String(t).trim().toLowerCase();
    if (term && hay.includes(term)) res.push(t);
  }
  return res;
}

async function ensureTerminalTabReady() {
  const tabs = await chrome.tabs.query({ url: TERM_URL });
  let tabId = tabs.length ? tabs[0].id : null;

  if (!tabId) {
    const created = await chrome.tabs.create({ url: TERM_URL, active: false });
    tabId = created.id;
  }

  const okPort = await waitForPort(tabId);
  const okReady = await waitForViewReady(tabId);
  if (!okPort || !okReady) return null;
  return tabId;
}

// Open or focus the single terminal page tab
async function openOrFocusTerminal() {
  const tabs = await chrome.tabs.query({ url: TERM_URL });
  if (tabs.length) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return t.id;
  }
  const created = await chrome.tabs.create({ url: TERM_URL, active: true });
  return created.id;
}

// Ports and waiters
// termPorts -> tabId to Port from the terminal page (name "rit-terminal")
// termReady -> tabIds that signaled the view is ready to receive messages
// mirrorPorts -> set of Ports from popup mirrors (name "rit-mirror")
const termPorts = new Map();
const termReady = new Set();
const termWaiters = new Map();
const viewWaiters = new Map();
const mirrorPorts = new Set();

// Snapshot routing for popup -> terminal tab roundtrip
// snapshotWaiters -> reqId to mirror Port
const snapshotWaiters = new Map();

function resolveWaiters(map, key, ok) {
  const arr = map.get(key);
  if (!arr) return;
  for (const fn of arr) fn(ok);
  map.delete(key);
}

// Wait for a terminal page Port to be available
function waitForPort(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (termPorts.has(tabId)) return resolve(true);
    const arr = termWaiters.get(tabId) || [];
    arr.push(resolve);
    termWaiters.set(tabId, arr);
    setTimeout(() => {
      const left = (termWaiters.get(tabId) || []).filter(fn => fn !== resolve);
      if (left.length) termWaiters.set(tabId, left);
      else termWaiters.delete(tabId);
      resolve(false);
    }, timeoutMs);
  });
}

// Wait for the terminal page to say it is ready to receive messages
function waitForViewReady(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (termReady.has(tabId)) return resolve(true);
    const arr = viewWaiters.get(tabId) || [];
    arr.push(resolve);
    viewWaiters.set(tabId, arr);
    setTimeout(() => {
      const left = (viewWaiters.get(tabId) || []).filter(fn => fn !== resolve);
      if (left.length) viewWaiters.set(tabId, left);
      else viewWaiters.delete(tabId);
      resolve(false);
    }, timeoutMs);
  });
}

// Send a message to a terminal tab -> opens a terminal tab if none exists
async function forwardToTerminalTab(message) {
  // try active terminal tab first
  const tabs = await chrome.tabs.query({ url: TERM_URL, active: true, currentWindow: true });
  let port = tabs.length ? termPorts.get(tabs[0].id) : null;

  // fallback to any connected terminal port
  if (!port) {
    for (const p of termPorts.values()) { port = p; break; }
  }

  // if no port at all, open a terminal tab and wait for readiness
  if (!port) {
    const tabId = await ensureTerminalTabReady();
    if (!tabId) return false;
    port = termPorts.get(tabId) || null;
  }

  if (!port) return false;
  try { port.postMessage(message); } catch {}
  return true;
}


// Relay and snapshot routing
chrome.runtime.onConnect.addListener((port) => {
  // Terminal page port
  if (port.name === "rit-terminal") {
    const tabId = port.sender?.tab?.id;
    if (tabId == null) return;

    termPorts.set(tabId, port);
    resolveWaiters(termWaiters, tabId, true);

    port.onMessage.addListener((msg) => {
      if (!msg) return;

      // Terminal tab signals that its view is ready
      if (msg.type === "rit.view.ready") {
        termReady.add(tabId);
        resolveWaiters(viewWaiters, tabId, true);
      }

      // Live relay -> forward to all popup mirrors
      if (msg.type === "mirror.data" || msg.type === "mirror.state") {
        for (const m of mirrorPorts) { try { m.postMessage(msg); } catch { } }
      }

      // Snapshot response -> route back to the asking mirror popup
      if (msg.type === "mirror.snapshot" && msg.reqId) {
        const m = snapshotWaiters.get(msg.reqId);
        snapshotWaiters.delete(msg.reqId);
        if (m) {
          try { m.postMessage(msg); } catch { }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      termPorts.delete(tabId);
      termReady.delete(tabId);
    });

    return;
  }

  // Popup mirror port
  if (port.name === "rit-mirror") {
    mirrorPorts.add(port);

    port.onMessage.addListener((msg) => {
      if (!msg) return;

      // Popup keystrokes -> terminal tab
      if (msg.type === "mirror.stdin" && typeof msg.data === "string") {
        forwardToTerminalTab({ type: "mirror.stdin", text: msg.data });
      }

      // Popup requests a snapshot -> route to terminal tab and remember where to respond
      if (msg.type === "mirror.snapshot.request" && msg.reqId) {
        snapshotWaiters.set(msg.reqId, port);
        forwardToTerminalTab({ type: "mirror.snapshot.request", reqId: msg.reqId });
      }
    });

    port.onDisconnect.addListener(() => {
      mirrorPorts.delete(port);
    });
  }
});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Run in Terminal",
    contexts: ["selection"]
  });
});

// Inject a snippet into the terminal page, opening it if needed
async function injectSnippetToTerminal(text) {
  const tabs = await chrome.tabs.query({ url: TERM_URL });
  const tabId = tabs.length ? tabs[0].id : (await chrome.tabs.create({ url: TERM_URL, active: true })).id;

  const okPort = await waitForPort(tabId, 5000);
  const okReady = await waitForViewReady(tabId, 5000);
  if (!okPort || !okReady) {
    console.warn("[RIT] terminal not ready (port:", okPort, " view:", okReady, ")");
    return;
  }
  const port = termPorts.get(tabId);
  if (!port) return;

  // Small grace to ensure the listener is attached
  await new Promise(r => setTimeout(r, 50));
  port.postMessage({ type: "rit.inject", text });
}

// Context menu handler
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const settings = await getSettings();
  const snippet = info.selectionText;

  const dangerous = settings.confirmOnDanger
    ? findDangerousMatches(snippet, settings.dangerousSubstrings)
    : [];

  if (dangerous.length) {
    await setPending({ snippet, dangerous, when: Date.now() });
    await chrome.tabs.create({ url: "pages/confirm.html", active: true });
    return;
  }
  injectSnippetToTerminal(snippet + "\n");
});

// Confirm page -> inject
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "rit.confirm.choice") {
    (async () => {
      try {
        const pending = await popPending();
        if (!pending) { sendResponse({ ok: false, error: "Nothing pending." }); return; }
        if (msg.choice === "cancel") { sendResponse({ ok: true, cancelled: true }); return; }

        const tabId = await openOrFocusTerminal();
        const okPort = await waitForPort(tabId, 5000);
        const okReady = await waitForViewReady(tabId, 5000);
        if (!okPort || !okReady) { sendResponse({ ok: false, error: "Terminal page not ready" }); return; }

        const port = termPorts.get(tabId);
        if (!port) { sendResponse({ ok: false, error: "No terminal port" }); return; }

        port.postMessage({ type: "rit.inject", text: pending.snippet + "\n" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

