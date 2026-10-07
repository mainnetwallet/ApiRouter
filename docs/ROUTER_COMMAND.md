# Router Command

`Router` is one convenient, cross-platform way to run MultiAI Router in
production: it builds the control panel once, starts the gateway, tells you the
URL, and (only on a desktop) can open it for you. It works the same on Windows,
Linux, a Linux VPS over SSH, and macOS.

| Command | What it is |
| --- | --- |
| `Router` | Convenient production launcher. Checks Node/npm, installs dependencies if they are missing, builds the UI **once**, starts the gateway, prints the URL. |
| `npm start` | Canonical production npm command: `npm run ui:build && node src/server.js`. Use it from inside the checkout, in scripts and in process managers. |
| `npm run dev` | Development mode: gateway with restart-on-change plus the Vite dev server with hot reload. Not for production. |

`Router` does **not** call `npm start` (that would work, but the UI could not be
built exactly once while the launcher also reports readiness), and it **never**
starts the Vite dev server. It runs the same two steps `npm start` does.

Prerequisites on every platform: **Node.js 20 or newer** (npm is included) and a
`.env` file in the checkout (`cp .env.example .env`, then add your provider keys).

## Windows

### Install

From PowerShell, inside the checkout (once):

```powershell
.\scripts\install-router.ps1
```

This writes a small `Router.cmd` shim into `%USERPROFILE%\bin` (added to your user
`PATH`) that calls `bin\Router.cmd` in the checkout. Open a **new** PowerShell or
CMD window afterwards. Without installing, you can always run `.\bin\Router.cmd`.

### Run

```powershell
Router
```

Works the same in PowerShell and CMD. On a desktop the control panel opens in
your browser once the gateway is ready; pass `--no-open` to skip that.

### Custom PORT

Set `PORT` in `.env` (default `9999`), or for one run:

```powershell
$env:PORT = 8080; Router        # PowerShell
set PORT=8080 && Router         :: CMD
```

### Stop

`Ctrl + C`. In CMD, Windows may ask `Terminate batch job (Y/N)?`; answer `Y`.
The gateway shuts down on its own first.

## Linux

### Install

From the checkout, once. No root needed:

```bash
./scripts/install-router.sh
```

This creates a symlink `~/.local/bin/Router` to `bin/Router`. If `~/.local/bin` is
not on your `PATH` the installer prints the exact line to add (for example
`export PATH="$HOME/.local/bin:$PATH"` in `~/.profile`); it never edits your shell
startup files itself. Without installing, run `./bin/Router` from the checkout.

Other targets: `./scripts/install-router.sh --prefix /some/dir`, and
`./scripts/install-router.sh --uninstall` removes the link.

### Run

```bash
Router
```

From any directory: the launcher finds the checkout through the symlink. It uses
POSIX `sh` only (no Bash needed).

### Custom PORT

```bash
PORT=8080 Router
```

or set `PORT` in `.env`. On Linux and Android (Termux), ports below 1024
need root. The default `9999` is fine; if you set a lower port and see `EACCES`, use a higher one.

### Stop

`Ctrl + C`, or `kill <pid>` (SIGTERM). The launcher passes the signal on, waits
for the gateway to shut down, and exits with the gateway's own exit status.

## Linux VPS

### Install

Same as Linux, over SSH:

```bash
git clone https://github.com/mainnetwallet/MultiAI-Router.git
cd MultiAI-Router
cp .env.example .env && nano .env
./scripts/install-router.sh
```

Optional system-wide command for all users (needs write access to
`/usr/local/bin`, so run it with `sudo`):

```bash
sudo ./scripts/install-router.sh --system
```

### Run

```bash
Router
```

It builds the UI, starts the gateway, prints the URL and stays in the foreground.

### Headless behavior

No browser or desktop is needed or attempted. `Router` only tries to open a
browser when **all** of these hold: a terminal is attached, it is not an SSH
session or CI, a graphical session exists (`DISPLAY`/`WAYLAND_DISPLAY`) and
`xdg-open` is installed. Otherwise it just prints:

```text
MultiAI Router is running:
http://localhost:9999
```

You can force or forbid the attempt with `--open` / `--no-open` or
`MULTIAI_ROUTER_OPEN=1|0`.

### Remote access

By default nothing changes: the gateway keeps whatever `HOST` you configured
(unset means all interfaces, but with no `MULTIAI_ROUTER_API_KEYS` it answers only
requests from the machine itself). The safest way to reach the panel is an SSH
tunnel, which needs no configuration on the server:

```bash
ssh -L 8080:localhost:9999 user@SERVER_IP     # then open http://localhost:8080
```

