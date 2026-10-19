import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CUSTOM_PROTOCOLS, PlaygroundError, isBlockedAddress, validateEndpointBaseUrl } from "./custom-playground.js";

/**
 * Saved custom endpoints.
 *
 * The Playground's Custom endpoint mode tests ONE request against any URL and
 * forgets it. This store is the other half: an endpoint the operator chose to
 * keep. A saved endpoint becomes a normal provider (id `custom-<name>`) with its
 * own base URL, one API style, any number of models and any number of keys, so
 * it takes part in the Fallback Chain, health checks, cooldowns and sticky
 * routing exactly like a provider configured through the environment.
 *
 * Keys live in the data file (like the other `data/*.json` state) and are never
 * returned by `describe()`: the control panel only ever sees a key COUNT.
 */

export const CUSTOM_PROVIDER_PREFIX = "custom-";
export const isCustomProviderId = (id) => String(id ?? "").startsWith(CUSTOM_PROVIDER_PREFIX);

export const MAX_ENDPOINTS = 20;
export const MAX_KEYS_PER_ENDPOINT = 50;
export const MAX_MODELS_PER_ENDPOINT = 100;
const MAX_NAME_LENGTH = 60;
const MAX_KEY_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;

const hasControlChars = (text) => /[\u0000-\u001F\u007F]/.test(text);

export class CustomEndpointError extends Error {
  constructor(status, message, type = "invalid_request") {
    super(message);
    this.status = status;
    this.type = type;
  }
}
const bad = (message) => new CustomEndpointError(400, message);

/** Accepts an array or a newline / comma separated string; trims and de-duplicates. */
function toList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function cleanModels(value) {
  const models = toList(value);
  if (models.length === 0) throw bad("At least one model is required");
  if (models.length > MAX_MODELS_PER_ENDPOINT) throw bad(`At most ${MAX_MODELS_PER_ENDPOINT} models per endpoint`);
  for (const model of models) {
    if (model.length > MAX_MODEL_LENGTH || hasControlChars(model)) throw bad("A model id is not valid");
  }
  return models;
}

function cleanKeys(value) {
  const keys = toList(value);
  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH || hasControlChars(key)) throw bad("An API key contains characters that cannot be sent in a header");
  }
  return keys;
}

function cleanName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw bad("Name is required");
  if (name.length > MAX_NAME_LENGTH || hasControlChars(name)) throw bad("Name is not valid");
  return name;
}

function slugify(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "endpoint";
}

/**
 * A server that stores a URL and later calls it is an SSRF primitive, and
 * `/api/*` is open when APIROUTER_API_KEYS is empty. The URL shape is checked by
 * `validateEndpointBaseUrl`; here the host is resolved and refused when any
 * address is private or reserved, unless the operator allowed private hosts.
 */
async function assertPublicHost(baseUrl, { allowPrivateHosts, lookup }) {
  if (allowPrivateHosts) return;
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname) !== 0) return; // IP literals were judged by validateEndpointBaseUrl
  let addresses;
  try { addresses = await lookup(hostname, { all: true }); }
  catch { throw bad("Could not resolve the host name. Check the base URL."); }
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new PlaygroundError(400, "blocked_host", "That host resolves to a private or reserved address. Set PLAYGROUND_ALLOW_PRIVATE_HOSTS=1 on the gateway to use a local endpoint.");
  }
}

