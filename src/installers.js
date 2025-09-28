// src/installers.js
import { DEFAULTS } from "./defaults.js";

const GITHUB_OWNER = "TadaEXE";
const GITHUB_REPO = "run-in-terminal-ext";
const GITHUB_REF = "main";

const MANIFEST = chrome.runtime.getManifest();
export const HOST_NAME = (DEFAULTS && DEFAULTS.nativeHostName) || "com.tada.run_in_terminal";
const GECKO_ID =
  MANIFEST?.browser_specific_settings?.gecko?.id || "run-in-terminal@tada.com";
const EXT_ID = chrome.runtime.id;
const CHROME_ORIGIN = `chrome-extension://${EXT_ID}/`;
const RAW_PY_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_REF}/native-host/run_in_terminal.py`;

function detectBrand() {
  const ua = navigator.userAgent || "";
  if (/Firefox\/\d+/i.test(ua)) return "firefox";
  if (/Edg\//i.test(ua)) return "edge";
  if (/OPR\//i.test(ua)) return "opera";
  if (/Vivaldi/i.test(ua)) return "vivaldi";
  if (/Brave/i.test(ua)) return "brave";
  if (/Chromium/i.test(ua)) return "chromium";
  return "chrome";
}

function buildFirefoxHostJson(hostPathLiteral) {
  return JSON.stringify({
    name: HOST_NAME,
    description: "Run in Terminal native host",
    path: hostPathLiteral,
    type: "stdio",
    allowed_extensions: [GECKO_ID],
  }, null, 2);
}

function buildChromeHostJson(hostPathLiteral) {
  return JSON.stringify({
    name: HOST_NAME,
    description: "Run in Terminal native host",
    path: hostPathLiteral,
    type: "stdio",
    allowed_origins: [CHROME_ORIGIN],
  }, null, 2);
}

// Linux/macOS installer for current brand; detects apt/snap/flatpak on Linux
function makeLinuxMacInstallerSh() {
  const brand = detectBrand(); // firefox, chrome, chromium, brave, edge, opera, vivaldi
  const jsonTemplate =
    brand === "firefox"
      ? buildFirefoxHostJson("$HOST_PATH")
      : buildChromeHostJson("$HOST_PATH");
  const title = brand.charAt(0).toUpperCase() + brand.slice(1);

  return `#!/usr/bin/env bash
set -euo pipefail

RAW_URL="${RAW_PY_URL}"
BRAND="${brand}"

OS="$(uname -s || echo unknown)"
if [[ "$OS" == "Darwin" ]]; then
  INSTALL_DIR="$HOME/Library/Application Support/RunInTerminal/native-host"
  case "$BRAND" in
    firefox) HOST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
    chrome) HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    chromium) HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
    brave) HOST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
    edge) HOST_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
    opera) HOST_DIR="$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts" ;;
    vivaldi) HOST_DIR="$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" ;;
    *) HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  esac
else
  INSTALL_DIR="$HOME/.local/share/run-in-terminal/native-host"

  detect_linux_host_dir() {
    case "$1" in
      firefox)
        if command -v flatpak >/dev/null 2>&1 && flatpak info org.mozilla.firefox >/dev/null 2>&1; then
          echo "$HOME/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts"; return
        fi
        if command -v snap >/dev/null 2>&1 && snap list firefox >/dev/null 2>&1; then
          echo "$HOME/snap/firefox/common/.mozilla/native-messaging-hosts"; return
        fi
        echo "$HOME/.mozilla/native-messaging-hosts"; return
        ;;
      chromium)
        if command -v flatpak >/dev/null 2>&1 && flatpak info org.chromium.Chromium >/dev/null 2>&1; then
          echo "$HOME/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts"; return
        fi
        if command -v snap >/dev/null 2>&1 && snap list chromium >/dev/null 2>&1; then
          echo "$HOME/snap/chromium/common/.config/chromium/NativeMessagingHosts"; return
        fi
        echo "$HOME/.config/chromium/NativeMessagingHosts"; return
        ;;
      chrome)
        echo "$HOME/.config/google-chrome/NativeMessagingHosts"; return
        ;;
      brave)
        if command -v flatpak >/dev/null 2>&1 && flatpak info com.brave.Browser >/dev/null 2>&1; then
          echo "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; return
        fi
        if command -v snap >/dev/null 2>&1 && snap list brave >/dev/null 2>&1; then
          echo "$HOME/snap/brave/common/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; return
        fi
        echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; return
        ;;
      edge)
        echo "$HOME/.config/microsoft-edge/NativeMessagingHosts"; return
        ;;
      opera)
        if command -v flatpak >/dev/null 2>&1 && flatpak info com.opera.Opera >/dev/null 2>&1; then
          echo "$HOME/.var/app/com.opera.Opera/config/opera/NativeMessagingHosts"; return
        fi
        if command -v snap >/dev/null 2>&1 && snap list opera >/dev/null 2>&1; then
          echo "$HOME/snap/opera/common/.config/opera/NativeMessagingHosts"; return
        fi
        echo "$HOME/.config/opera/NativeMessagingHosts"; return
        ;;
      vivaldi)
        if command -v flatpak >/dev/null 2>&1 && flatpak info com.vivaldi.Vivaldi >/dev/null 2>&1; then
          echo "$HOME/.var/app/com.vivaldi.Vivaldi/config/vivaldi/NativeMessagingHosts"; return
        fi
        echo "$HOME/.config/vivaldi/NativeMessagingHosts"; return
        ;;
      *)
        echo "$HOME/.config/google-chrome/NativeMessagingHosts"; return
        ;;
    esac
  }

  HOST_DIR="$(detect_linux_host_dir "$BRAND")"
