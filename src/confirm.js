import { SESSION_KEY } from "./constants.js"

const els = {
  snippet: document.getElementById("snippet"),
  matches: document.getElementById("matches"),
  cancel: document.getElementById("cancel"),
  proceed: document.getElementById("proceed")
};

async function loadPending() {
  const got = await chrome.storage.local.get(SESSION_KEY);
  const payload = got?.[SESSION_KEY];
  if (!payload) {
    els.snippet.textContent = "(Nothing pending)";
    return null;
  }
  els.snippet.textContent = payload.snippet || "";
  els.matches.innerHTML = "";
  for (const m of payload.dangerous || []) {
    const li = document.createElement("li");
    li.textContent = m;
    els.matches.appendChild(li);
  }
  return payload;
}

function decide(choice) {
  chrome.runtime.sendMessage({ type: "rit.confirm.choice", choice }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
}

els.cancel.addEventListener("click", () => decide("cancel"));
els.proceed.addEventListener("click", () => decide("proceed"));

loadPending();