To serve other machines directly, you must set this up on purpose: choose
`HOST` (for example `0.0.0.0`), set `MULTIAI_ROUTER_API_KEYS`, open the port in the
firewall, then browse to `http://SERVER_IP:PORT`. Prefer a TLS reverse proxy in
front of it for anything on the public internet.

### Security

- `Router` never changes `HOST`; it will not widen exposure to be convenient.
- API keys and `.env` contents are never printed, put on a command line, or placed in URLs.
- With `MULTIAI_ROUTER_API_KEYS` unset, remote clients are refused (including the
  `/api` admin surface). Set it before exposing the port.
- Keep `.env` readable only by the service user (`chmod 600 .env`).

### Stop

`Ctrl + C` in the SSH session, or `kill <pid>` from another one. If the SSH
connection drops, `SIGHUP` also stops the gateway cleanly. To keep it running
after you log out, use a process manager of your choice (for example a systemd
unit or PM2 whose command is `npm start` or the full path to `Router`); none is
required or installed by this project.

## macOS

### Install

From Terminal (zsh or bash), inside the checkout, once:

```bash
./scripts/install-router.sh
```

macOS does not put `~/.local/bin` on `PATH` by default. If the installer says so,
add the line it prints to `~/.zprofile` and open a new Terminal tab.

### Run

```bash
Router
```

The control panel opens in your default browser once the gateway is ready
(`--no-open` to skip). The launcher does not depend on GNU tools.

### Custom PORT

```bash
PORT=8080 Router
```

or set `PORT` in `.env`.

### Stop

`Ctrl + C`.

## How Router Starts

```text
Router
→ locate the checkout (follows symlinks, works from any directory)
→ verify Node.js (>= 20) and npm
→ npm install, only if node_modules is missing the required packages
→ load configuration (.env + environment: the same PORT/HOST rules as the gateway)
→ npm run ui:build        (exactly once; a failure stops here, the gateway never starts)
→ node src/server.js      (production gateway, serves the built panel)
→ when /health answers: print the URL, optionally open the control panel
```

There is a single implementation, `scripts/router.mjs` (helpers in
`scripts/router-lib.mjs`). `bin/Router` (POSIX `sh`) and `bin/Router.cmd` (Windows)
only check that Node exists and run it; the installers only put one of those on your
`PATH`. Press Ctrl+C or send SIGTERM and the launcher stops what it started and exits
with the gateway's exit status (128+n if it was killed by signal n).

## npm commands

```text
npm start          production: npm run ui:build && node src/server.js
npm run dev        development: gateway (restart on change) + Vite hot reload
npm run ui:build   build the control panel into ui/dist (npm start already does this)
```

## Troubleshooting

**Node.js version.** `Router` needs Node.js 20 or newer (`node -v`). Install the current
LTS from https://nodejs.org (or `nvm install --lts`).

**npm install.** If dependencies are missing `Router` runs `npm install` itself. If that
fails (network, permissions), fix the error shown and run `Router` again. To reinstall
cleanly: delete `node_modules` and run `Router`.

**PORT already in use.** The gateway exits with `EADDRINUSE` and `Router` reminds you to
set a different `PORT` in `.env` (or `PORT=8080 Router`). On Linux/macOS find the other
process with `lsof -i :9999`; on Windows, `netstat -ano | findstr :9999`. `EACCES` on Linux
means the port is below 1024: use a higher one.

**HOST configuration.** `HOST` is used exactly as set in `.env`/the environment.
Unset listens on all interfaces; `127.0.0.1` keeps the gateway on this machine. The URL
`Router` prints uses `localhost` for those, and tells you to use `http://SERVER_IP:PORT`
from other machines when `HOST` is not loopback.

**permission denied.** `bin/Router` must be executable: `chmod +x bin/Router`
(a ZIP download or some file systems drop the bit; `git clone` keeps it). If the
installer says it cannot write to the target directory, use the default
`~/.local/bin`, or `sudo` with `--system`.

**command not found.** The installed link directory is not on `PATH`. Add the line the
installer printed, then open a new shell. On Windows open a **new** PowerShell/CMD window
after `install-router.ps1`. Or call `./bin/Router` / `.\bin\Router.cmd` directly.

**browser unavailable.** Nothing is wrong: no desktop browser could be opened (SSH,
no display, no `xdg-open`), so only the URL was printed. Open it yourself, or use an SSH
tunnel from your laptop (see Remote access).

**build failure.** The build output is shown above the `[router]` message, the gateway is
not started and `Router` exits non-zero. Fix the error (often a Node version or a
partial `node_modules`; delete it and retry) and run `Router` again.
