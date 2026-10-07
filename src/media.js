import { UnsupportedMediaError } from "./bridge-errors.js";
import { fetchRemoteImage } from "./remote-media.js";

/**
 * Media helpers shared by every protocol bridge.
 *
 * A bridge turns a client's multimodal request into the shape a provider accepts.
 * The rule for all of them: an attachment is either carried across or the request
 * is refused with a 4xx that says why. Nothing is dropped, and nothing is
 * replaced by a "[image]" placeholder.
 */

const DATA_URL = /^data:([^;,]+)((?:;[^;,=]+=[^;,]*)*);base64,(.*)$/is;

/** `data:image/png;base64,AAAA` → `{ mimeType, data }`, or null when it is not a base64 data URL. */
export function parseDataUrl(value) {
  const match = DATA_URL.exec(String(value ?? ""));
  if (!match || !match[3]) return null;
  return { mimeType: match[1].toLowerCase(), data: match[3] };
}

export const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ""));

/**
 * The inline Gemini part for an image reference that is either a data URL or a
 * remote URL already fetched into `media` (a Map of url → { mimeType, data }).
 * Throws when the reference is something this router cannot turn into bytes.
 */
export function inlineImagePart(reference, media, what = "image") {
  const url = String(reference ?? "");
  const data = parseDataUrl(url);
  if (data) return { inlineData: { mimeType: data.mimeType, data: data.data } };
  if (isHttpUrl(url)) {
    const fetched = media instanceof Map ? media.get(url) : null;
    if (!fetched) {
      throw new UnsupportedMediaError(`Remote ${what} URLs must be fetched before translation; this one was not`, "image_not_resolved");
    }
    return { inlineData: { mimeType: fetched.mimeType, data: fetched.data } };
  }
  throw new UnsupportedMediaError(`This ${what} reference cannot be forwarded to the selected provider`, "unsupported_image_source");
}

const imageUrlOf = (part) => {
  const value = part?.image_url ?? part?.url;
  return typeof value === "string" ? value : value?.url || "";
};

function* walkParts(content) {
  if (typeof content === "string" || content === null || content === undefined) return;
  for (const part of Array.isArray(content) ? content : [content]) {
    if (part && typeof part === "object") yield part;
  }
}

/**
 * Every remote (http/https) image URL in the request that has to become inline
 * data before it can be sent to a Gemini provider. Returned in first-seen order,
 * without duplicates.
 */
export function collectRemoteImageUrls(protocol, body) {
  const found = new Set();
  const add = (url) => { if (isHttpUrl(url)) found.add(String(url)); };

  const visitAnthropic = (content) => {
    for (const part of walkParts(content)) {
      if (part.type === "image" && part.source?.type === "url") add(part.source.url);
      if (part.type === "tool_result") visitAnthropic(part.content);
    }
  };
  const visitChat = (content) => {
    for (const part of walkParts(content)) if (part.type === "image_url") add(imageUrlOf(part));
  };
  const visitResponses = (content) => {
    for (const part of walkParts(content)) if (part.type === "input_image") add(imageUrlOf(part));
  };

  if (protocol === "anthropic") {
    for (const message of Array.isArray(body?.messages) ? body.messages : []) visitAnthropic(message?.content);
    visitAnthropic(body?.system);
  } else if (protocol === "openai-chat") {
    for (const message of Array.isArray(body?.messages) ? body.messages : []) visitChat(message?.content);
  } else if (protocol === "openai-responses") {
    for (const item of Array.isArray(body?.input) ? body.input : []) {
      if (item?.type === "input_image") add(imageUrlOf(item));
      visitResponses(item?.content);
      visitResponses(item?.output);
    }
  }
  return [...found];
}

/**
 * Per-request resolver. The first call for a body downloads its remote images
 * (once, even if several targets are tried); later calls reuse the result.
 */
export function createMediaResolver({ fetchImage = fetchRemoteImage, options = {} } = {}) {
  const cache = new Map();   // url -> Promise<{ mimeType, data }>
  return {
    async resolve(protocol, body, { signal } = {}) {
      const urls = collectRemoteImageUrls(protocol, body);
      const resolved = new Map();
      for (const url of urls) {
        if (!cache.has(url)) cache.set(url, fetchImage(url, { ...options, signal }));
        try {
          resolved.set(url, await cache.get(url));
        } catch (error) {
          // A failed download is not cached: another target (or the client's
          // retry) deserves a fresh attempt.
          cache.delete(url);
          throw error;
        }
      }
      return resolved;
    }
  };
}
