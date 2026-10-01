import { useCallback, useState } from "react";
import { Icon } from "./Icon.jsx";
import { maskIdentifier } from "../../lib/mask.js";

/**
 * Copy affordance for safe, non-secret identifiers — request ids, model names,
 * target ids. Credentials are excluded by design; use `MaskedValue` for those.
 */
export function CopyableId({ value, head = 10, tail = 0, label = "Copy value", showFull = false }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    const text = String(value ?? "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by permissions policy; the value stays
      // selectable by hand, so this is not worth surfacing as an error.
      setCopied(false);
    }
  }, [value]);

  if (!value) return <span className="dim">—</span>;

  const display = showFull ? String(value) : maskIdentifier(value, { head, tail });

  return (
    <span className="copyable">
      <span className="copyable__value" title={String(value)}>{display}</span>
      <button
        type="button"
        className="copyable__btn"
        onClick={copy}
        aria-label={copied ? "Copied to clipboard" : label}
      >
        <Icon name={copied ? "check" : "copy"} className="copyable__icon" size={12} />
      </button>
    </span>
  );
}
