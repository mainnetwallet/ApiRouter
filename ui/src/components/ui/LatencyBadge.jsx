import { formatLatency } from "../../lib/format.js";

/**
 * Latency with a coarse quality band.
 *
 * The numeric value is always shown next to the colour, so the band is a
 * scanning aid rather than a replacement for the measurement. `null` renders
 * as the shared placeholder — never as 0 ms, which would read as "fast".
 */
function toneFor(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 700) return "var(--ok)";
  if (ms < 3000) return "var(--warn)";
  return "var(--danger)";
}

export function LatencyBadge({ ms }) {
  const color = toneFor(ms);
  const text = formatLatency(ms);

  if (!Number.isFinite(ms)) return <span className="dim mono tabular">{text}</span>;

  return (
    <span className="mono tabular" style={{ color }} title={`${Math.round(ms)} ms`}>
      {text}
    </span>
  );
}
