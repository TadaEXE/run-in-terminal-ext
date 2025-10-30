// MV3 service worker (module)
// Purpose -> own extension plumbing, context menu, messaging between:
// 1) terminal tab (owns the PTY and forwards output)
// 2) popup mirror (renders the same output and sends keystrokes back)
// 3) confirm page flow for dangerous snippets

import { DEFAULTS } from "./defaults.js";
import { MENU_ID_DEFAULT, SESSION_KEY, TERM_URL, MENU_ID_PICK_PARENT, MENU_ID_PICK_PREFIX } from "./constants.js"
import { storedSet, storedMap } from "./util.js"


// Ephemeral:
const termPorts = new Map();
const mirrorPorts = new Set();
const mirrorSelection = new Map();
const termWaiters = new Map();
const viewWaiters = new Map();
const snapshotWaiters = new Map();
// const mirrorsByTab = new Map();

// Persistent:
const termReady = await storedSet("rit.termReady");
const sessionMeta = await storedMap("rit.sessionMeta");
const sessionNames = await storedMap("rit.sessionNames");

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

function resolveWaiters(map, key, ok) {
  const arr = map.get(key);
  if (!arr) return;
  for (const fn of arr) fn(ok);
  map.delete(key);
}

function waitForPort(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (termPorts.has(tabId)) return resolve(true);
    const arr = termWaiters.get(tabId) || [];
    arr.push(resolve);
    termWaiters.set(tabId, arr);
    setTimeout(() => {
      const left = (termWaiters.get(tabId) || []).filter(fn => fn !== resolve);
      if (left.length) termWaiters.set(tabId, left); else termWaiters.delete(tabId);
      resolve(false);
    }, timeoutMs);
  });
}
function waitForViewReady(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (termReady.has(tabId)) return resolve(true);
    const arr = viewWaiters.get(tabId) || [];
    arr.push(resolve);
    viewWaiters.set(tabId, arr);
    setTimeout(() => {
      const left = (viewWaiters.get(tabId) || []).filter(fn => fn !== resolve);
      if (left.length) viewWaiters.set(tabId, left); else viewWaiters.delete(tabId);
      resolve(false);
    }, timeoutMs);
  });
}

async function ensureTerminalTabReady(activate = true) {
  const tabs = await chrome.tabs.query({ url: TERM_URL });
  let tabId = tabs.length ? tabs[0].id : null;

  if (!tabId) {
    const created = await chrome.tabs.create({ url: TERM_URL, active: !!activate });
    tabId = created.id;
  } else if (activate) {
    const t = tabs[0];
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  }

  const okPort = await waitForPort(tabId, 5000);
  const okReady = await waitForViewReady(tabId, 5000);
  if (!okPort || !okReady) return null;
  return tabId;
}

async function focusTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } catch { }
}

// always create a new terminal tab
async function createTerminalTab(activate = false) {
  const created = await chrome.tabs.create({ url: TERM_URL, active: !!activate });
  const tabId = created.id;
  await waitForPort(tabId, 5000);
  await waitForViewReady(tabId, 5000);
  await broadcastSessionsUpdate();
  return tabId;
}

async function forwardToTerminalTab(message, preferredTabId = null) {
  let port = preferredTabId != null ? termPorts.get(preferredTabId) : null;
  if (!port) {
    const tabs = await chrome.tabs.query({ url: TERM_URL, active: true, currentWindow: true });
    if (tabs.length) port = termPorts.get(tabs[0].id) || null;
  }
  if (!port) {
    for (const p of termPorts.values()) { port = p; break; }
  }
  if (!port) {
    const tabId = await ensureTerminalTabReady(false);
    if (!tabId) return false;
    port = termPorts.get(tabId) || null;
  }
  if (!port) return false;
  try { port.postMessage(message); } catch { }
  return true;
}

// list sessions -> include saved names
async function listSessions() {
  const tabs = await chrome.tabs.query({ url: TERM_URL });
  return tabs.map(t => ({
    tabId: t.id,
    windowId: t.windowId,
    title: t.title || "Terminal",
    active: Boolean(t.active),
    name: sessionNames.get(t.id) || ""
  }));
}

// label builder for context menu
function labelForSession(it) {
  const base = (it.name && it.name.trim()) ? it.name.trim() : (it.title || "Terminal");
  return `${base} (tab ${it.tabId})`;
}

async function broadcastSessionsUpdate() {
  const items = await listSessions();
  chrome.runtime.sendMessage({ type: "mirror.sessions.updated", items }).catch(() => { });
  await rebuildAllMenus();
}

