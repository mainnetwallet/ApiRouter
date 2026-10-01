export function LoadingSkeleton({ variant = "text", count = 1, width = null }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={`skeleton skeleton--${variant}`}
          style={width ? { width } : undefined}
        />
      ))}
    </>
  );
}

/** Shaped like the metric grid, so the layout does not jump when data lands. */
export function MetricSkeleton({ count = 8 }) {
  return (
    <div className="metrics" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton--metric" />
      ))}
    </div>
  );
}

/** Shaped like a table body. */
export function TableSkeleton({ rows = 8, label = "Loading data" }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton--row" style={{ opacity: 1 - index * 0.07 }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Spinner({ label = "Loading" }) {
  return <span className="spinner" role="status" aria-label={label} />;
}
