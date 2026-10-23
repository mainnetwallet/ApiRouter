/**
 * ✓/✗ badges for the two capability flags.
 *
 * Each badge carries both a mark and the word, so capability is never
 * color-only.
 */
export function CapabilityBadges({ capabilities }) {
  const text = capabilities?.text === true;
  const vision = capabilities?.vision === true;

  return (
    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
      <span className={`cap-badge cap-badge--text${text ? " is-on" : " is-off"}`}>
        <span aria-hidden="true">{text ? "✓" : "✗"}</span> {text ? "Text" : "No text"}
      </span>
      <span className={`cap-badge cap-badge--vision${vision ? " is-on" : " is-off"}`}>
        <span aria-hidden="true">{vision ? "✓" : "✗"}</span> {vision ? "Vision" : "No vision"}
      </span>
    </div>
  );
}