// Build context menus based on how many terminal sessions exist
async function rebuildAllMenus() {
  try { await chrome.contextMenus.removeAll(); } catch { }

  const sessions = await listSessions();

  if (sessions.length <= 1) {
    chrome.contextMenus.create({
      id: MENU_ID_DEFAULT,
      title: "Run in terminal",
      contexts: ["selection"]
    });

    return;
  }

  chrome.contextMenus.create({
    id: MENU_ID_PICK_PARENT,
    title: "Run in terminal",
    contexts: ["selection"]
  });

  for (const it of sessions) {
    chrome.contextMenus.create({
      id: MENU_ID_PICK_PREFIX + String(it.tabId),
      parentId: MENU_ID_PICK_PARENT,
      title: labelForSession(it),
      contexts: ["selection"]
    });
  }
}

// ports
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "rit-terminal") {
    const tabId = port.sender?.tab?.id;
    if (tabId == null) return;

    termPorts.set(tabId, port);
    resolveWaiters(termWaiters, tabId, true);
    broadcastSessionsUpdate();

    port.onMessage.addListener((msg) => {
      if (!msg) return;

      // if (!termPorts.has(tabId) && termReady.has(tabId)) {
      //   termPorts.set(tabId, port);
      // }

      if (msg.type === "rit.view.ready") {
        termReady.add(tabId);
        resolveWaiters(viewWaiters, tabId, true);
        return;
      }

      if (msg.type === "mirror.data" || msg.type === "mirror.state") {
        for (const m of mirrorPorts) {
          if (mirrorSelection.get(m) === tabId) {
            try { m.postMessage(msg); } catch { }
          }
        }
        return;
      }

      if (msg.type === "mirror.snapshot" && msg.reqId) {
        const m = snapshotWaiters.get(msg.reqId);
        snapshotWaiters.delete(msg.reqId);
        if (m) { try { m.postMessage(msg); } catch { } }
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      termPorts.delete(tabId);
      termReady.delete(tabId);
      sessionNames.delete(tabId);
      broadcastSessionsUpdate();
    });

    return;
  }

  if (port.name === "rit-mirror") {
    mirrorPorts.add(port);

    (async () => {
      const tabs = await chrome.tabs.query({ url: TERM_URL, active: true, currentWindow: true });
      if (tabs.length) mirrorSelection.set(port, tabs[0].id);
      else mirrorSelection.delete(port);
    })();

    port.onMessage.addListener(async (msg) => {
      if (!msg) return;

      if (msg.type === "mirror.sessions.request") {
        const items = await listSessions();
        try { port.postMessage({ type: "mirror.sessions", items }); } catch { }
        return;
      }

      if (msg.type === "mirror.select" && typeof msg.tabId === "number") {
        mirrorSelection.set(port, msg.tabId);
        try { port.postMessage({ type: "mirror.selected", tabId: msg.tabId }); } catch { }
        return;
      }

      if (msg.type === "mirror.stdin" && typeof msg.data === "string") {
        const tabId = mirrorSelection.get(port) || null;
        await forwardToTerminalTab({ type: "mirror.stdin", text: msg.data }, tabId);
        return;
      }

      if (msg.type === "mirror.snapshot.request" && msg.reqId) {
        const targetId = typeof msg.tabId === "number" ? msg.tabId : (mirrorSelection.get(port) || null);
        if (targetId && !termPorts.get(targetId)) {
          const ok = await waitForPort(targetId, 2000);
          if (!ok) {
            try {
              port.postMessage({
                type: "mirror.snapshot", reqId: msg.reqId, error: `terminal not ready (${msg.tabId} not in ${[...termPorts.keys()]})`
              });
            } catch { }
            return;
          }
        }
        if (targetId && termPorts.get(targetId)) {
          snapshotWaiters.set(msg.reqId, port);
          termPorts.get(targetId).postMessage({ type: "mirror.snapshot.request", reqId: msg.reqId });
        }
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      mirrorPorts.delete(port);
      mirrorSelection.delete(port);
    });
  }
});

chrome.runtime.onStartup?.addListener(() => { rebuildAllMenus(); });
chrome.runtime.onInstalled.addListener(() => { rebuildAllMenus(); });

// inject helper
async function injectSnippetToTerminal(text) {
  const tabId = await ensureTerminalTabReady(true);
  if (!tabId) {
    console.warn("[RIT] terminal page not ready for injection");
    return;
  }
  const port = termPorts.get(tabId);
  if (!port) return;
  await new Promise(r => setTimeout(r, 50));
  port.postMessage({ type: "rit.inject", text });
}

// inject into specific session
async function injectSnippetToSpecificTab(tabId, text, activate = true) {
  try { await chrome.tabs.get(tabId); } catch { return false; }

  const okPort = await waitForPort(tabId, 3000);
  const okReady = await waitForViewReady(tabId, 3000);
  if (!okPort || !okReady) return false;

  const port = termPorts.get(tabId);
  if (!port) return false;

  try { port.postMessage({ type: "rit.inject", text }); } catch { return false; }

  if (activate) await focusTab(tabId);

  return true;
}