fi

HOST_PATH="$INSTALL_DIR/run_in_terminal.py"
HOST_JSON="$HOST_DIR/${HOST_NAME}.json"

mkdir -p "$INSTALL_DIR" "$HOST_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RAW_URL" -o "$HOST_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$HOST_PATH" "$RAW_URL"
else
  echo "no curl/wget" >&2; exit 1
fi

if [[ ! -s "$HOST_PATH" ]]; then echo "download failed" >&2; exit 1; fi
chmod +x "$HOST_PATH" || true

cat > "$HOST_JSON" <<JSON
${jsonTemplate}
JSON
chmod 644 "$HOST_JSON" || true

echo "Installed for ${title}"
echo "Host: $HOST_PATH"
echo "JSON: $HOST_JSON"
`;
}

// Windows installer for current brand (HKCU)
function makeWindowsInstallerPs1() {
  const brand = detectBrand();

  const regKey = ({
    firefox: `HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`,
    chrome: `HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    chromium: `HKCU:\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    brave: `HKCU:\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
    edge: `HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    opera: `HKCU:\\Software\\Opera Software\\NativeMessagingHosts\\${HOST_NAME}`,
    vivaldi: `HKCU:\\Software\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`,
  }[brand]) || `HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

  const jsonTemplate =
    brand === "firefox"
      ? buildFirefoxHostJson("$HostPath")
      : buildChromeHostJson("$HostPath");

  const title = brand.charAt(0).toUpperCase() + brand.slice(1);

  return `#ps1
$ErrorActionPreference = "Stop"
$RawUrl    = "${RAW_PY_URL}"
$Base      = Join-Path $env:LOCALAPPDATA "RunInTerminal"
$Install   = Join-Path $Base "native-host"
$HostPath  = Join-Path $Install "run_in_terminal.py"
$HostJson  = Join-Path $Base "${HOST_NAME}.${"${title}".ToLower()}.json"

New-Item -ItemType Directory -Force -Path $Install | Out-Null

try {
  $wc = New-Object System.Net.WebClient
  $wc.DownloadFile($RawUrl, $HostPath)
} catch {
  try { Invoke-WebRequest -Uri $RawUrl -OutFile $HostPath -UseBasicParsing } catch { throw }
}
if (!(Test-Path $HostPath) -or ((Get-Item $HostPath).Length -lt 100)) { throw "download failed" }

@"${jsonTemplate}"@ | Set-Content -Path $HostJson -Encoding UTF8 -NoNewline

New-Item -Path "${regKey}" -Force | Out-Null
Set-ItemProperty -Path "${regKey}" -Name "(default)" -Value $HostJson

Write-Host "Installed for ${title}"
Write-Host "Host: $HostPath"
Write-Host "JSON: $HostJson"
`;
}

async function downloadText(filename, mime, text) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "overwrite" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btnLinux = document.getElementById("gen-linux");
  const btnWin = document.getElementById("gen-win");

  const brand = detectBrand();
  const title = brand === "firefox" ? "firefox" : brand;

  if (btnLinux) {
    btnLinux.addEventListener("click", async () => {
      const sh = makeLinuxMacInstallerSh();
      await downloadText(`rit-install-${title}-linux-mac.sh`, "text/x-sh", sh);
    });
  }
  if (btnWin) {
    btnWin.addEventListener("click", async () => {
      const ps1 = makeWindowsInstallerPs1();
      await downloadText(`rit-install-${title}-windows.ps1`, "text/plain", ps1);
    });
  }
});

