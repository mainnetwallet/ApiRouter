import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { UnsupportedMediaError } from "./bridge-errors.js";

/**
 * Fetching a client-supplied image URL so it can be sent to a provider that only
 * accepts inline data (Gemini `generateContent`).
 *
 * The URL is attacker-controlled input, so this is a hardened client rather than
 * a bare `fetch`:
 *   - https only (http is opt-in), no credentials in the URL;
 *   - every address the hostname resolves to is checked, and the check is done
 *     in the socket's own `lookup`, so DNS rebinding cannot swap the address
 *     between validation and connection;
 *   - private, loopback, link-local (cloud metadata), CGNAT, multicast and other
 *     reserved ranges are refused;
 *   - redirects are followed by hand, at most MAX_REDIRECTS, and every hop is
 *     validated again from scratch;
 *   - a hard size cap and timeout, and the payload must be an image.
 */

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64]]) {
  blocked.addSubnet(net6, prefix, "ipv6");
}

/** Is this resolved address one a server-side fetch must never connect to? */
export function isBlockedAddress(address) {
  const value = String(address || "");
  const family = net.isIP(value);
  if (family === 0) return true;
  if (family === 6) {
    // ::ffff:a.b.c.d is an IPv4 address wearing an IPv6 prefix.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(value, "ipv6");
  }
  return blocked.check(value, "ipv4");
}

const refuse = (message, code = "invalid_image_url") => new UnsupportedMediaError(message, code);

/** Validate a URL's shape before any network I/O. Returns the parsed URL. */
export function validateRemoteUrl(raw, { allowHttp = false, allowPrivateNetwork = false } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { throw refuse("Image URL is not a valid URL"); }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw refuse("Image URL must use https");
  }
  if (url.username || url.password) throw refuse("Image URL must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw refuse("Image URL has no host");
  if (!allowPrivateNetwork && net.isIP(host) && isBlockedAddress(host)) {
    throw refuse("Image URL points at a non-public address");
  }
  return url;
}

function safeLookup(allowPrivateNetwork) {
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const wantAll = typeof options === "object" && options?.all === true;
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return done(error);
      if (!addresses.length) return done(new Error("hostname did not resolve"));
      if (!allowPrivateNetwork && addresses.some((entry) => isBlockedAddress(entry.address))) {
        return done(Object.assign(new Error("Image URL resolves to a non-public address"), { code: "BLOCKED_ADDRESS" }));
      }
      if (wantAll) return done(null, addresses);
      return done(null, addresses[0].address, addresses[0].family);
    });
  };
}

function requestOnce(url, { allowPrivateNetwork, maxBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      headers: { accept: "image/*", "user-agent": "multi-ai-router-image-fetch" },
      lookup: safeLookup(allowPrivateNetwork),
      timeout: timeoutMs,
      signal
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirect: String(response.headers.location) });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(refuse(`Image URL answered HTTP ${status}`, "image_fetch_failed"));
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        return reject(refuse("Image is larger than the allowed size", "image_too_large"));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(refuse("Image is larger than the allowed size", "image_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: String(response.headers["content-type"] || "") }));
      response.on("error", () => reject(refuse("Image download failed", "image_fetch_failed")));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.on("error", (error) => {
      if (error instanceof UnsupportedMediaError) return reject(error);
      if (error?.code === "BLOCKED_ADDRESS") return reject(refuse("Image URL resolves to a non-public address"));
      if (error?.name === "AbortError") return reject(error);
      reject(refuse("Image URL could not be fetched", "image_fetch_failed"));
    });
    request.end();
  });
}

/** Where a redirect leads, validated exactly like a URL a client supplied. */
export function nextRedirectUrl(current, location, { allowHttp = false, allowPrivateNetwork = false } = {}) {
  let next;
  try { next = new URL(String(location), current); } catch { throw refuse("Image URL redirected to an invalid location"); }
  return validateRemoteUrl(next.href, { allowHttp, allowPrivateNetwork });
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && /^GIF8[79]a/.test(buffer.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Download an image and return `{ mimeType, data }` (base64), or throw an
 * UnsupportedMediaError (HTTP 400) explaining why it cannot be carried.
 */
export async function fetchRemoteImage(rawUrl, options = {}) {
  const {
    allowHttp = false,
    allowPrivateNetwork = false,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal
  } = options;

  let url = validateRemoteUrl(rawUrl, { allowHttp, allowPrivateNetwork });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(url, { allowPrivateNetwork, maxBytes, timeoutMs, signal });
    if (result.redirect) {
      if (hop === MAX_REDIRECTS) throw refuse("Image URL redirected too many times", "image_fetch_failed");
      // The destination is untrusted again: shape, scheme, credentials and the
      // resolved address are all re-validated before anything is requested.
      url = nextRedirectUrl(url, result.redirect, { allowHttp, allowPrivateNetwork });
      continue;
    }
    const sniffed = sniffMime(result.body);
    const declared = result.contentType.split(";")[0].trim().toLowerCase();
    const mimeType = sniffed || (IMAGE_MIME.test(declared) ? declared : null);
    if (!mimeType) throw refuse("Image URL did not return an image", "invalid_image_url");
    if (result.body.length === 0) throw refuse("Image URL returned an empty body", "invalid_image_url");
    return { mimeType, data: result.body.toString("base64") };
  }
  throw refuse("Image URL could not be fetched", "image_fetch_failed");
}
