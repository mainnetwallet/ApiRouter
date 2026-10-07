/**
 * Pure helpers for the `Router` launcher (scripts/router.mjs).
 *
 * Nothing here spawns a process or touches the network, so every decision the
 * launcher makes (which URL to print, whether a browser may be opened, how an
 * exit status is reported) is unit-testable on any platform.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MIN_NODE = 20;

/** Minimum Node major from package.json `engines.node` (`>=20`), so it is declared once. */
export function minNodeMajor(pkg) {
  const match = /(\d+)/.exec(String(pkg?.engines?.node ?? ""));
  return match ? Number(match[1]) : DEFAULT_MIN_NODE;
}

/** True when the dependencies the Router needs are not installed yet. */
export function needsInstall(root) {
  return !["vite", "dotenv"].every((name) => existsSync(path.join(root, "node_modules", name, "package.json")));
}

export const USAGE = `Usage: Router [options]

Builds the control panel once, then starts the production gateway.

Options:
  --no-open   never open a browser (just print the URL)
  --open      try to open a browser when a desktop is available
  -h, --help  show this help

Environment:
  PORT / HOST                 same settings as .env and \`npm start\`
  MULTIAI_ROUTER_OPEN=0|1     same as --no-open / --open
`;

/** `open`: true (--open), false (--no-open) or "auto". Unknown arguments are an error. */
export function parseArgs(argv) {
  const result = { open: "auto", help: false, error: null };
  for (const arg of argv) {
    if (arg === "--no-open") result.open = false;
    else if (arg === "--open") result.open = true;
    else if (arg === "-h" || arg === "--help") result.help = true;
    else { result.error = `Unknown option: ${arg}`; break; }
  }
  return result;
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export const isWildcardHost = (host) => WILDCARD_HOSTS.has(String(host ?? "").trim());
export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(String(host ?? "").trim().toLowerCase());

const bracket = (host) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** Host to put in the URL a person types: wildcard and loopback binds read as `localhost`. */
export function displayHost(host) {
  const value = String(host ?? "").trim();
  if (isWildcardHost(value) || value === "127.0.0.1" || value.toLowerCase() === "localhost") return "localhost";
  return bracket(value);
}

/** Host the launcher itself connects to when it checks readiness. */
export function probeHost(host) {
  const value = String(host ?? "").trim();
  if (isWildcardHost(value)) return "127.0.0.1";
  return bracket(value);
}

export const consoleUrl = (host, port) => `http://${displayHost(host)}:${port}`;
export const probeUrl = (host, port, pathname = "/health") => `http://${probeHost(host)}:${port}${pathname}`;

/** 128 + signal number for a signal death, like a POSIX shell reports it; otherwise the exit code. */
export function exitCodeFor(code, signal, signals) {
  if (typeof code === "number") return code;
  if (signal) return 128 + (signals?.[signal] ?? 1);
  return 1;
}

/** Resolve an executable on PATH, or null. Never throws. */
export function which(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

const OFF = new Set(["0", "false", "no", "off"]);
const ON = new Set(["1", "true", "yes", "on"]);

/**
 * The command that opens `url` in a browser, or null when this machine should
 * only print the URL. Opening is a convenience and must never be the reason a
 * headless machine fails, so every doubt answers null:
 *
 *  - explicit opt-out (`--no-open`, MULTIAI_ROUTER_OPEN=0) always wins;
 *  - without an explicit opt-in, no browser from SSH sessions, CI, or when
 *    stdout is not a terminal (service managers, pipes, log files);
 *  - Linux needs a display AND `xdg-open`; macOS needs `open`; Windows uses `start`.
 */
export function browserCommand({ url, open = "auto", platform = process.platform, env = process.env, isTTY = true, find = (name) => which(name, { env, platform }) }) {
  const fromEnv = String(env.MULTIAI_ROUTER_OPEN ?? "").trim().toLowerCase();
  if (open === false || OFF.has(fromEnv)) return null;
  const forced = open === true || ON.has(fromEnv);
  if (!forced) {
    if (!isTTY) return null;
    if (env.CI || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return null;
  }
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return find("open") ? { command: "open", args: [url] } : null;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return find("xdg-open") ? { command: "xdg-open", args: [url] } : null;
}

export function readPackage(root) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}
