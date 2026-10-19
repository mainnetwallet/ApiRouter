/**
 * Playground chat persistence.
 *
 * The whole conversation is kept in this browser's localStorage so a refresh
 * (or closing the tab) does not lose it. There is no cap on the number of
 * messages; the only limit is the browser's storage quota. If the quota is hit
 * the attached images are dropped from the saved copy first (they are by far
 * the largest part) and the text is kept.
 *
 * Only finished messages are stored. API keys never reach this module: the
 * custom-endpoint key lives in component state only.
 */

export const CHAT_KEY = "apirouter.playground.chat.v1";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const isString = (value) => typeof value === "string";

function cleanImages(images) {
  if (!Array.isArray(images)) return undefined;
  const kept = images
    .filter((image) => image && isString(image.dataUrl))
    .map((image) => ({ id: String(image.id ?? image.name ?? Math.random()), name: String(image.name ?? "image"), dataUrl: image.dataUrl }));
  return kept.length ? kept : undefined;
}

function cleanError(error) {
  if (!error) return null;
  return {
    label: isString(error.label) ? error.label : "Request failed",
    hint: isString(error.hint) ? error.hint : undefined,
    message: isString(error.message) ? error.message : undefined,
    status: Number.isFinite(error.status) ? error.status : undefined
  };
}

/** Reduce a message to what is safe and useful to store. */
function toStored(message, { withImages }) {
  const stored = { id: String(message.id), role: message.role, text: isString(message.text) ? message.text : "" };
  if (message.role === "user" && withImages) {
    const images = cleanImages(message.images);
    if (images) stored.images = images;
  }
  if (message.role === "user" && !withImages && Array.isArray(message.images) && message.images.length) {
    stored.imageCount = message.images.length;
  }
  if (message.role === "assistant" && message.error) stored.error = cleanError(message.error);
  return stored;
}

/** Read the saved chat. Anything malformed is ignored rather than trusted. */
export function loadChat(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(CHAT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message) => message && (message.role === "user" || message.role === "assistant") && isString(message.id))
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: isString(message.text) ? message.text : "",
        ...(message.role === "user" && cleanImages(message.images) ? { images: cleanImages(message.images) } : {}),
        ...(message.role === "user" && Number.isFinite(message.imageCount) ? { imageCount: message.imageCount } : {}),
        ...(message.role === "assistant" && message.error ? { error: cleanError(message.error) } : {}),
        ...(message.role === "assistant" ? { pending: false } : {})
      }));
  } catch {
    return [];
  }
}

/**
 * Save the chat. Returns "saved", "saved-without-images" or "failed".
 * An empty chat removes the key.
 */
export function saveChat(messages, storage = defaultStorage()) {
  if (!storage) return "failed";
  try {
    if (!messages.length) {
      storage.removeItem(CHAT_KEY);
      return "saved";
    }
  } catch {
    return "failed";
  }

  for (const withImages of [true, false]) {
    try {
      storage.setItem(CHAT_KEY, JSON.stringify(messages.map((message) => toStored(message, { withImages }))));
      return withImages ? "saved" : "saved-without-images";
    } catch {
      // Quota exceeded or storage blocked: try again without the images.
    }
  }
  return "failed";
}

export function clearChat(storage = defaultStorage()) {
  try {
    storage?.removeItem(CHAT_KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}
