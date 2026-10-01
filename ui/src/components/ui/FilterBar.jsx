/**
 * Filter bar.
 *
 * Every control is a labelled form field rather than a bare `<select>`, so
 * screen readers announce what the dropdown filters by, and the layout stays
 * aligned across pages that use different combinations of filters.
 */
export function FilterBar({ children, actions = null }) {
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      {children}
      {actions ? <div className="filter-bar__spacer">{actions}</div> : null}
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options, id, anyLabel = "All" }) {
  const controlId = id ?? `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="field">
      <label className="field__label" htmlFor={controlId}>{label}</label>
      <select
        id={controlId}
        className="select"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => {
          const optionValue = typeof option === "string" ? option : option.value;
          const optionLabel = typeof option === "string" ? option : option.label;
          return (
            <option key={optionValue} value={optionValue}>{optionLabel}</option>
          );
        })}
      </select>
    </div>
  );
}
