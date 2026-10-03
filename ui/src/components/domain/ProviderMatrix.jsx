import { useMemo, useState } from "react";
import { FilterBar } from "../ui/FilterBar.jsx";
import { SearchInput } from "../ui/SearchInput.jsx";
import { HealthBadge } from "../ui/HealthBadge.jsx";
import { LatencyBadge } from "../ui/LatencyBadge.jsx";
import { PoolBadge } from "../ui/PoolBadge.jsx";
import { Icon } from "../ui/Icon.jsx";
import { EmptyState } from "../ui/EmptyState.jsx";
import { TableSkeleton } from "../ui/LoadingSkeleton.jsx";
import { CapabilityBadges } from "./CapabilityBadges.jsx";
import { useDebouncedValue } from "../../hooks/useDebounce.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { nextSort, sortAriaValue, sortRows } from "../../lib/table.js";
import {
  MATRIX_FILTERS, POOL_GROUP_LABEL, POOL_VIEWS, filterMatrixRows
} from "../../lib/pools.js";
import { providerLabel } from "../../lib/format.js";

/**
 * The unified Provider Matrix (spec §2 / §3 / §12 / §13).
 *
 * One row per provider, with a TEXT block and a VISION block of metrics. The
 * two blocks are the same provider's *separate* pool configuration: Gemini's
 * text models/targets/keys/health/latency and its vision ones sit side by side
 * and are never added together. A pool the provider cannot serve reads
 * "No vision" / "No text" rather than a row of zeros.
 *
 * Sorting is applied here via `sortRows` (DataTable only reports header clicks),
 * and the grouped header is rendered by this table directly, so the shared
 * DataTable and the rest of the app are untouched.
 */

const POOL_COLUMNS = Object.freeze([
  { key: "models", header: "Models", align: "right" },
  { key: "targets", header: "Targets", align: "right" },
  { key: "keys", header: "Keys", align: "right" },
  { key: "health", header: "Health" },
  { key: "latency", header: "Latency", align: "right" }
]);

// Worst-first when sorted ascending, which is how an operator scans a status column.
const HEALTH_RANK = { failed: 0, cooldown: 1, unknown: 2, healthy: 3 };

const recordOf = (row, pool) => (pool === "vision" ? row?.vision : row?.text);

