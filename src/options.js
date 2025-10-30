import { DEFAULTS } from "./defaults.js"
import { HOST_NAME } from "./installers.js";

const els = {
  shellOverride: document.getElementById("shellOverride"),
  dangerousSubstrings: document.getElementById("dangerousSubstrings"),
  confirmOnDanger: document.getElementById("confirmOnDanger"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
  genLinux: document.getElementById("gen-linux"),
  genWin: document.getElementById("gen-win"),
  ping: document.getElementById("ping-host"),
  warnClose: document.getElementById("warn-close"),
};

async function load() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  const cfg = { ...DEFAULTS, ...got };
  els.shellOverride.value = cfg.shellOverride || "";
  els.dangerousSubstrings.value = (cfg.dangerousSubstrings || []).join("\n");
  els.confirmOnDanger.checked = !!cfg.confirmOnDanger;
  els.warnClose.checked = !!cfg.confirmBeforeClose;
}

async function save() {
  const dangerous = els.dangerousSubstrings.value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  await chrome.storage.sync.set({
    shellOverride: els.shellOverride.value.trim(),
    dangerousSubstrings: dangerous,
    confirmOnDanger: !!els.confirmOnDanger.checked,
    confirmBeforeClose: !!els.warnClose.checked
  });

  els.status.textContent = "Saved!";
  setTimeout(() => (els.status.textContent = ""), 1200);
}

async function ensureDefaults() {
  const got = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (got[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.sync.set(toSet);
  }
}

function pingHost() {
  const host = HOST_NAME;
  let port;
  try {
    port = chrome.runtime.connectNative(host);
  } catch (e) {
    alert("Native host connect failed.\n\n" + e); return;
  }

  let done = false;
  const t = setTimeout(() => {
    if (done) return; done = true;
    try {
      port.disconnect();
    } catch { };

    alert("Ping timeout.");
  }, 3000);
  port.onMessage.addListener((msg) => {
    if (done) return; done = true; clearTimeout(t); try {
      port.disconnect();
    } catch { };

    alert(msg && msg.type === "pong" ? "Host connected: Received pong." : "Host responded.");
  });
  port.onDisconnect.addListener(() => {
    if (done) return; done = true; clearTimeout(t); const err = chrome.runtime.lastError?.message || "Disconnected."; alert("Host disconnect: " + err);
  });
  try {
    port.postMessage({ type: "ping" });
  } catch (e) {
    clearTimeout(t);
    alert("Ping send failed.\n\n" + e);
  }
}

await ensureDefaults();

els.save.addEventListener("click", save);
els.ping.addEventListener("click", pingHost);
load();