export class CustomEndpointStore {
  /**
   * @param file                path to persist to ("" / null keeps it in memory, as in tests)
   * @param allowPrivateHosts   allow private / loopback hosts (Ollama, LM Studio, a LAN gateway)
   * @param lookup              DNS lookup, injectable for tests
   */
  constructor({ file = "", allowPrivateHosts = false, lookup = dns.lookup } = {}) {
    this.file = file || "";
    this.allowPrivateHosts = allowPrivateHosts;
    this.lookup = lookup;
    this.endpoints = [];
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) {
      console.warn(`custom endpoints: ignoring unreadable ${this.file} (${error.message})`);
      return;
    }
    const seen = new Set();
    for (const entry of Array.isArray(parsed?.endpoints) ? parsed.endpoints : []) {
      try {
        const id = String(entry?.id ?? "");
        if (!isCustomProviderId(id) || seen.has(id)) continue;
        if (!CUSTOM_PROTOCOLS.includes(entry.protocol)) continue;
        const baseUrl = validateEndpointBaseUrl(entry.baseUrl, { allowPrivateHosts: this.allowPrivateHosts });
        this.endpoints.push({
          id,
          name: cleanName(entry.name),
          baseUrl,
          protocol: entry.protocol,
          models: cleanModels(entry.models),
          apiKeys: cleanKeys(entry.apiKeys)
        });
        seen.add(id);
      } catch (error) {
        console.warn(`custom endpoints: skipped an invalid saved endpoint (${error.message})`);
      }
    }
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, endpoints: this.endpoints }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener(this.list());
  }

  /** Full records, keys included. For the router itself — never send these to a client. */
  list() {
    return this.endpoints.map((endpoint) => ({ ...endpoint, models: [...endpoint.models], apiKeys: [...endpoint.apiKeys] }));
  }

  get(id) {
    return this.endpoints.find((endpoint) => endpoint.id === id) ?? null;
  }

  /** What the control panel may see: no key material, only how many keys there are. */
  describe(endpoint) {
    return {
      id: endpoint.id,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      protocol: endpoint.protocol,
      models: [...endpoint.models],
      keyCount: endpoint.apiKeys.length
    };
  }

  describeAll() {
    return this.endpoints.map((endpoint) => this.describe(endpoint));
  }

  uniqueId(name) {
    const base = CUSTOM_PROVIDER_PREFIX + slugify(name);
    let id = base;
    for (let n = 2; this.get(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  async create(input) {
    if (!input || typeof input !== "object") throw bad("Request body must be a JSON object");
    if (this.endpoints.length >= MAX_ENDPOINTS) throw bad(`At most ${MAX_ENDPOINTS} custom endpoints`);
    const name = cleanName(input.name);
    const protocol = String(input.protocol ?? "openai-chat");
    if (!CUSTOM_PROTOCOLS.includes(protocol)) throw bad(`protocol must be one of: ${CUSTOM_PROTOCOLS.join(", ")}`);
    const baseUrl = validateEndpointBaseUrl(input.baseUrl, { allowPrivateHosts: this.allowPrivateHosts });
    await assertPublicHost(baseUrl, this);
    const models = cleanModels(input.models ?? input.model);
    const apiKeys = cleanKeys(input.apiKeys ?? input.apiKey);
    if (apiKeys.length === 0) throw bad("At least one API key is required (for a local model without a key, enter any placeholder such as \"none\")");
    if (apiKeys.length > MAX_KEYS_PER_ENDPOINT) throw bad(`At most ${MAX_KEYS_PER_ENDPOINT} keys per endpoint`);

    const endpoint = { id: this.uniqueId(name), name, baseUrl, protocol, models, apiKeys };
    this.endpoints.push(endpoint);
    try { this.persist(); }
    catch (error) {
      this.endpoints.pop();
      throw new CustomEndpointError(500, "Could not save the custom endpoint", "server_error");
    }
    this.emit();
    return this.describe(endpoint);
  }

  /**
   * Partial update. Omitted fields keep their value. Keys are never echoed back,
   * so the panel changes them with `addApiKeys` (append) or `apiKeys` (replace all).
   */
  async update(id, input) {
    const current = this.get(id);
    if (!current) throw new CustomEndpointError(404, `no custom endpoint "${id}"`, "not_found");
    if (!input || typeof input !== "object") throw bad("Request body must be a JSON object");

    const next = { ...current, models: [...current.models], apiKeys: [...current.apiKeys] };
    if (input.name !== undefined) next.name = cleanName(input.name);
    if (input.protocol !== undefined) {
      if (!CUSTOM_PROTOCOLS.includes(input.protocol)) throw bad(`protocol must be one of: ${CUSTOM_PROTOCOLS.join(", ")}`);
      next.protocol = input.protocol;
    }
    if (input.baseUrl !== undefined) {
      next.baseUrl = validateEndpointBaseUrl(input.baseUrl, { allowPrivateHosts: this.allowPrivateHosts });
      if (next.baseUrl !== current.baseUrl) await assertPublicHost(next.baseUrl, this);
    }
    if (input.models !== undefined) next.models = cleanModels(input.models);
    if (input.apiKeys !== undefined) next.apiKeys = cleanKeys(input.apiKeys);
    if (input.addApiKeys !== undefined) next.apiKeys = [...new Set([...next.apiKeys, ...cleanKeys(input.addApiKeys)])];
    if (next.apiKeys.length === 0) throw bad("At least one API key is required");
    if (next.apiKeys.length > MAX_KEYS_PER_ENDPOINT) throw bad(`At most ${MAX_KEYS_PER_ENDPOINT} keys per endpoint`);

    const index = this.endpoints.indexOf(current);
    this.endpoints[index] = next;
    try { this.persist(); }
    catch {
      this.endpoints[index] = current;
      throw new CustomEndpointError(500, "Could not save the custom endpoint", "server_error");
    }
    this.emit();
    return this.describe(next);
  }

  remove(id) {
    const index = this.endpoints.findIndex((endpoint) => endpoint.id === id);
    if (index < 0) throw new CustomEndpointError(404, `no custom endpoint "${id}"`, "not_found");
    const [removed] = this.endpoints.splice(index, 1);
    try { this.persist(); }
    catch {
      this.endpoints.splice(index, 0, removed);
      throw new CustomEndpointError(500, "Could not save the change", "server_error");
    }
    this.emit();
    return this.describe(removed);
  }
}

/** The provider record `config.providers` (and so `buildTargets`) understands. */
export function customProviderConfig(endpoint) {
  return {
    apiKeys: [...endpoint.apiKeys],
    models: [...endpoint.models],
    baseUrl: endpoint.baseUrl,
    envPrefix: "",
    clientHeaders: {},
    protocols: [endpoint.protocol],
    custom: true,
    label: endpoint.name
  };
}

/**
 * Replaces every custom provider in `config.providers` with the given endpoints.
 * Mutates in place on purpose: the API layer holds the same `config` object.
 */
export function applyCustomEndpoints(config, endpoints) {
  for (const id of Object.keys(config.providers)) {
    if (isCustomProviderId(id)) delete config.providers[id];
  }
  for (const endpoint of endpoints) config.providers[endpoint.id] = customProviderConfig(endpoint);
}
