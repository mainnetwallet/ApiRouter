import { spawn } from "node:child_process";
import net from "node:net";

const PORT = 8788;

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
  const portInUse = await checkPort(PORT);
  if (portInUse) {
    console.error(`[ApiRouter] Error: Port ${PORT} is already in use. Please stop the existing process or service.`);
    process.exit(1);
  }

  console.log(`[ApiRouter] Building production UI...`);
  const buildChild = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "ui/vite.config.js"], {
    stdio: "inherit"
  });

  buildChild.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[ApiRouter] UI build failed with code ${code}`);
      process.exit(code || 1);
    }

    console.log(`[ApiRouter] Starting production server on http://localhost:${PORT}...`);
    const serverChild = spawn(process.execPath, ["src/server.js"], {
      stdio: "inherit",
      detached: process.platform !== "win32"
    });

    let isShuttingDown = false;

    function shutdown(exitCode = 0) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n[ApiRouter] Shutting down production server...`);
      killProcessTree(serverChild);
      setTimeout(() => {
        try {
          if (serverChild.pid) {
            if (process.platform === "win32") {
              spawn("taskkill", ["/pid", String(serverChild.pid), "/t", "/f"], { stdio: "ignore" });
            } else {
              process.kill(-serverChild.pid, "SIGKILL");
            }
          }
        } catch {
          // ignore
        }
        process.exit(exitCode);
      }, 1000);
    }

    serverChild.on("exit", (code, signal) => {
      if (isShuttingDown) return;
      process.exit(code !== null && code !== 0 ? code : 0);
    });

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
  });
}

main().catch((err) => {
  console.error("[ApiRouter] Fatal error in start-all:", err);
  process.exit(1);
});

