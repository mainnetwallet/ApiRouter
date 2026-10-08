/**
 * Inline SVG icon set.
 *
 * Vendored rather than pulled from an icon package: the panel needs about
 * thirty glyphs, and shipping a dependency for that would be a poor trade in a
 * project that otherwise has three. Every icon is a 24x24 stroke path drawn
 * with `currentColor`, so it inherits text colour and needs no per-use styling.
 *
 * Icons are decorative by default (`aria-hidden`); the surrounding control is
 * expected to carry the accessible name.
 */

const PATHS = {
  dashboard: ["M3 3h8v8H3z", "M13 3h8v5h-8z", "M13 12h8v9h-8z", "M3 15h8v6H3z"],
  server: [
    "M3 4h18v6H3z", "M3 14h18v6H3z",
    "M7 7h.01", "M7 17h.01"
  ],
  box: ["M21 8l-9-5-9 5 9 5 9-5z", "M3 8v8l9 5 9-5V8", "M12 13v8"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  route: ["M6 3v12", "M6 21a3 3 0 100-6 3 3 0 000 6z", "M18 9a3 3 0 100-6 3 3 0 000 6z", "M18 9v3a4 4 0 01-4 4H9"],
  layers: ["M12 2l9 5-9 5-9-5 9-5z", "M3 12l9 5 9-5", "M3 17l9 5 9-5"],
  terminal: ["M4 4h16v16H4z", "M8 9l3 3-3 3", "M13 15h4"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  chart: ["M3 3v18h18", "M7 15l3-4 3 3 4-6"],
  sliders: ["M4 6h10", "M18 6h2", "M4 12h4", "M12 12h8", "M4 18h10", "M18 18h2", "M16 4v4", "M10 10v4", "M16 16v4"],
  cpu: ["M6 6h12v12H6z", "M9 9h6v6H9z", "M9 2v4", "M15 2v4", "M9 18v4", "M15 18v4", "M2 9h4", "M2 15h4", "M18 9h4", "M18 15h4"],
  search: ["M11 19a8 8 0 100-16 8 8 0 000 16z", "M21 21l-4.35-4.35"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  copy: ["M9 9h10v10H9z", "M5 15H4V4h11v1"],
  check: ["M20 6L9 17l-5-5"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"],
  info: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 16v-4", "M12 8h.01"],
  refresh: ["M21 12a9 9 0 11-3-6.7L21 8", "M21 3v5h-5"],
  play: ["M6 4l14 8-14 8V4z"],
  stop: ["M6 6h12v12H6z"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  chevronLeft: ["M15 6l-6 6 6 6"],
  arrowDown: ["M12 5v14", "M19 12l-7 7-7-7"],
  arrowRight: ["M5 12h14", "M12 5l7 7-7 7"],
  menu: ["M3 6h18", "M3 12h18", "M3 18h18"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M5 7l1 13h12l1-13", "M9 7V4h6v3"],
  filter: ["M3 5h18l-7 8v6l-4-2v-4z"],
  sortAsc: ["M7 18V6", "M3 10l4-4 4 4"],
  sortDesc: ["M7 6v12", "M3 14l4 4 4-4"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 018 0v4"],
  key: ["M15 7a4 4 0 11-3.6 5.8L10 14l-1 1H7v2H5v2H2v-3l7.2-7.2A4 4 0 0115 7z", "M16 8h.01"],
  clock: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 7v5l3 2"],
  zap: ["M13 2L4 14h7l-1 8 9-12h-7l1-8z"],
  offline: ["M2 2l20 20", "M8.5 16.5a5 5 0 017 0", "M5 12.9a10 10 0 013-1.9", "M19 12.9a10 10 0 00-2-1.4", "M12 20h.01"],
  sun: ["M12 17a5 5 0 100-10 5 5 0 000 10z", "M12 1v2", "M12 21v2", "M4.2 4.2l1.4 1.4", "M18.4 18.4l1.4 1.4", "M1 12h2", "M21 12h2", "M4.2 19.8l1.4-1.4", "M18.4 5.6l1.4-1.4"],
  moon: ["M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"],
  inbox: ["M3 12h5l2 3h4l2-3h5", "M5 5h14l2 7v7H3v-7z"],
  image: ["M3 5h18v14H3z", "M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z", "M21 16l-5-5L8 19"],
  gauge: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 12l4-4"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  globe: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M3 12h18", "M12 3a14 14 0 010 18 14 14 0 010-18z"],
  undo: ["M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8", "M3 3v5h5"]
};

export function Icon({ name, size = 16, className, title, ...rest }) {
  const paths = PATHS[name];
  if (!paths) return null;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS);