export function ProviderMatrix({ rows = [], loading = false, onSelect, selectedId = null }) {
  const isMobile = useIsMobile();
  const [filterKey, setFilterKey] = useState("all");
  const [poolView, setPoolView] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });
  const debouncedSearch = useDebouncedValue(search);

  const showText = poolView !== "vision";
  const showVision = poolView !== "text";

  const sortColumns = useMemo(() => {
    const columns = { provider: (row) => row.id };
    for (const pool of ["text", "vision"]) {
      columns[`${pool}.models`] = (row) => recordOf(row, pool)?.modelCount ?? null;
      columns[`${pool}.targets`] = (row) => recordOf(row, pool)?.health?.targets ?? null;
      columns[`${pool}.keys`] = (row) => recordOf(row, pool)?.keyCount ?? null;
      columns[`${pool}.health`] = (row) => HEALTH_RANK[recordOf(row, pool)?.health?.status] ?? null;
      columns[`${pool}.latency`] = (row) => recordOf(row, pool)?.health?.latencyMs ?? null;
    }
    return columns;
  }, []);

  const visible = useMemo(
    () => sortRows(
      filterMatrixRows(rows, { filterKey, search: debouncedSearch, pool: poolView }),
      sortColumns,
      sort
    ),
    [rows, filterKey, debouncedSearch, poolView, sortColumns, sort]
  );

  const onSort = (key) => setSort((current) => nextSort(current, key));

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Provider Matrix</span>
        <div className="panel__actions">
          <span className="tiny dim mono">{visible.length} providers</span>
        </div>
      </div>

      <FilterBar
        actions={<span className="tiny dim">Models, targets and keys are shown per pool</span>}
      >
        <div className="filter-bar__search">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search providers, models…"
            label="Search providers"
          />
        </div>

        <div className="field">
          <span className="field__label">Pool view</span>
          <div className="chips" role="group" aria-label="Pool view">
            {POOL_VIEWS.map((view) => (
              <button
                key={view.key}
                type="button"
                className={`chip${poolView === view.key ? " is-active" : ""}${view.key === "vision" ? " chip--vision" : view.key === "text" ? " chip--text" : ""}`}
                aria-pressed={poolView === view.key}
                onClick={() => setPoolView(view.key)}
              >
                {view.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field__label">Capability</span>
          <div className="chips" role="group" aria-label="Capability filter">
            {MATRIX_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className={`chip${filterKey === filter.key ? " is-active" : ""}`}
                aria-pressed={filterKey === filter.key}
                onClick={() => setFilterKey(filter.key)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </FilterBar>

      {loading && rows.length === 0 ? (
        <div className="panel__body"><TableSkeleton rows={8} label="Loading provider matrix" /></div>
      ) : visible.length === 0 ? (
        <EmptyState title="No providers match" icon="filter">
          {rows.length === 0
            ? "No provider is configured with keys, models and a base URL yet."
            : "Adjust the pool view, capability filter or search to see providers."}
        </EmptyState>
      ) : isMobile ? (
        <MatrixCards rows={visible} showText={showText} showVision={showVision} onSelect={onSelect} />
      ) : (
        <div className="table-wrap">
          <table className="table table--compact matrix-table">
            <caption className="sr-only">
              Provider capability matrix: separate text and vision models, targets, keys, health and latency
            </caption>
            <thead>
              <tr>
                <HeaderCell
                  rowSpan={2}
                  label="Provider"
                  columnKey="provider"
                  sort={sort}
                  onSort={onSort}
                  className="matrix-table__provider-col"
                />
                {showText ? (
                  <th scope="colgroup" colSpan={POOL_COLUMNS.length} className="matrix-table__group matrix-table__group--text">
                    {POOL_GROUP_LABEL.text}
                  </th>
                ) : null}
                {showVision ? (
                  <th scope="colgroup" colSpan={POOL_COLUMNS.length} className="matrix-table__group matrix-table__group--vision">
                    {POOL_GROUP_LABEL.vision}
                  </th>
                ) : null}
              </tr>
              <tr>
                {showText ? POOL_COLUMNS.map((column) => (
                  <HeaderCell
                    key={`text.${column.key}`}
                    label={column.header}
                    columnKey={`text.${column.key}`}
                    sort={sort}
                    onSort={onSort}
                    align={column.align}
                    className="matrix-table__sub matrix-table__sub--text"
                  />
                )) : null}
                {showVision ? POOL_COLUMNS.map((column) => (
                  <HeaderCell
                    key={`vision.${column.key}`}
                    label={column.header}
                    columnKey={`vision.${column.key}`}
                    sort={sort}
                    onSort={onSort}
                    align={column.align}
                    className="matrix-table__sub matrix-table__sub--vision"
                  />
                )) : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  data-clickable={onSelect ? "true" : undefined}
                  data-selected={selectedId === row.id ? "true" : undefined}
                  onClick={onSelect ? () => onSelect(row) : undefined}
                >
                  <td className="matrix-table__provider">
                    <button
                      type="button"
                      className="matrix-table__provider-name"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect?.(row);
                      }}
                    >
                      {providerLabel(row.id)}
                    </button>
                    <CapabilityBadges capabilities={row.capabilities} />
                    {row.text?.envPrefix || row.vision?.envPrefix ? (
                      <span className="tiny dim mono">{row.text?.envPrefix ?? row.vision?.envPrefix}_*</span>
                    ) : null}
                  </td>
                  {showText ? <PoolCells pool="text" row={row} /> : null}
                  {showVision ? <PoolCells pool="vision" row={row} /> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HeaderCell({ label, columnKey, sort, onSort, align, className, rowSpan }) {
  const isSorted = sort?.key === columnKey;
  return (
    <th
      scope="col"
      rowSpan={rowSpan}
      aria-sort={sortAriaValue(sort, columnKey)}
      className={[align === "right" ? "right" : null, className].filter(Boolean).join(" ") || undefined}
    >
      <button type="button" onClick={() => onSort(columnKey)}>
        {label}
        {isSorted ? <Icon name={sort.direction === "asc" ? "sortAsc" : "sortDesc"} size={11} /> : null}
        {isSorted ? (
          <span className="sr-only">
            {sort.direction === "asc" ? ", sorted ascending" : ", sorted descending"}
          </span>
        ) : null}
      </button>
    </th>
  );
}

/** The five metric cells for one pool, or a single "unsupported" cell. */
function PoolCells({ pool, row }) {
  const record = recordOf(row, pool);
  const capable = (pool === "vision" ? row.capabilities?.vision : row.capabilities?.text) === true;

  if (!capable || !record) {
    return (
      <td colSpan={POOL_COLUMNS.length} className="matrix-table__unsupported">
        <span className="dim">{pool === "vision" ? "No vision" : "No text"}</span>
      </td>
    );
  }

  return (
    <>
      <td className="table__num mono">{record.modelCount}</td>
      <td className="table__num mono">{record.health.targets}</td>
      <td className="table__num mono">{record.keyCount}</td>
      <td><HealthBadge status={record.health.status} /></td>
      <td className="table__num"><LatencyBadge ms={record.health.latencyMs} /></td>
    </>
  );
}

/** Mobile: one card per provider, each still showing both pools separately. */
function MatrixCards({ rows, showText, showVision, onSelect }) {
  return (
    <div className="matrix-cards">
      {rows.map((row) => (
        <button key={row.id} type="button" className="matrix-card" onClick={() => onSelect?.(row)}>
          <div className="matrix-card__head">
            <span className="matrix-card__name">{providerLabel(row.id)}</span>
            <CapabilityBadges capabilities={row.capabilities} />
          </div>
          <div className="matrix-card__pools">
            {showText ? <PoolCardBlock pool="text" row={row} /> : null}
            {showVision ? <PoolCardBlock pool="vision" row={row} /> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

function PoolCardBlock({ pool, row }) {
  const record = recordOf(row, pool);
  const capable = (pool === "vision" ? row.capabilities?.vision : row.capabilities?.text) === true;

  return (
    <div className={`matrix-card__pool matrix-card__pool--${pool}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <PoolBadge pool={pool} />
        {capable && record ? <HealthBadge status={record.health.status} /> : null}
      </div>
      {capable && record ? (
        <div className="matrix-card__metrics mono tiny">
          <span>{record.modelCount} models</span>
          <span>{record.health.targets} targets</span>
          <span>{record.keyCount} keys</span>
          <span>{record.health.latencyMs === null ? "n/a" : `${Math.round(record.health.latencyMs)} ms`}</span>
        </div>
      ) : (
        <span className="dim small">{pool === "vision" ? "No vision" : "No text"}</span>
      )}
    </div>
  );
}
