#!/usr/bin/env node
/**
 * Live Logs demo.
 *
 * Boots the real router against scripted mock providers (no real AI provider is
 * contacted, and the keys below are fake) and keeps sending traffic, so the
 * Control Panel's Live Logs page has real events to show: plain successes,
 * 429 -> next-key fallbacks, and requests where every target fails.
 *
 *   npm run ui:build
 *   npm run demo:live-logs
 *
 * then open the printed URL at /live-logs. Ctrl+C stops everything.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const dist = fileURLToPath(new URL("../ui/dist/index.html", import.meta.url));
if (!existsSync(dist)) {
  console.error("Control Panel is not built. Run `npm run ui:build` first.");
  process.exit(1);
}

const INTERVAL_MS = Number(process.env.DEMO_INTERVAL_MS || 1800);

// A key that gets a retryable error enters a 15 minute cooldown, so each 429
// below retires one Gemini key. Plenty of keys keep the demo producing
// fallbacks for a few minutes rather than running dry after one.
const GEMINI_KEYS = Array.from({ length: 12 }, (_, i) => `demo-gemini-key-${i}`);

let geminiCalls = 0;
const gemini = await startMockUpstream(() => {
  geminiCalls += 1;
  return geminiCalls % 3 === 1
    ? { status: 429, body: { error: { message: "Resource exhausted: rate limited" } } }
    : { status: 200, body: { candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 42 } } };
});

let groqCalls = 0;
const groq = await startMockUpstream(() => {
  groqCalls += 1;
  // One early failure so an OpenAI-style request also shows a key 0 -> key 1 hop.
  return groqCalls === 2
    ? { status: 503, body: { error: { message: "upstream unavailable" } } }
    : { status: 200, body: { choices: [{ finish_reason: "stop" }], usage: { total_tokens: 128 } } };
});

const router = await startRouter({
  GEMINI_API_KEYS: GEMINI_KEYS.join(","),
  GEMINI_MODELS: "gemini-3.7-flash",
  GEMINI_BASE_URL: gemini.baseUrl,
  GROQ_API_KEYS: "demo-groq-key-a,demo-groq-key-b",
  GROQ_MODELS: "llama-3.3-70b",
  GROQ_BASE_URL: groq.baseUrl
});

console.log(`Demo router running.\n  Live Logs: ${router.baseUrl}/live-logs\nSending a request every ${INTERVAL_MS} ms. Ctrl+C to stop.`);

const requests = [
  () => router.request("/v1beta/models/gemini-3.7-flash:generateContent",
    postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })),
  () => router.request("/v1/chat/completions",
    postJson({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] })),
  () => router.request("/v1beta/models/gemini-3.7-flash:generateContent",
    postJson({ contents: [{ role: "user", parts: [{ text: "again" }] }] }))
];

let n = 0;
const timer = setInterval(() => {
  requests[n++ % requests.length]().then((res) => res.text()).catch(() => {});
}, INTERVAL_MS);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await router.close();
  await gemini.close();
  await groq.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
