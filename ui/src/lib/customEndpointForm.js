import { splitList } from "../api/customEndpoints.js";

/**
 * The Custom Endpoints form, as plain functions so they can be tested without a
 * DOM. An endpoint serves the text pool and, optionally, the vision pool (image
 * requests). Vision models share the text base URL and keys unless the vision
 * base URL / vision keys are filled in.
 */

export const EMPTY_FORM = {
  name: "", baseUrl: "", protocol: "openai-chat", models: "", keys: "", replaceKeys: false,
  visionModels: "", visionBaseUrl: "", visionKeys: "", replaceVisionKeys: false
};

export function formFromEndpoint(endpoint) {
  if (!endpoint) return { ...EMPTY_FORM };
  return {
    ...EMPTY_FORM,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    protocol: endpoint.protocol,
    models: (endpoint.models ?? []).join("\n"),
    visionModels: (endpoint.visionModels ?? []).join("\n"),
    visionBaseUrl: endpoint.visionBaseUrl ?? ""
  };
}

/** The first thing wrong with the form, or null. `isNew` is true when adding, false when editing. */
export function formProblem(form, isNew) {
  const models = splitList(form.models);
  const visionModels = splitList(form.visionModels);
  const keys = splitList(form.keys);
  const visionKeys = splitList(form.visionKeys);
  if (!form.name.trim()) return "Enter a name.";
  if (!form.baseUrl.trim()) return "Enter a base URL.";
  if (models.length === 0 && visionModels.length === 0) return "Add at least one model (text, vision or both).";
  if (isNew && models.length > 0 && keys.length === 0) return "Add at least one API key.";
  if (isNew && visionModels.length > 0 && keys.length === 0 && visionKeys.length === 0) {
    return "Add vision API keys, or API keys that the vision models can share.";
  }
  if (form.replaceKeys && keys.length === 0) return "Enter the new keys, or untick Replace.";
  if (form.replaceVisionKeys && visionKeys.length === 0) return "Enter the new vision keys, or untick Replace.";
  return null;
}

export function createBody(form) {
  return {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models),
    apiKeys: splitList(form.keys),
    visionModels: splitList(form.visionModels),
    visionBaseUrl: form.visionBaseUrl.trim(),
    visionApiKeys: splitList(form.visionKeys)
  };
}

export function updateBody(form) {
  const keys = splitList(form.keys);
  const visionKeys = splitList(form.visionKeys);
  const patch = {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models),
    visionModels: splitList(form.visionModels),
    // "" clears it: the vision models go back to the text base URL.
    visionBaseUrl: form.visionBaseUrl.trim()
  };
  if (keys.length > 0) patch[form.replaceKeys ? "apiKeys" : "addApiKeys"] = keys;
  if (visionKeys.length > 0) patch[form.replaceVisionKeys ? "visionApiKeys" : "addVisionApiKeys"] = visionKeys;
  return patch;
}

/** "3 keys of their own", or that the vision models use the text keys. */
export function visionSummary(endpoint) {
  const models = endpoint.visionModels ?? [];
  if (models.length === 0) return null;
  const own = endpoint.visionKeyCount ?? 0;
  const keys = own > 0 ? `${own} own key${own === 1 ? "" : "s"}` : "shares the text keys";
  const url = endpoint.visionBaseUrl ? "own base URL" : "text base URL";
  return `${models.length} vision model${models.length === 1 ? "" : "s"} · ${keys} · ${url}`;
}
