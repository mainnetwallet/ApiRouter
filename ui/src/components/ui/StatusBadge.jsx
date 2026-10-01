/**
 * Tone-driven badge.
 *
 * `tone` uses the shared vocabulary (ok / warn / danger / info / neutral), so
 * status colour is assigned in one place rather than improvised per page.
 * Colour is never the only signal — the text label always says what the state
 * is, which is what makes the table readable without colour vision.
 */
export function StatusBadge({ tone = "neutral", children, pulse = false, dot = true, title }) {
  return (
    <span className={`badge badge--${tone}${pulse ? " badge--pulse" : ""}`} title={title}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
