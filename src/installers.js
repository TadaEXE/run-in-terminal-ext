import { HOST_NAME } from "./defaults.js";

function downloadText(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}

// Small, cross-platform native host (PTY on Linux/macOS, pywinpty on Windows, pipe fallback otherwise)
const PY_HOST = `#!/usr/bin/env python3
import os, sys, json, struct, threading, base64, subprocess
IS_WIN = (sys.platform == "win32")
def rmsg():
    h=sys.stdin.buffer.read(4)
    if not h: return None
    n=int.from_bytes(h,"little")
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))
def wmsg(o):
    b=json.dumps(o).encode("utf-8")
    sys.stdout.buffer.write(len(b).to_bytes(4,"little"))
    sys.stdout.buffer.write(b); sys.stdout.buffer.flush()
def wdata(bs): wmsg({"type":"data","data_b64":base64.b64encode(bs).decode("ascii")})
class PTY:
    def __init__(s, shell=None, cols=80, rows=24):
        s.shell=shell; s.cols=cols; s.rows=rows
        s.proc=None; s.m=None; s.sl=None; s.t=None
        s.winpty=None; s.winproc=None
    def spawn(s):
        if not s.shell:
            s.shell=(os.environ.get("COMSPEC") or "powershell.exe") if IS_WIN else (os.environ.get("SHELL") or "/bin/bash")
        if IS_WIN:
            try:
                import pywinpty
                s.winpty=pywinpty.PTY(cols=s.cols, rows=s.rows)
                s.winproc=pywinpty.Process(s.winpty, s.shell)
                s.t=threading.Thread(target=s._rwin, daemon=True); s.t.start()
                wmsg({"type":"ready","platform":"win-pty","shell":s.shell}); return
            except Exception:
                s.proc=subprocess.Popen([s.shell], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                s.t=threading.Thread(target=s._rpipe, daemon=True); s.t.start()
                wmsg({"type":"ready","platform":"win-pipe","shell":s.shell}); return
        import pty, fcntl, termios, struct as st
        s.m,s.sl=pty.openpty()
        fcntl.ioctl(s.m, termios.TIOCSWINSZ, st.pack("HHHH", s.rows, s.cols, 0, 0))
        s.proc=subprocess.Popen([s.shell,"-l"], stdin=s.sl, stdout=s.sl, stderr=s.sl, start_new_session=True)
        os.close(s.sl)
        s.t=threading.Thread(target=s._rposix, daemon=True); s.t.start()
        wmsg({"type":"ready","platform":"posix-pty","shell":s.shell})
    def write(s,b):
        try:
            if IS_WIN:
                if s.winpty: s.winpty.write(b.decode("utf-8","ignore"))
                elif s.proc and s.proc.stdin: s.proc.stdin.write(b); s.proc.stdin.flush()
            else: os.write(s.m,b)
        except Exception: pass
    def resize(s,c,r):
        s.cols=int(c); s.rows=int(r)
        try:
            if IS_WIN and s.winpty:
                s.winpty.set_size(s.cols,s.rows)
            else:
                import fcntl, termios, struct as st
                fcntl.ioctl(s.m, termios.TIOCSWINSZ, st.pack("HHHH", s.rows, s.cols, 0, 0))
        except Exception: pass
    def _rposix(s):
        try:
            while True:
                ch=os.read(s.m,8192)
                if not ch: break
                wdata(ch)
        except OSError: pass
        wmsg({"type":"exit","code": s.proc.poll() if s.proc else None})
    def _rpipe(s):
        try:
            while True:
                b=s.proc.stdout.read(8192)
                if not b: break
                wdata(b)
        except Exception: pass
        wmsg({"type":"exit","code": s.proc.poll() if s.proc else None})
    def _rwin(s):
        try:
            while True:
                try:
                    s_=s.winpty.read(8192)
                    if not s_: break
                    wdata(s_.encode("utf-8","ignore"))
                except Exception: break
        except Exception: pass
        wmsg({"type":"exit","code":0})
    def close(s):
        try:
            if IS_WIN:
                if s.winproc: s.winproc.kill()
                if s.proc: s.proc.terminate()
            else:
                if s.proc: s.proc.terminate()
                if s.m: os.close(s.m)
        except Exception: pass
def main():
    p=None
    while True:
        m=rmsg()
        if m is None:
            if p: p.close()
            return
        t=m.get("type")
        if t=="open":
            p=PTY(shell=m.get("shell"), cols=int(m.get("cols",100)), rows=int(m.get("rows",30))); p.spawn()
        elif t=="stdin":
            import base64; d=base64.b64decode(m.get("data_b64","")); p and p.write(d)
        elif t=="resize":
            p and p.resize(int(m.get("cols",100)), int(m.get("rows",30)))
        elif t=="close":
            if p: p.close(); p=None; wmsg({"type":"exit","code":0})
        elif t=="ping":
            wmsg({"type":"pong"})
        else:
            wmsg({"type":"error","message":f"unknown:{t}"})
if __name__=="__main__": main()
`;

function handlePing() {
  chrome.runtime.sendNativeMessage(HOST_NAME, { type: "ping" }, (resp) => {
    alert(resp ? "OK: host reachable" : `Error: ${chrome.runtime.lastError?.message || "no response"}`);
  });
}

