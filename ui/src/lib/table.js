/** Sorting, filtering and pagination helpers shared by every table. */

/**
 * Compare two values with a type-aware rule.
 *
 * `null` always sorts last regardless of direction, so "unknown latency" does
 * not masquerade as the fastest target when sorted ascending — a genuine
 * correctness problem for an operations table.
 */
export function compareValues(a, b) {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";

  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);

  const aTime = typeof a === "string" ? Date.parse(a) : NaN;
  const bTime = typeof b === "string" ? Date.parse(b) : NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && a.length > 7 && b.length > 7) {
    return aTime - bTime;
  }

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Sort rows by a named column.
 *
 * `columns` maps a column key to either an accessor or a descriptor
 * `{ get }`. Sorting is stable, so equal rows keep their incoming order and
 * the table does not shuffle between polls.
 */
export function sortRows(rows, columns, sort) {
  if (!sort?.key) return rows;

  const column = columns?.[sort.key];
  const accessor = typeof column === "function" ? column : column?.get;
  if (!accessor) return rows;

  const direction = sort.direction === "desc" ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const result = compareValues(accessor(a.row), accessor(b.row));
      if (result !== 0) return result * direction;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Case-insensitive substring match across the given fields. */
export function matchesSearch(row, term, fields) {
  const needle = String(term ?? "").trim().toLowerCase();
  if (!needle) return true;

  return fields.some((field) => {
    const value = typeof field === "function" ? field(row) : row?.[field];
    return String(value ?? "").toLowerCase().includes(needle);
  });
}

/**
 * Apply a set of `{ field, value }` filters. `null`/`""`/`"all"` mean "no
 * constraint", which is what an unset `<select>` produces.
 */
export function applyFilters(rows, filters) {
  const active = Object.entries(filters ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== "" && value !== "all"
  );

  if (active.length === 0) return rows;

  return rows.filter((row) =>
    active.every(([field, value]) => {
      const actual = row?.[field];
      if (Array.isArray(actual)) return actual.includes(value);
      if (typeof value === "boolean") return Boolean(actual) === value;
      return String(actual ?? "") === String(value);
    })
  );
}

export function paginate(rows, { page = 1, pageSize = 50 } = {}) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * pageSize;

  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    pages,
    pageSize,
    total
  };
}

/** Toggle helper for click-to-sort table headers. */
export function nextSort(current, key) {
  if (current?.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return { key: null, direction: "asc" };
}

export const sortAriaValue = (sort, key) =>
  sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
