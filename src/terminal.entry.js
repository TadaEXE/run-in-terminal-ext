// Terminal page script
// Normal mode -> owns a PTY via native host and forwards output to background
// Mirror mode (?mirror=1) -> mirrors a selected terminal tab and sends keystrokes back

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { HOST_NAME, DEFAULTS } from "./defaults.js";

const term = new Terminal({
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#111111" },
  scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);

const root = document.getElementById("term");
term.open(root);
fit.fit();
term.focus();
root.addEventListener("mousedown", () => term.focus());

const isMirror = new URLSearchParams(location.search).get("mirror") === "1";

if (isMirror) {
  // Mirror mode
  const mirrorPort = chrome.runtime.connect({ name: "rit-mirror" });
  let selectedTabId = null;
  let lastReqId = null;

  function requestSnapshot() {
    if (selectedTabId == null) return;
    lastReqId = "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    mirrorPort.postMessage({ type: "mirror.snapshot.request", reqId: lastReqId, tabId: selectedTabId });
  }

  window.addEventListener("message", (e) => {
    const data = e && e.data;
    if (!data) return;

    if (data.type === "rit.selectSession" && typeof data.tabId === "number") {
      const isSwitch = selectedTabId !== null && selectedTabId !== data.tabId;
      selectedTabId = data.tabId;
      if (isSwitch) {
        term.reset();
        fit.fit();
        lastReqId = null;
      }
      mirrorPort.postMessage({ type: "mirror.select", tabId: selectedTabId });
      requestSnapshot();
      return;
    }

    if (data.type === "rit.focus") {
      term.focus();
      return;
    }

    if (data.type === "rit.clear") {
      selectedTabId = null;
      term.reset();
      fit.fit();
      lastReqId = null;
      return;
    }
  });

  mirrorPort.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === "mirror.snapshot" && msg.reqId) {
      if (msg.reqId !== lastReqId) return;
      if (msg.error) {
        term.writeln("[snapshot error] " + String(msg.error));
      } else if (msg.data_b64) {
        try { term.write(atob(msg.data_b64)); } catch (e) { term.writeln("[snapshot decode error] " + String(e)); }
      }
      return;
    }

    if (msg.type === "mirror.data" && msg.data_b64) {
      try { term.write(atob(msg.data_b64)); } catch { }
      return;
    }

    if (msg.type === "mirror.state") {
      if (msg.state === "ready") term.writeln("[mirroring terminal]");
      else if (msg.state === "exit") term.writeln("\r\n[process exited]");
      else if (msg.state === "error") term.writeln("\r\n[host error] " + String(msg.message || "unknown"));
      return;
    }

    if (msg.type === "mirror.reset") {
      term.reset();
      fit.fit();
      lastReqId = null;
      requestSnapshot();
      return;
    }
  });

  term.onData((data) => {
    mirrorPort.postMessage({ type: "mirror.stdin", data });
  });

  new ResizeObserver(() => { fit.fit(); }).observe(root);

} else { // Normal terminal tab

  let bgPort = null;
  let reconnectTimer = 0;
  let reconnectDelayMs = 200;

  // receive injections and mirror stdin
  function attachBgPortOnMessage(port) {
    port.onMessage.addListener((msg) => {
      if (msg?.type === "rit.inject" && typeof msg.text === "string") {
        openPty();
        if (ptyReady) ptyCon.postMessage({ type: "stdin", data_b64: btoa(msg.text) });
        else pendingInput.push(msg.text);
        return;
      }
      if (msg?.type === "mirror.stdin" && typeof msg.text === "string") {
        openPty();
        if (ptyReady) ptyCon.postMessage({ type: "stdin", data_b64: btoa(msg.text) });
        else pendingInput.push(msg.text);
        return;
      }
      if (msg?.type === "rit.host.close") {
        try { ptyCon.postMessage({ type: "close" }); } catch { }
        return;
      }
      if (msg?.type === "mirror.snapshot.request" && msg.reqId) {
        try {
          const dump = serialize.serialize();
          bgPort.postMessage({ type: "mirror.snapshot", reqId: msg.reqId, data_b64: btoa(dump) });
        } catch (e) {
          bgPort.postMessage({ type: "mirror.snapshot", reqId: msg.reqId, error: String(e) });
        }
        return;
      }
      if (msg?.type === "mirror.confirm.close") {
        externalCloseConfirm = true;
        return;
      }
      // set session name -> update tab title for easier identification
      if (msg?.type === "rit.setName") {
        const name = String(msg.name || "");
        document.title = name ? ("Terminal - " + name) : "Terminal";
        return;
      }
    });
  }


  function announceReady() {
    if (!bgPort) return;

    try {
      bgPort.postMessage({ type: "rit.view.ready" });
    } catch { }
  }

  function connectBg() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }

    const p = chrome.runtime.connect({ name: "rit-terminal" });
    bgPort = p;
    p.onDisconnect.addListener(() => {
      bgPort = null;
      reconnectTimer = setTimeout(() => { connectBg(); }, reconnectDelayMs);
    });
    attachBgPortOnMessage(p)
    announceReady();
  }
  connectBg()

  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  let ptyCon = chrome.runtime.connectNative(HOST_NAME);
  let ptyOpened = false;
  let ptyReady = false;
  const pendingInput = [];
  let readyFlushTimer = null;
  const tabId = await chrome.tabs.getCurrent();
  const ptySessionName = tabId.id ? `tab${tabId.id}` : Date.now().toString();

  let warnOnClose = false;
  let userInteracted = false;
  let externalCloseConfirm = false;

  function openPty() {
    if (ptyOpened) return;
    ptyOpened = true;
    console.log(`Opening session ${ptySessionName}`)
    term.writeln(`[connecting to native host session ${ptySessionName}...]`);
    chrome.storage.sync.get(DEFAULTS, (cfgRaw) => {
      const cfg = { ...DEFAULTS, ...cfgRaw };
      const sh = (cfg.shellOverride || "").trim();
      ptyCon.postMessage({
        type: "open",
        cols: term.cols,
        rows: term.rows,
        session: ptySessionName,
        ...(sh && { shell: sh })
      });
    });
  }

  function closePty() {
    if (!ptyOpened) return;
    ptyOpened = false;
    console.log(`Closing session ${ptySessionName}`)
    term.writeln(`[closing native host session ${ptySessionName}]`)
    ptyCon.postMessage({
      type: "close"
    });
  }

  function flushPending() {
    while (pendingInput.length) {
      const text = pendingInput.shift();
      ptyCon.postMessage({ type: "stdin", data_b64: btoa(text) });
    }
  }

  function updateCloseProtection() {
    chrome.storage.sync.get(DEFAULTS, (cfgRaw) => {
      const cfg = { ...DEFAULTS, ...cfgRaw };
      warnOnClose = !!cfg.confirmBeforeClose && ptyReady;
    });
  }

  ptyCon.onDisconnect.addListener((msg) => {
    console.log(msg)
  })

  ptyCon.onMessage.addListener((msg) => {
    if (msg?.type === "data" && msg.data_b64) {
      term.write(atob(msg.data_b64));
      bgPort.postMessage({ type: "mirror.data", data_b64: msg.data_b64 });
      return;
    }
    if (msg?.type === "ready") {
      ptyReady = true;
      ptyCon.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
      if (readyFlushTimer) clearTimeout(readyFlushTimer);
      readyFlushTimer = setTimeout(flushPending, 200);
      updateCloseProtection();
      bgPort.postMessage({ type: "mirror.state", state: "ready" });
      return;
    }
    if (msg?.type === "exit") {
      ptyReady = false;
      ptyOpened = false;
      warnOnClose = false;
      term.writeln("\r\n[process exited]");
      bgPort.postMessage({ type: "mirror.state", state: "exit" });
      return;
    }
    if (msg?.type === "error") {
      term.writeln("\r\n[host error] " + String(msg.message || "unknown"));
      bgPort.postMessage({ type: "mirror.state", state: "error", message: msg.message || "unknown" });
      return;
    }
  });

  ptyCon.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "";
    term.writeln("\r\n[disconnected] " + err);
    bgPort.postMessage({ type: "mirror.state", state: "error", message: err });
  });

  term.onData((data) => {
    ptyCon.postMessage({ type: "stdin", data_b64: btoa(data) });
  });

  new ResizeObserver(() => {
    fit.fit();
    ptyCon.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
  }).observe(root);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area == "sync" && changes.confirmBeforeClose) {
      updateCloseProtection();
    }
  });

  window.addEventListener("unload", () => {
    console.log("Closing connecting with host");
    closePty();
    try { ptyCon.disconnect(); } catch { }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      if (bgPort) {
        bgPort.disconnect();
      }
    } catch { }
  });

  window.addEventListener("beforeunload", (e) => {
    if (externalCloseConfirm) {
      console.log("instantly closing due to external confirmation.");
      closePty();
    } else {
      console.log("warnOnClose", warnOnClose, "userInteracted", userInteracted);
      if (warnOnClose && userInteracted) e.preventDefault();
    }
  });

  // make sure preventDefault in beforeunload fires
  root.addEventListener("mousedown", () => { userInteracted = true }, { once: true });
  window.addEventListener("keydown", () => { userInteracted = true }, { once: true });
  window.addEventListener("touchstart", () => { userInteracted = true }, { once: true });

  openPty();
  updateCloseProtection();
}

