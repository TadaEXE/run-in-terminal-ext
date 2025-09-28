import { DEFAULTS } from "./defaults.js"

const els = {
  shellOverride: document.getElementById("shellOverride"),
  dangerousSubstrings: document.getElementById("dangerousSubstrings"),
  confirmOnDanger: document.getElementById("confirmOnDanger"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
  genLinux: document.getElementById("gen-linux"),
  genWin: document.getElementById("gen-win"),
  ping: document.getElementById("ping-host"),
};

async function load() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  const cfg = { ...DEFAULTS, ...got };
  els.shellOverride.value = cfg.shellOverride || "";
  els.dangerousSubstrings.value = (cfg.dangerousSubstrings || []).join("\n");
  els.confirmOnDanger.checked = !!cfg.confirmOnDanger;
}

async function save() {
  const dangerous = els.dangerousSubstrings.value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  await chrome.storage.sync.set({
    shellOverride: els.shellOverride.value.trim(),
    dangerousSubstrings: dangerous,
    confirmOnDanger: !!els.confirmOnDanger.checked
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

await ensureDefaults();

els.save.addEventListener("click", save);
load();
