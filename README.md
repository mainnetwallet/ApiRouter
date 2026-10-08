# ApiRouter

Multi-provider AI routing gateway with health-based fallback.

## Quick Start & One-Command Startup

### 1. Development Mode (`npm run dev:all`)
Runs both the backend API router (`http://localhost:8788`) and the frontend Vite dev server (`http://localhost:5173`) with live proxying in a single cross-platform command:

```bash
npm install
npm run dev:all
```
- Works identically on **Windows (CMD / PowerShell)** and **Linux / macOS / VPS**.
- Press `Ctrl+C` to cleanly terminate both processes with full process-tree cleanup and zero orphan processes.

### 2. Production / VPS Mode (`npm run start:all`)
Builds the production control panel UI and starts the backend serving everything from port `8788`:

```bash
npm install
npm run start:all
```

---

## Traditional Commands

- `npm start`: Start backend server only (`node src/server.js`)
- `npm run dev`: Start backend server with file watch mode (`node --watch src/server.js`)
- `npm run ui:dev`: Start Vite UI dev server only (`port 5173`)
- `npm run ui:build`: Build production UI assets into `ui/dist`
- `npm run test:all`: Run backend tests and UI tests

---

## Client Integration Guides

- [Claude Code](docs/clients/CLAUDE_CODE.md)
- [Codex](docs/clients/CODEX.md)
- [Qwen Code](docs/clients/QWEN_CODE.md)
- [OpenCode](docs/clients/OPENCODE.md)
- [Generic OpenAI-compatible Clients](docs/clients/GENERIC_OPENAI.md)
- [Other AI Clients](docs/clients/OTHER_CLIENTS.md)
- [All Client Protocols](docs/clients/CLIENTS.md)

