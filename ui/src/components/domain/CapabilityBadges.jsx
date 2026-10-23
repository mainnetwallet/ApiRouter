/**
 * Capability chips for declared model capabilities.
 *
 * Renders each declared capability ID as a chip. Capabilities are explicit
 * names (text_input, image_input, tool_calling, …) — never boolean "text"/"vision"
 * pool membership.
 */
export function CapabilityBadges({ capabilities = [] }) {
  const ids = Array.isArray(capabilities) ? capabilities : [];

  return (
    <div className="row row--wrap" style={{ gap: "var(--sp-1)" }}>
      {ids.map((id) => (
        <span key={id} className="cap-badge cap-badge--declared" title={id}>
          {id}
        </span>
      ))}
      {ids.length === 0 && <span className="cap-badge cap-badge--empty">none declared</span>}
    </div>
  );
}
