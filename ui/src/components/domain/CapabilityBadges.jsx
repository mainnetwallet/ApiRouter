import { describeCapabilities } from "../../lib/pools.js";

/**
 * ✓/✗ badges for the two pool capabilities.
 *
 * Labels come from `describeCapabilities`, so a provider that cannot serve a
 * pool reads "No vision" / "No text" rather than a row of zeros. Each badge
 * carries both a mark and the word, so capability is never color-only.
 */
export function CapabilityBadges({ capabilities }) {
  const described = describeCapabilities(capabilities);

  return (
    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
      <span className={`cap-badge cap-badge--text${described.text.configured ? " is-on" : " is-off"}`}>
        <span aria-hidden="true">{described.text.mark}</span> {described.text.label}
      </span>
      <span className={`cap-badge cap-badge--vision${described.vision.configured ? " is-on" : " is-off"}`}>
        <span aria-hidden="true">{described.vision.mark}</span> {described.vision.label}
      </span>
    </div>
  );
}
