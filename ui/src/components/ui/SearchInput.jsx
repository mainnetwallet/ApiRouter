import { Icon } from "./Icon.jsx";

export function SearchInput({ value, onChange, placeholder = "Search…", label = "Search", id }) {
  return (
    <div className="search">
      <Icon name="search" className="search__icon" size={13} />
      <input
        id={id}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="search__clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </div>
  );
}
