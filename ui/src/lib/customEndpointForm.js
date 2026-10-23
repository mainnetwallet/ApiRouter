import { splitList } from "../api/customEndpoints.js";

/**
 * The Custom Endpoints form, as plain functions so they can be tested without a
 * DOM.
 */

export const EMPTY_FORM = {
  name: "", baseUrl: "", protocol: "openai-chat", models: "", keys: "", replaceKeys: false
};

export function formFromEndpoint(endpoint) {
  if (!endpoint) return { ...EMPTY_FORM };
  return {
    ...EMPTY_FORM,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    protocol: endpoint.protocol,
    models: (endpoint.models ?? []).join("\n")
  };
}

/** The first thing wrong with the form, or null. `isNew` is true when adding, false when editing. */
export function formProblem(form, isNew) {
  const models = splitList(form.models);
  const keys = splitList(form.keys);
  if (!form.name.trim()) return "Enter a name.";
  if (!form.baseUrl.trim()) return "Enter a base URL.";
  if (models.length === 0) return "Add at least one model.";
  if (isNew && models.length > 0 && keys.length === 0) return "Add at least one API key.";
  if (form.replaceKeys && keys.length === 0) return "Enter the new keys, or untick Replace.";
  return null;
}

export function createBody(form) {
  return {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models),
    apiKeys: splitList(form.keys)
  };
}

export function updateBody(form) {
  const keys = splitList(form.keys);
  const patch = {
    name: form.name,
    baseUrl: form.baseUrl,
    protocol: form.protocol,
    models: splitList(form.models)
  };
  if (keys.length > 0) patch[form.replaceKeys ? "apiKeys" : "addApiKeys"] = keys;
  return patch;
}
