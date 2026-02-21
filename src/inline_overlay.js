export async function openInlineMirror(pageTabId, targetTermTabId) {
  const base = chrome.runtime.getURL("pages/terminal.html");
  const url = `${base}?mirror=1${targetTermTabId ? `&tabId=${targetTermTabId}` : ""}`;

  // create or update overlay in the page
  await chrome.scripting.executeScript({
    target: { tabId: pageTabId },
    args: [url],
    func: (src) => {
      const ID = "rit-inline-overlay";
      const EXIST = document.getElementById(ID);

      if (EXIST) {
        EXIST.remove();
      }

      const wrap = document.createElement("div");
      wrap.id = ID;
      wrap.style.position = "fixed";
      wrap.style.right = "12px";
      wrap.style.bottom = "12px";
      wrap.style.width = "820px";
      wrap.style.height = "520px";
      wrap.style.zIndex = "2147483647";
      wrap.style.background = "rgba(18, 18, 18, 0.5)";
      wrap.style.border = "1px solid #333";
      wrap.style.borderRadius = "10px";
      wrap.style.boxShadow = "0 8px 35px rgba(0,0,0,0.5)";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.backdropFilter = "blur(2px)";

      wrap.style.resize = "both";
      wrap.style.overflow = "hidden";
      wrap.style.minWidth = "200px";
      wrap.style.minHeight = "36px";

      const header = document.createElement("div");
      header.style.flex = "0 0 auto";
      header.style.height = "36px";
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.padding = "0 10px";
      header.style.background = "rgba(32,32,32,0.95)";
      header.style.borderBottom = "1px solid #2a2a2a";
      header.style.cursor = "move";

      const title = document.createElement("div");
      title.textContent = "Run in Terminal";
      title.style.font = "12px system-ui, sans-serif";
      title.style.color = "#ddd";

      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "8px";

      const btnMin = document.createElement("button");
      btnMin.textContent = "min";
      btnMin.style.font = "11px system-ui,sans-serif";
      btnMin.style.color = "#ddd";
      btnMin.style.background = "transparent";
      btnMin.style.border = "1px solid #444";
      btnMin.style.borderRadius = "6px";
      btnMin.style.padding = "2px 6px";

      const btnClose = document.createElement("button");
      btnClose.textContent = "close";
      btnClose.style.font = "11px system-ui,sans-serif";
      btnClose.style.color = "#ddd";
      btnClose.style.background = "transparent";
      btnClose.style.border = "1px solid #444";
      btnClose.style.borderRadius = "6px";
      btnClose.style.padding = "2px 6px";

      const btnsFrag = document.createDocumentFragment();
      btnsFrag.appendChild(btnMin);
      btnsFrag.appendChild(btnClose);
      btns.appendChild(btnsFrag);
      header.appendChild(title);
      header.appendChild(btns);

      const content = document.createElement("div");
      content.style.flex = "1 1 auto";
      content.style.position = "relative";

      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.style.position = "absolute";
      iframe.style.inset = "0";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.referrerPolicy = "no-referrer";

      content.appendChild(iframe);
      wrap.appendChild(header);
      wrap.appendChild(content);
      document.documentElement.appendChild(wrap);

      const px = (v) => (typeof v === "number" ? v : parseFloat(v) || 0);
      const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

      let isMin = false;
      let lastBottom = px(wrap.style.bottom);
      let lastRight = px(wrap.style.right);
      let lastHeight = px(wrap.style.height);
      let lastWidth = px(wrap.style.width);

      // update last size when user resizes (only when not minimized)
      const ro = new ResizeObserver(() => {
        if (isMin) return;
        const rect = wrap.getBoundingClientRect();
        lastHeight = rect.height;
        lastWidth = rect.width;

        // keep it fully on-screen if window shrinks during resize
        const maxBottom = Math.max(0, window.innerHeight - rect.height);
        const maxRight = Math.max(0, window.innerWidth - rect.width);
        wrap.style.bottom = clamp(px(wrap.style.bottom), 0, maxBottom) + "px";
        wrap.style.right = clamp(px(wrap.style.right), 0, maxRight) + "px";
      });
      ro.observe(wrap);

      btnMin.addEventListener("click", () => {
        if (!isMin) {
          const rect = wrap.getBoundingClientRect();
          lastBottom = px(wrap.style.bottom);
          lastRight = px(wrap.style.right);
          lastHeight = rect.height;
          lastWidth = rect.width;

          content.style.display = "none";
          wrap.style.height = header.offsetHeight + "px";
          wrap.style.resize = "none";
          wrap.style.bottom = "0px";
          isMin = true;
        } else {
          content.style.display = "block";
          wrap.style.height = lastHeight + "px";
          wrap.style.resize = "both";
          // clamp restore in case viewport changed
          const maxBottom = Math.max(0, window.innerHeight - lastHeight);
          const maxRight = Math.max(0, window.innerWidth - lastWidth);
          wrap.style.bottom = clamp(lastBottom, 0, maxBottom) + "px";
          wrap.style.right = clamp(lastRight, 0, maxRight) + "px";
          isMin = false;
        }
      });

      btnClose.addEventListener("click", () => {
        wrap.remove();
      });

      let drag = null;
      header.addEventListener("mousedown", (e) => {
        drag = {
          x: e.clientX,
          y: e.clientY,
          right: px(wrap.style.right),
          bottom: px(wrap.style.bottom),
        };
        e.preventDefault();
      });

      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;

        const rect = wrap.getBoundingClientRect();
        const maxRight = Math.max(0, window.innerWidth - rect.width);
        const maxBottom = Math.max(0, window.innerHeight - rect.height);

        const newRight = clamp(drag.right - dx, 0, maxRight);
        const newBottom = clamp(drag.bottom - dy, 0, maxBottom);

        wrap.style.right = newRight + "px";
        wrap.style.bottom = newBottom + "px";
      });

      window.addEventListener("mouseup", () => {
        if (drag) {
          lastRight = px(wrap.style.right);
          lastBottom = px(wrap.style.bottom);
        }
        drag = null;
      });

      // keep overlay in bounds if window resizes
      window.addEventListener("resize", () => {
        const rect = wrap.getBoundingClientRect();
        const maxRight = Math.max(0, window.innerWidth - rect.width);
        const maxBottom = Math.max(0, window.innerHeight - rect.height);
        wrap.style.right = clamp(px(wrap.style.right), 0, maxRight) + "px";
        wrap.style.bottom = clamp(px(wrap.style.bottom), 0, maxBottom) + "px";
      });

    }
  });
}

