import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getFreePort } from "./mock-upstream.js";

const SERVER_PATH = fileURLToPath(new URL("../src/server.js", import.meta.url));

/**
 * Boots a real `src/server.js` process with a controlled environment.
 * No real AI provider is ever contacted.
 */
export async function startRouter(env = {}) {
  const port = await getFreePort();

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      PORT: String(port),
      // Clear every provider so each test fully controls its own config.
      ...clearProviderEnv(),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });

  const exited = new Promise((resolve) => child.once("exit", resolve));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Router did not start.\nstdout: ${stdout}\nstderr: ${stderr}`)),
      10000
    );
    child.stdout.on("data", () => {
      if (stdout.includes("listening")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Router exited early (code ${code}).\nstderr: ${stderr}`));
    });
  });

  const baseUrl = `http://localhost:${port}`;

  // The startup health monitor fires immediately; let it settle so its
  // uniform success marks cannot interleave with a test's assertions.
  await new Promise((resolve) => setTimeout(resolve, 250));

  return {
    port,
    baseUrl,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exited,
    request: (pathname, options) => fetch(baseUrl + pathname, options),
    async close() {
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
}

const PROVIDER_IDS = [
  "AGENTROUTER", "GEMINI", "GROQ", "HUGGINGFACE", "MISTRAL",
  "OPENROUTER", "CEREBRAS", "CLOUDFLARE", "SAMBANOVA", "COHERE", "ZAI", "VERCEL", "OPENCODE", "NVIDIA", "NOUS", "POLLINATIONS", "SILICONFLOW"
];

function clearProviderEnv() {
  const env = {};
  for (const id of PROVIDER_IDS) {
    env[`${id}_API_KEYS`] = "";
    env[`${id}_MODELS`] = "";
    env[`${id}_BASE_URL`] = "";
    for (const name of ["API_KEYS", "MODELS", "BASE_URL", "ACCOUNT_IDS"]) env[`${id}_VISION_${name}`] = "";
  }
  env.MULTIAI_ROUTER_API_KEYS = "";
  env.RETRY_STATUS_CODES = "";
  return env;
}

export function postJson(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
