// Open Options
document.getElementById("open-settings")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Ensure the iframe points to mirror mode
const frame = document.getElementById("terminal-frame");
if (frame && (!frame.src || !frame.src.includes("mirror=1"))) {
  frame.src = chrome.runtime.getURL("pages/terminal.html?mirror=1");
}

// Focus helper -> focuses iframe and asks the inner page to focus xterm
function focusTerminalIframe(retries = 10) {
  if (!frame) return;

  try {
    // focus the iframe element itself
    frame.focus();

    // focus the iframe window if available
    if (frame.contentWindow) {
      frame.contentWindow.focus();
      // ask the inner page to focus xterm
      frame.contentWindow.postMessage({ type: "rit.focus" }, "*");
    }
  } catch (e) {
    // swallow errors and retry
  }

  // retry a few times in case load is still in progress
  if (retries > 0) {
    setTimeout(() => focusTerminalIframe(retries - 1), 50);
  }
}

// Focus when the iframe finishes loading
frame?.addEventListener("load", () => {
  focusTerminalIframe();
});

// Also try right away when the popup opens
focusTerminalIframe();

