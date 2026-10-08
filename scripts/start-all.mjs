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

async function main() {
  const portInUse = await checkPort(PORT);
  if (portInUse) {
    console.error(`[ApiRouter] Error: Port ${PORT} is already in use. Please stop the existing process or service.`);
    process.exit(1);
  }

  console.log(`[ApiRouter] Building production UI...`);
  const buildChild = spawn("npm", ["run", "ui:build"], {
    stdio: "inherit",
    shell: true
  });

  buildChild.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[ApiRouter] UI build failed with code ${code}`);
      process.exit(code || 1);
    }

    console.log(`[ApiRouter] Starting production server on http://localhost:${PORT}...`);
    const serverChild = spawn("node", ["src/server.js"], {
      stdio: "inherit",
      shell: true
    });

    serverChild.on("exit", (code, signal) => {
      process.exit(code !== null && code !== 0 ? code : 0);
    });

    process.on("SIGINT", () => {
      serverChild.kill("SIGINT");
    });
    process.on("SIGTERM", () => {
      serverChild.kill("SIGTERM");
    });
  });
}

main().catch((err) => {
  console.error("[ApiRouter] Fatal error in start-all:", err);
  process.exit(1);
});