async function generateLinuxInstaller() {
  const extId = chrome.runtime.id;
  const mf = chrome.runtime.getManifest();
  const geckoId = mf.browser_specific_settings?.gecko?.id || "{run-in-terminal@TadaEXE.com}";

  const sh = `#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="${HOST_NAME}"
EXT_ID="${extId}"
GECKO_ID="${geckoId}"
HOST_DIR="\\${HOME}/.local/share/run-in-terminal"
HOST_PATH="\\${HOST_DIR}/run_in_terminal.py"

echo "[*] Writing native host to \\${HOST_PATH}"
mkdir -p "\\${HOST_DIR}"
cat > "\\${HOST_PATH}" <<'PY'
${PY_HOST}
PY
chmod +x "\\${HOST_PATH}"

write_manifest_chromium() {
  local base="$1"
  local dir="\\${base}/NativeMessagingHosts"
  mkdir -p "\\${dir}"
  cat > "\\${dir}/\\${HOST_NAME}.json" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Run in Terminal native host",
  "path": "\\${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://\\${EXT_ID}/"]
}
JSON
  echo "  - wrote \\${dir}/\\${HOST_NAME}.json"
}

write_manifest_firefox() {
  local base="$1"
  local dir="\\${base}/native-messaging-hosts"
  mkdir -p "\\${dir}"
  cat > "\\${dir}/\\${HOST_NAME}.json" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Run in Terminal native host",
  "path": "\\${HOST_PATH}",
  "type": "stdio",
  "allowed_extensions": ["\\${GECKO_ID}"]
}
JSON
  echo "  - wrote \\${dir}/\\${HOST_NAME}.json"
}

echo "[*] Installing manifests (best-effort)"
[ -d "\\${HOME}/.config/chromium" ] && write_manifest_chromium "\\${HOME}/.config/chromium"
[ -d "\\${HOME}/.config/google-chrome" ] && write_manifest_chromium "\\${HOME}/.config/google-chrome"
[ -d "\\${HOME}/.var/app/org.chromium.Chromium/config/chromium" ] && write_manifest_chromium "\\${HOME}/.var/app/org.chromium.Chromium/config/chromium"
[ -d "\\${HOME}/.var/app/com.google.Chrome/config/google-chrome" ] && write_manifest_chromium "\\${HOME}/.var/app/com.google.Chrome/config/google-chrome"

write_manifest_firefox "\\${HOME}/.mozilla"
[ -d "\\${HOME}/.var/app/org.mozilla.firefox/.mozilla" ] && write_manifest_firefox "\\${HOME}/.var/app/org.mozilla.firefox/.mozilla"

echo "[*] Done. Reload the extension and try Ping."
`;

  downloadText("install-native-host.sh", "application/x-sh", sh);
}

async function generateWindowsInstaller() {
  const extId = chrome.runtime.id;
  const mf = chrome.runtime.getManifest();
  const geckoId = mf.browser_specific_settings?.gecko?.id || "{run-in-terminal@example.com}";

  const ps1 = `#Requires -Version 5
$ErrorActionPreference = "Stop"
$HostName = "${HOST_NAME}"
$Base = "$env:LOCALAPPDATA\\RunInTerminal"
$HostPath = Join-Path $Base "run_in_terminal.py"
$ExtId = "${extId}"

New-Item -Force -ItemType Directory -Path $Base | Out-Null
@'
${PY_HOST}
'@ | Set-Content -NoNewline -Encoding UTF8 -Path $HostPath

$NMChrome   = Join-Path $env:LOCALAPPDATA "Google\\Chrome\\User Data\\NativeMessagingHosts"
$NMChromium = Join-Path $env:LOCALAPPDATA "Chromium\\User Data\\NativeMessagingHosts"
$NMFirefox  = Join-Path $env:APPDATA      "Mozilla\\NativeMessagingHosts"
New-Item -Force -ItemType Directory -Path $NMChrome, $NMChromium, $NMFirefox | Out-Null

$ManifestChrome = @{
  name = $HostName
  description = "Run in Terminal native host"
  path = $HostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://${extId}/")
} | ConvertTo-Json -Compress

$ManifestChrome | Set-Content -Encoding UTF8 -Path (Join-Path $NMChrome   "$HostName.json")
$ManifestChrome | Set-Content -Encoding UTF8 -Path (Join-Path $NMChromium "$HostName.json")

'{
  "name": "' + $HostName + '",
  "description": "Run in Terminal native host",
  "path": "' + $HostPath.Replace("\\","\\\\") + '",
  "type": "stdio",
  "allowed_extensions": ["${geckoId}"]
}' | Set-Content -Encoding UTF8 -Path (Join-Path $NMFirefox "$HostName.json")

Write-Host "Done. Reload the extension."
`;

  downloadText("install-native-host.ps1", "text/plain", ps1);
}

document.getElementById("ping-host").addEventListener("click", handlePing);
document.getElementById("gen-linux").addEventListener("click", generateLinuxInstaller);
document.getElementById("gen-win").addEventListener("click", generateWindowsInstaller);