// context menu handler
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.selectionText) return;

  // default single-session item
  if (info.menuItemId === MENU_ID_DEFAULT) {
    const settings = await getSettings();
    const snippet = info.selectionText;
    const dangerous = settings.confirmOnDanger ? findDangerousMatches(snippet, settings.dangerousSubstrings) : [];
    if (dangerous.length) {
      await setPending({ snippet, dangerous, when: Date.now() });
      await chrome.tabs.create({ url: "pages/confirm.html", active: true });
      return;
    }
    injectSnippetToTerminal(snippet + "\n");
    return;
  }

  // per-session submenu item
  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(MENU_ID_PICK_PREFIX)) {
    const tabId = Number(info.menuItemId.slice(MENU_ID_PICK_PREFIX.length));
    if (!Number.isFinite(tabId)) return;

    const settings = await getSettings();
    const snippet = info.selectionText;
    const dangerous = settings.confirmOnDanger ? findDangerousMatches(snippet, settings.dangerousSubstrings) : [];

    if (dangerous.length) {
      await setPending({ snippet, dangerous, when: Date.now(), targetTabId: tabId });
      await chrome.tabs.create({ url: "pages/confirm.html", active: true });
      return;
    }

    const ok = await injectSnippetToSpecificTab(tabId, snippet + "\n");
    if (!ok) console.warn("[RIT] specific-session inject failed for tab", tabId);
    return;
  }
});


// confirm page -> inject
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "rit.confirm.choice") {
    (async () => {
      try {
        const pending = await popPending();
        if (!pending) { sendResponse({ ok: false, error: "Nothing pending." }); return; }
        if (msg.choice === "cancel") { sendResponse({ ok: true, cancelled: true }); return; }

        const tabId = await ensureTerminalTabReady(true);
        if (!tabId) { sendResponse({ ok: false, error: "Terminal page not ready" }); return; }
        const port = termPorts.get(tabId);
        if (!port) { sendResponse({ ok: false, error: "No terminal port" }); return; }

        port.postMessage({ type: "rit.inject", text: pending.snippet + "\n" });
        await focusTab(tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

// popup support -> list, create new, rename
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "mirror.sessions.request") {
    (async () => {
      const items = await listSessions();
      sendResponse({ items });
    })();
    return true;
  }

  if (msg.type === "mirror.session.createBackground") {
    (async () => {
      try {
        const newId = await createTerminalTab(false);
        const items = await listSessions();
        sendResponse({ ok: true, createdTabId: newId, items });
      } catch (e) {
        const items = await listSessions();
        sendResponse({ ok: false, error: String(e), items });
      }
    })();
    return true;
  }

  if (msg.type === "mirror.session.terminateHost" && typeof msg.tabId === "number") {
    const p = termPorts.get(msg.tabId);
    if (p) { try { p.postMessage({ type: "rit.host.close" }); } catch { } }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "mirror.session.rename" && typeof msg.tabId === "number") {
    (async () => {
      const tabId = msg.tabId;
      const name = String(msg.name || "");
      sessionNames.set(tabId, name);
      // tell the terminal page to update its title
      const p = termPorts.get(tabId);
      if (p) {
        try { p.postMessage({ type: "rit.setName", name }); } catch { }
      } else {
        // if port not connected, try setting the tab title directly
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (n) => { try { document.title = n ? ("Terminal - " + n) : "Terminal"; } catch (e) { } },
            args: [name]
          });
        } catch { }
      }

      // reset any mirrors currently showing this session
      for (const m of mirrorPorts) {
        if (mirrorSelection.get(m) === tabId) {
          try { m.postMessage({ type: "mirror.reset" }); } catch { }
        }
      }

      await broadcastSessionsUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "mirror.session.view" && typeof msg.tabId === "number") {
    (async () => {
      try {
        await focusTab(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "mirror.confirm.close" && typeof msg.tabId === "number") {
    (async () => {
      const p = termPorts.get(msg.tabId);
      if (p) {
        try { p.postMessage({ type: "mirror.confirm.close" }); } catch { }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Session not found" });
      }
    })();
    return true;
  }

  if (msg.type === "mirror.session.close" && typeof msg.tabId === "number") {
    (async () => {
      try {
        await focusTab(msg.tabId);
        await chrome.tabs.remove(msg.tabId);
      } catch { }

      await broadcastSessionsUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }
});

async function reconcileSessions() {
  try {
    const urlPrefix = chrome.runtime.getURL("pages/terminal.html");
    const tabs = await chrome.tabs.query({ url: `${urlPrefix}*` });
    const alive = new Set(tabs.map(t => t.id));

    for (const id of termReady) if (!alive.has(id)) termReady.delete(id);
    for (const [id] of sessionMeta) if (!alive.has(id)) sessionMeta.delete(id);
    for (const [id] of sessionNames) if (!alive.has(id)) sessionNames.delete(id);
  } catch { }
}
reconcileSessions();

// cleanup name when tab is closed directly
chrome.tabs.onRemoved.addListener((tabId) => {
  sessionNames.delete(tabId);
  sessionMeta.delete(tabId);
  termReady.delete(tabId);
  broadcastSessionsUpdate();
});

