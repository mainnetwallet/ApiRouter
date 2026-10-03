/**
 * Routing-pool badge.
 *
 * TEXT / VISION is identity, not health, so this is deliberately not a
 * StatusBadge tone: it uses the pool accent classes (text = cyan/blue,
 * vision = purple) and always renders the pool name as its label, so the pool
 * is never conveyed by colour alone.
 */
export function PoolBadge({ pool, children }) {
  const normalized = pool === "vision" ? "vision" : "text";

  return (
    <span className={`pool-badge pool-badge--${normalized}`}>
      {children ?? normalized.toUpperCase()}
    </span>
  );
}
