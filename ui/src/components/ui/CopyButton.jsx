import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.jsx";

/** Clipboard write with a textarea fallback for contexts that deny the async API. */
export async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Button that copies text produced by `getText()` at click time (so it always
 * copies what is on screen now). Shows "Copied" briefly, "Failed" if blocked.
 */
export function CopyButton({ getText, label = "Copy", disabled = false, className = "btn", title }) {
  const [state, setState] = useState("idle");
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    const text = String(getText?.() ?? "");
    if (!text) return;
    const ok = await writeClipboard(text);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }, [getText]);

  return (
    <button type="button" className={className} onClick={copy} disabled={disabled} title={title} aria-live="polite">
      <Icon name={state === "copied" ? "check" : "copy"} className="btn__icon" size={12} />
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}
