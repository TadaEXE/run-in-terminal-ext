// Minimal installers + ping hooked to your existing buttons
// Stays close to your options.html layout and simple options.js

import { DEFAULTS } from "./defaults.js";

// Constants derived from manifest/runtime
const MANIFEST = chrome.runtime.getManifest();
const HOST_NAME = DEFAULTS.nativeHostName || "com.tada.run_in_terminal";
const GECKO_ID =
  (MANIFEST.browser_specific_settings &&
    MANIFEST.browser_specific_settings.gecko &&
    MANIFEST.browser_specific_settings.gecko.id) ||
  "run-in-terminal@tada.com";
const CHROME_ORIGIN = `chrome-extension://${chrome.runtime.id}/`;

// Default host script path used inside generated installers
// -> edit these in the generated file if your path differs
const LINUX_MAC_HOST_PATH =
  "/home/tada/Projects/run-in-terminal-ext/native-host/run_in_terminal.py";
const WIN_HOST_PATH = `%USERPROFILE%\\run-in-terminal\\native-host\\run_in_terminal.py`;

// ---- JSON builders (the JSON gets embedded into the scripts via heredoc / here-string) ----
function buildFirefoxHostJson(hostPath) {
  const obj = {
    name: HOST_NAME,
    description: "Run in Terminal native host",
    path: hostPath,
    type: "stdio",
    allowed_extensions: [GECKO_ID],
  };
  return JSON.stringify(obj, null, 2);
}

function buildChromeHostJson(hostPath) {
  const obj = {
    name: HOST_NAME,
    description: "Run in Terminal native host",
    path: hostPath,
    type: "stdio",
    allowed_origins: [CHROME_ORIGIN],
  };
  return JSON.stringify(obj, null, 2);
}

// ---- Linux/macOS .sh generator (installs for Firefox + Chrome, user scope) ----
function makeLinuxMacInstallerSh(hostPath = LINUX_MAC_HOST_PATH) {
  const ffJson = buildFirefoxHostJson(hostPath);
  const chJson = buildChromeHostJson(hostPath);

  // Use $HOME in bash, not ${HOME} to avoid JS interpolation problems
  return `#!/usr/bin/env bash
set -euo pipefail

# Run in Terminal native host installer (Linux/macOS, user scope)
# Host path -> edit if needed:
HOST_PATH="${hostPath}"
HOST_NAME="${HOST_NAME}"

# Detect OS for directories
OS="$(uname -s || echo unknown)"
if [[ "$OS" == "Darwin" ]]; then
  FF_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  CH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  FF_DIR="$HOME/.mozilla/native-messaging-hosts"
  CH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

FF_JSON="$FF_DIR/${HOST_NAME}.json"
CH_JSON="$CH_DIR/${HOST_NAME}.json"

echo "Installing native host..."
echo "  Host path: $HOST_PATH"
echo "  Firefox json -> $FF_JSON"
echo "  Chrome  json -> $CH_JSON"

mkdir -p "$FF_DIR" "$CH_DIR"

# Write Firefox JSON
cat > "$FF_JSON" <<'JSON'
${ffJson}
JSON

# Write Chrome JSON
cat > "$CH_JSON" <<'JSON'
${chJson}
JSON

chmod 644 "$FF_JSON" "$CH_JSON" || true

# Make sure host script is executable (best effort)
if [[ -f "$HOST_PATH" ]]; then
  chmod +x "$HOST_PATH" || true
fi

echo
echo "Done."
echo "Notes:"
echo " - For Chromium, copy $CH_JSON to $HOME/.config/chromium/NativeMessagingHosts/${HOST_NAME}.json"
echo " - Restart the browser(s) after installing."
`;
}

// ---- Windows PowerShell generator (installs for Firefox + Chrome, HKCU) ----
function makeWindowsInstallerPs1(hostPathWin = WIN_HOST_PATH) {
  const ffJson = buildFirefoxHostJson(hostPathWin);
  const chJson = buildChromeHostJson(hostPathWin);

  // Escape backticks for PowerShell here-strings
  const ffEsc = ffJson.replace(/`/g, "``");
  const chEsc = chJson.replace(/`/g, "``");

  return `# Run in Terminal native host installer (Windows, HKCU)
$ErrorActionPreference = "Stop"

$HostPath = "${hostPathWin}"
$Base = Join-Path $env:LOCALAPPDATA "RunInTerminal"
New-Item -ItemType Directory -Force -Path $Base | Out-Null

$FirefoxJson = Join-Path $Base "${HOST_NAME}.firefox.json"
$ChromeJson  = Join-Path $Base "${HOST_NAME}.chrome.json"

# Write Firefox JSON
@'
${ffEsc}
'@ | Set-Content -Path $FirefoxJson -Encoding UTF8 -NoNewline

# Write Chrome JSON
@'
${chEsc}
'@ | Set-Content -Path $ChromeJson -Encoding UTF8 -NoNewline

# Registry mappings (user scope)
New-Item -Path "HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}" -Name "(default)" -Value $FirefoxJson

New-Item -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" -Name "(default)" -Value $ChromeJson

# Make host script executable if it exists (PowerShell-friendly shells may not need this)
if (Test-Path -Path $HostPath) {
  try { icacls $HostPath /grant "*S-1-5-32-545:(RX)" | Out-Null } catch {}
}

Write-Host ""
Write-Host "Installed:"
Write-Host " - Firefox JSON -> $FirefoxJson"
Write-Host " - Chrome  JSON -> $ChromeJson"
Write-Host "Restart your browser(s)."
`;
}

// ---- Download helpers ----
async function downloadText(filename, mime, text) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
      conflictAction: "overwrite",
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

// ---- Ping host ----
function pingHost() {
  const host = HOST_NAME;
  let port;
  try {
    port = chrome.runtime.connectNative(host);
  } catch (e) {
    alert("Native host connect failed.\n\n" + String(e));
    return;
  }

  let done = false;
  const t = setTimeout(() => {
    if (done) return;
    done = true;
    try { port.disconnect(); } catch { }
    alert("Ping timeout. Is the native host installed?");
  }, 3000);

  port.onMessage.addListener((msg) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    try { port.disconnect(); } catch { }
    if (msg && msg.type === "pong") {
      alert("Pong from native host.");
    } else {
      alert("Host responded.");
    }
  });

  port.onDisconnect.addListener(() => {
    if (done) return;
    done = true;
    clearTimeout(t);
    const err = chrome.runtime.lastError?.message || "Disconnected.";
    alert("Host disconnect: " + err);
  });

  try {
    port.postMessage({ type: "ping" });
  } catch (e) {
    clearTimeout(t);
    alert("Ping send failed.\n\n" + String(e));
  }
}

// ---- Wire buttons on DOM ready ----
document.addEventListener("DOMContentLoaded", () => {
  const btnLinux = document.getElementById("gen-linux");
  const btnWin = document.getElementById("gen-win");
  const btnPing = document.getElementById("ping-host");

  if (btnLinux) {
    btnLinux.addEventListener("click", async () => {
      const sh = makeLinuxMacInstallerSh(LINUX_MAC_HOST_PATH);
      await downloadText("rit-install-linux-mac.sh", "text/x-sh", sh);
    });
  }

  if (btnWin) {
    btnWin.addEventListener("click", async () => {
      const ps1 = makeWindowsInstallerPs1(WIN_HOST_PATH);
      await downloadText("rit-install-windows.ps1", "text/plain", ps1);
    });
  }

  if (btnPing) {
    btnPing.addEventListener("click", pingHost);
  }
});

