// Terminal page script
// Normal mode -> owns the PTY and forwards data to background for mirrors
// Mirror mode (?mirror=1) -> shows what the terminal tab renders and sends keystrokes back

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { HOST_NAME, DEFAULTS } from "./defaults.js";

const term = new Terminal({
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#111111" },
  scrollback: 5000
});
const fit = new FitAddon();
term.loadAddon(fit);

const root = document.getElementById("term");
term.open(root);
fit.fit();
term.focus();

window.addEventListener("message", (e) => {
  const data = e && e.data;
  if (data && data.type === "rit.focus") {
    term.focus();
  }
});
root.addEventListener("mousedown", () => term.focus());

// Detect mirror mode
const isMirror = new URLSearchParams(location.search).get("mirror") === "1";

if (isMirror) {
  // Mirror view in the popup -> no native host, only relay
  const mirrorPort = chrome.runtime.connect({ name: "rit-mirror" });

  // Request a one-time snapshot of the current buffer from the terminal tab
  const reqId = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  mirrorPort.postMessage({ type: "mirror.snapshot.request", reqId });

  // Receive snapshot, then live updates and state changes
  mirrorPort.onMessage.addListener((msg) => {
    if (!msg) return;

    // One-time snapshot -> write full dump, then continue with live data
    if (msg.type === "mirror.snapshot" && msg.reqId === reqId) {
      if (msg.error) {
        term.writeln("\r\n[snapshot error] " + String(msg.error));
      } else if (msg.data_b64) {
        const dump = atob(msg.data_b64);
        term.write(dump);
      }
      return;
    }

    // Live output from the terminal tab
    if (msg.type === "mirror.data" && msg.data_b64) {
      term.write(atob(msg.data_b64));
      return;
    }

    // State changes from the terminal tab
    if (msg.type === "mirror.state") {
      if (msg.state === "ready") {
        term.writeln("\x1b[38;5;246m[mirroring terminal]\x1b[0m");
      } else if (msg.state === "exit") {
        term.writeln("\r\n[process exited]");
      } else if (msg.state === "error") {
        term.writeln("\r\n[host error] " + String(msg.message || "unknown"));
      }
      return;
    }
  });

  // Keystrokes from the popup -> forward to the terminal tab
  term.onData((data) => {
    mirrorPort.postMessage({ type: "mirror.stdin", data });
  });

  // Mirrors do not need to resize the PTY, they are view only
} else {
  // Normal terminal tab -> owns the PTY and connects to native host
  const bgPort = chrome.runtime.connect({ name: "rit-terminal" });

  // Tell background that the view is ready to receive messages
  bgPort.postMessage({ type: "rit.view.ready" });

  // Load serialize addon so we can snapshot buffer on request
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  // Native messaging connection
  let hostPort = chrome.runtime.connectNative(HOST_NAME);

  // State for initial open and input queueing
  let ptyOpened = false;
  let ptyReady = false;
  const pendingInput = [];
  let readyFlushTimer = null;

  function openPty() {
    if (ptyOpened) return;
    ptyOpened = true;
    term.writeln("\x1b[38;5;246m[connecting to native host...]\x1b[0m");
    chrome.storage.sync.get(DEFAULTS, (cfgRaw) => {
      const cfg = { ...DEFAULTS, ...cfgRaw };
      const sh = (cfg.shellOverride || "").trim();
      hostPort.postMessage({
        type: "open",
        cols: term.cols,
        rows: term.rows,
        ...(sh && { shell: sh })
      });
    });
  }

  function flushPending() {
    while (pendingInput.length) {
      const text = pendingInput.shift();
      hostPort.postMessage({ type: "stdin", data_b64: btoa(text) });
    }
  }

  // Host messages -> write and forward for mirrors
  hostPort.onMessage.addListener((msg) => {
    if (msg?.type === "data" && msg.data_b64) {
      term.write(atob(msg.data_b64));
      bgPort.postMessage({ type: "mirror.data", data_b64: msg.data_b64 });
      return;
    }
    if (msg?.type === "ready") {
      ptyReady = true;
      hostPort.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
      if (readyFlushTimer) clearTimeout(readyFlushTimer);
      // Delay flush so the shell prompt usually draws before injected text
      readyFlushTimer = setTimeout(flushPending, 200);
      bgPort.postMessage({ type: "mirror.state", state: "ready" });
      return;
    }
    if (msg?.type === "exit") {
      ptyReady = false;
      ptyOpened = false;
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

  hostPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "";
    term.writeln("\r\n[disconnected] " + err);
    bgPort.postMessage({ type: "mirror.state", state: "error", message: err });
  });

  // Messages from background -> context menu injection and mirror keystrokes
  bgPort.onMessage.addListener((msg) => {
    if (msg?.type === "rit.inject" && typeof msg.text === "string") {
      openPty();
      if (ptyReady) {
        hostPort.postMessage({ type: "stdin", data_b64: btoa(msg.text) });
      } else {
        pendingInput.push(msg.text);
      }
      return;
    }
    if (msg?.type === "mirror.stdin" && typeof msg.text === "string") {
      openPty();
      if (ptyReady) {
        hostPort.postMessage({ type: "stdin", data_b64: btoa(msg.text) });
      } else {
        pendingInput.push(msg.text);
      }
      return;
    }
    // Snapshot request routed via background from a popup mirror
    if (msg?.type === "mirror.snapshot.request" && msg.reqId) {
      try {
        // serialize() returns ANSI string for full buffer (scrollback + viewport)
        const dump = serialize.serialize();
        bgPort.postMessage({ type: "mirror.snapshot", reqId: msg.reqId, data_b64: btoa(dump) });
      } catch (e) {
        bgPort.postMessage({ type: "mirror.snapshot", reqId: msg.reqId, error: String(e) });
      }
      return;
    }
  });

  // Keystrokes from this tab -> host
  term.onData((data) => {
    hostPort.postMessage({ type: "stdin", data_b64: btoa(data) });
  });

  // Resize -> host
  new ResizeObserver(() => {
    fit.fit();
    hostPort.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
  }).observe(root);

  // Open PTY on load
  openPty();
}

