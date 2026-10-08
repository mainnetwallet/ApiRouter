import { spawn } from "node:child_process";
import net from "node:net";

const BACKEND_PORT = 8788;
const FRONTEND_PORT = 5173;

async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true)); // in use
    server.once("listening", () => {
      server.close(() => resolve(false)); // free
    });
    server.listen(port, "127.0.0.1");
  });
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) return;

  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function main() {
  const backendInUse = await checkPort(BACKEND_PORT);
  if (backendInUse) {
    console.error(`[ApiRouter] Error: Port ${BACKEND_PORT} is already in use. Please stop the existing process or service.`);
    process.exit(1);
  }

  const frontendInUse = await checkPort(FRONTEND_PORT);
  if (frontendInUse) {
    console.error(`[ApiRouter] Error: Port ${FRONTEND_PORT} is already in use. Please stop the existing process or service.`);
    process.exit(1);
  }

  console.log(`[ApiRouter] Starting development environment...`);
  console.log(`[ApiRouter] Backend: http://localhost:${BACKEND_PORT}`);
  console.log(`[ApiRouter] Frontend: http://localhost:${FRONTEND_PORT}`);

  const children = [];
  let isShuttingDown = false;
  let exitCodeToUse = 0;

  function spawnService(name, command, args, colorPrefix) {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, FORCE_COLOR: "1" }
    });

    child.stdout.on("data", (data) => {
      const lines = data.toString().trimEnd().split(/\r?\n/);
      for (const line of lines) {
        console.log(`${colorPrefix}[${name}]${"\x1b[0m"} ${line}`);
      }
    });

    child.stderr.on("data", (data) => {
      const lines = data.toString().trimEnd().split(/\r?\n/);
      for (const line of lines) {
        console.error(`${colorPrefix}[${name}]${"\x1b[0m"} ${line}`);
      }
    });

    child.on("error", (err) => {
      console.error(`[ApiRouter] Process ${name} failed to start:`, err.message);
      if (!isShuttingDown) {
        exitCodeToUse = 1;
        shutdown(1);
      }
    });

    child.on("exit", (code, signal) => {
      if (isShuttingDown) return;
      console.log(`[ApiRouter] Process ${name} exited unexpectedly (code ${code}, signal ${signal})`);
      exitCodeToUse = code !== null && code !== 0 ? code : 1;
      shutdown(exitCodeToUse);
    });

    children.push(child);
    return child;
  }

  function shutdown(code = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[ApiRouter] Shutting down development servers...`);

    for (const child of children) {
      killProcessTree(child);
    }

    setTimeout(() => {
      // Force kill fallback if needed
      for (const child of children) {
        try {
          if (child.pid) {
            if (process.platform === "win32") {
              spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
            } else {
              process.kill(-child.pid, "SIGKILL");
            }
          }
        } catch {
          // ignore
        }
      }
      process.exit(code);
    }, 1000);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Start Backend: node --watch src/server.js
  spawnService("Backend", process.execPath, ["--watch", "src/server.js"], "\x1b[36m");

  // Start Frontend: node node_modules/vite/bin/vite.js --config ui/vite.config.js
  spawnService("Frontend", process.execPath, ["node_modules/vite/bin/vite.js", "--config", "ui/vite.config.js"], "\x1b[35m");
}

main().catch((err) => {
  console.error("[ApiRouter] Fatal error in dev-all:", err);
  process.exit(1);
});

