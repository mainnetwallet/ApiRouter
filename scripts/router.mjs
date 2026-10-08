import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BACKEND_PORT = 8788;
const FRONTEND_PORT = 5173;

async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  setTimeout(() => {
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    spawn(command, args, { stdio: "ignore" }).on("error", () => {});
  }, 2000);
}

async function main() {
  process.chdir(REPO_ROOT);
  const isProd = process.argv.includes("--prod") || process.argv.includes("-p");

  const backendInUse = await checkPort(BACKEND_PORT);
  if (backendInUse) {
    console.error(`[ApiRouter] Error: Port ${BACKEND_PORT} is already in use.`);
    process.exit(1);
  }
  if (!isProd) {
    const frontendInUse = await checkPort(FRONTEND_PORT);
    if (frontendInUse) {
      console.error(`[ApiRouter] Error: Port ${FRONTEND_PORT} is already in use.`);
      process.exit(1);
    }
  }

  // Dependencies: use npm executable directly (works cross-platform)
  if (!fs.existsSync("node_modules")) {
    console.log("[ApiRouter] Installing dependencies...");
    await new Promise((resolve, reject) => {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npmCmd, ["install"], { stdio: "inherit", shell: false });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("npm install failed")));
    });
  }

  const scriptPath = path.join("scripts", isProd ? "start-all.mjs" : "dev-all.mjs");
  const url = isProd ? `http://localhost:${BACKEND_PORT}` : `http://localhost:${FRONTEND_PORT}`;

  console.log(`[ApiRouter] Launching in ${isProd ? "Production" : "Development"} mode...`);
  openBrowser(url);

  const child = spawn(process.execPath, [scriptPath], {
    stdio: "inherit"
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  ["SIGINT", "SIGTERM"].forEach((sig) => {
    process.on(sig, () => {
      child.kill(sig);
    });
  });
}

main().catch((err) => {
  console.error("[ApiRouter] Fatal error:", err);
  process.exit(1);
});



