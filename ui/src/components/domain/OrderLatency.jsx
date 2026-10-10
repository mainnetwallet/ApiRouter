import { LatencyBadge } from "../ui/LatencyBadge.jsx";
import { orderLatencyInfo } from "../../lib/fallbackChain.js";

/**
 * The latency shown next to one planned step, worded by whether latency is what
 * placed that step.
 *
 * One component, used by every screen that lists the planned order, so the
 * wording cannot drift between them. "ordered by latency" appears only for a
 * step whose position latency decided (Automatic, and the health batch of Manual
 * Model Selection); in Fixed Order, in the saved Manual Model Selection steps and
 * for a remembered target the same figure is labelled plainly as "latency".
 *
 * The visible text carries the claim, so it reads the same on touch and with a
 * screen reader; the `title` only adds the source and the reason.
 *
 * `showUnmeasured` keeps the badge for a never-measured model (rendered as the
 * shared placeholder, never as 0 ms) instead of omitting it.
 */
export function OrderLatency({ item, showUnmeasured = false }) {
  const info = orderLatencyInfo(item);
  if (info.ms === null && !showUnmeasured) return null;

  return (
    <span className="order-latency" title={info.title} data-latency-decides-order={info.decides ? "true" : "false"}>
      {info.ms === null ? null : <>{info.label}{" "}</>}
      <LatencyBadge ms={info.ms} />
    </span>
  );
}
