/**
 * Image attachments for the Playground.
 *
 * Images are read in the browser and sent inline as base64, in whichever shape
 * the chosen client protocol expects (see `buildRequestBody`). Nothing is
 * uploaded anywhere else.
 *
 * The limits keep a request well under the gateway's body cap
 * (MAX_REQUEST_BODY_MB, 32 MB by default): base64 inflates data by about a
 * third, so 4 images of at most 5 MB each stay near 27 MB.
 */

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = Object.freeze([
  "image/png", "image/jpeg", "image/webp", "image/gif"
]);

let counter = 0;

/** `data:image/png;base64,AAAA` -> `{ mimeType, data }`, or null when malformed. */
export function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(value ?? ""));
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}

/** Why a file cannot be attached, or null when it can. */
export function imageProblem(file, currentCount = 0) {
  if (!file) return "No file selected";
  if (currentCount >= MAX_IMAGES) return `At most ${MAX_IMAGES} images per message`;
  const type = String(file.type ?? "").toLowerCase();
  if (!ACCEPTED_IMAGE_TYPES.includes(type)) return `${file.name || "File"} is not a PNG, JPEG, WebP or GIF image`;
  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name || "Image"} is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`;
  }
  return null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

/**
 * Read a File into an attachment: `{ id, name, mimeType, data, dataUrl, size }`.
 * `data` is the bare base64 payload; `dataUrl` is for the thumbnail preview.
 */
export async function readImageFile(file) {
  const dataUrl = await readAsDataUrl(file);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error(`Could not read ${file.name || "the image"}`);
  counter += 1;
  return {
    id: `img-${Date.now()}-${counter}`,
    name: file.name || "pasted-image",
    mimeType: ACCEPTED_IMAGE_TYPES.includes(parsed.mimeType) ? parsed.mimeType : file.type,
    data: parsed.data,
    dataUrl,
    size: file.size
  };
}
