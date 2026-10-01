import { useMemo } from "react";
import { Icon } from "./Icon.jsx";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { nextSort, sortAriaValue } from "../../lib/table.js";

/**
 * Generic sortable table.
 *
 * Accessibility notes that are easy to get wrong and expensive to retrofit:
 *   - every header cell is `scope="col"` with a real `aria-sort` value, so a
 *     screen reader announces "sorted ascending" rather than nothing
 *   - sorting is driven by a real button inside the header, so it is reachable
 *     and operable by keyboard without any custom key handling
 *   - a clickable row is still reachable: the row is not a button, it carries a
 *     click handler *and* the row content includes its own interactive control
 *     where one is needed
 *
 * `virtual` is opt-in. Windowing only helps past a few hundred rows, and it
 * costs the ability to `Ctrl+F` the whole table, so it is not the default.
 */
export function DataTable({
  columns,
  rows,
  caption,
  sort = null,
  onSortChange = null,
  rowKey,
  onRowClick = null,
  isSelected = null,
  emptyState = null,
  compact = false,
  virtual = null,
  footer = null
}) {
  const columnMap = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.key, column])),
    [columns]
  );

  const window = useVirtualList(virtual ? rows : [], virtual ?? {});

  const headers = (
    <tr>
      {columns.map((column) => {
        const isSorted = sort?.key === column.key;
        return (
          <th
            key={column.key}
            scope="col"
            aria-sort={column.sortable ? sortAriaValue(sort, column.key) : undefined}
            style={column.width ? { width: column.width } : undefined}
            className={column.align === "right" ? "right" : undefined}
          >
            {column.sortable && onSortChange ? (
              <button type="button" onClick={() => onSortChange(nextSort(sort, column.key))}>
                {column.header}
                {isSorted ? (
                  <Icon name={sort.direction === "asc" ? "sortAsc" : "sortDesc"} size={11} />
                ) : null}
                {isSorted ? (
                  <span className="sr-only">
                    {sort.direction === "asc" ? ", sorted ascending" : ", sorted descending"}
                  </span>
                ) : null}
              </button>
            ) : (
              column.header
            )}
          </th>
        );
      })}
    </tr>
  );

  const renderRow = (row, index) => {
    const selected = isSelected ? isSelected(row) : false;
    return (
      <tr
        key={rowKey(row, index)}
        data-clickable={onRowClick ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        aria-selected={isSelected ? selected : undefined}
      >
        {columns.map((column) => (
          <td key={column.key} className={cellClass(column)}>
            {column.render ? column.render(row) : column.get(row)}
          </td>
        ))}
      </tr>
    );
  };

  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <table className={`table${compact ? " table--compact" : ""}`}>
          {caption ? <caption>{caption}</caption> : null}
          <thead>{headers}</thead>
        </table>
        {emptyState ?? (
          <div className="state">
            <div className="state__title">No rows</div>
          </div>
        )}
      </div>
    );
  }

  if (virtual && window.enabled) {
    return (
      <>
        <div
          className="table-wrap"
          style={{ maxHeight: window.viewportHeight, overflowY: "auto" }}
          onScroll={window.onScroll}
          tabIndex={0}
          role="region"
          aria-label={caption ?? "Virtualised table"}
        >
          <table className={`table table--virtual${compact ? " table--compact" : ""}`}>
            {caption ? <caption>{caption}</caption> : null}
            <thead>{headers}</thead>
            <tbody>
              <tr aria-hidden="true" style={{ height: window.paddingTop }} />
              {window.rows.map((row, index) => renderRow(row, window.start + index))}
              <tr aria-hidden="true" style={{ height: window.paddingBottom }} />
            </tbody>
          </table>
        </div>
        {footer}
      </>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <table className={`table${compact ? " table--compact" : ""}`}>
          {caption ? <caption>{caption}</caption> : null}
          <thead>{headers}</thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="table-empty">
                <td colSpan={columns.length}>No rows</td>
              </tr>
            ) : (
              rows.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
      {footer}
    </>
  );
}

function cellClass(column) {
  const classes = [];
  if (column.align === "right") classes.push("table__num");
  if (column.align === "actions") classes.push("table__actions");
  if (column.mono) classes.push("mono");
  if (column.className) classes.push(column.className);
  return classes.join(" ") || undefined;
}
