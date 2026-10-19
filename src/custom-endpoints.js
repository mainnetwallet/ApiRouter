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

/** Parses saved JSON text into the valid endpoints it holds; anything invalid is skipped, never fatal. */
function parseEndpoints(text, { allowPrivateHosts }) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) {
    console.warn(`custom endpoints: ignoring unreadable saved data (${error.message})`);
    return [];
  }
  const endpoints = [];
  const seen = new Set();
  for (const entry of Array.isArray(parsed?.endpoints) ? parsed.endpoints : []) {
    try {
      const id = String(entry?.id ?? "");
      if (!isCustomProviderId(id) || seen.has(id)) continue;
      if (!CUSTOM_PROTOCOLS.includes(entry.protocol)) continue;
      endpoints.push({
        id,
        name: cleanName(entry.name),
        baseUrl: validateEndpointBaseUrl(entry.baseUrl, { allowPrivateHosts }),
        protocol: entry.protocol,
        models: cleanModels(entry.models),
        apiKeys: cleanKeys(entry.apiKeys)
      });
      seen.add(id);
    } catch (error) {
      console.warn(`custom endpoints: skipped an invalid saved endpoint (${error.message})`);
    }
  }
  return endpoints;
}

const RETRY_INTERVAL_MS = 60_000;

export class CustomEndpointStore {
  /**
   * @param file                path of the local copy ("" / null keeps it in memory, as in tests)
   * @param remote              optional remote storage (see remote-storage.js). When set it is the
   *                            source of truth and the local file is only a mirror, because the local
   *                            disk may be wiped on every redeploy.
   * @param allowPrivateHosts   allow private / loopback hosts (Ollama, LM Studio, a LAN gateway)
   * @param lookup              DNS lookup, injectable for tests
   */
  constructor({ file = "", remote = null, allowPrivateHosts = false, lookup = dns.lookup } = {}) {
    this.file = file || "";
    this.remote = remote;
    this.allowPrivateHosts = allowPrivateHosts;
    this.lookup = lookup;
    this.endpoints = [];
    this.listeners = new Set();
    this.remoteReady = !remote;     // with no remote there is nothing to wait for
    this.lastRemoteError = null;
    this.queue = Promise.resolve(); // changes run one at a time
    this.retryTimer = null;
    this.loadLocal();
  }

  loadLocal() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try { this.endpoints = parseEndpoints(fs.readFileSync(this.file, "utf8"), this); }
    catch (error) { console.warn(`custom endpoints: could not read ${this.file} (${error.message})`); }
  }

  serialize() {
    return JSON.stringify({ version: 1, endpoints: this.endpoints }, null, 2);
  }

  writeLocal(text) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * Reads the remote copy. Remote wins over the local file: the local file of a
   * freshly started container is empty or stale. When the remote holds nothing
   * yet, whatever the local file has is uploaded once (migration). Never throws.
   * Returns true when the endpoint list changed.
   */
  async init() {
    if (!this.remote) return false;
    try {
      const text = await this.remote.read();
      let changed = false;
      if (text === null) {
        if (this.endpoints.length > 0) await this.remote.write(this.serialize());
      } else {
        const before = JSON.stringify(this.endpoints);
        this.endpoints = parseEndpoints(text, this);
        changed = JSON.stringify(this.endpoints) !== before;
        try { this.writeLocal(this.serialize()); } catch { /* the mirror is optional */ }
      }
      this.remoteReady = true;
      this.lastRemoteError = null;
      return changed;
    } catch (error) {
      this.remoteReady = false;
      this.lastRemoteError = error.message;
      console.warn(`custom endpoints: remote storage not available (${error.message}); saved endpoints will load as soon as it is`);
      return false;
    }
  }

  /** Keeps trying to reach the remote until it answers, then hot-loads what it holds. */
  startRetry() {
    if (!this.remote || this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      if (this.remoteReady) { clearInterval(this.retryTimer); this.retryTimer = null; return; }
      const changed = await this.init();
      if (this.remoteReady) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
        if (changed) this.emit();
      }
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  /** Where the data is kept and whether that place is reachable. Never contains a token. */
  storageInfo() {
    return this.remote
      ? { mode: this.remote.name, location: this.remote.location, ready: this.remoteReady, error: this.remoteReady ? null : this.lastRemoteError }
      : { mode: "file", location: this.file || "memory", ready: true, error: null };
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

  /** Runs `task` after every earlier change has finished, so two saves cannot interleave. */
  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Called at the start of every change. With a remote configured, a change is
   * refused while the remote cannot be read: writing then could overwrite the
   * saved endpoints with a list that never saw them.
   */
  async ensureReady() {
    if (this.remoteReady) return;
    const changed = await this.init();
    if (!this.remoteReady) {
      throw new CustomEndpointError(503, `Remote storage is not reachable (${this.lastRemoteError ?? "unknown error"}). Nothing was saved.`, "unavailable");
    }
    if (changed) this.emit();
  }

  /** Writes the current list to the remote (when set) and then to the local mirror. */
  async save() {
    const text = this.serialize();
    if (this.remote) {
      await this.remote.write(text);
      try { this.writeLocal(text); } catch { /* the mirror is optional */ }
      return;
    }
    this.writeLocal(text);
  }

  async commit(mutate, rollback) {
    mutate();
    try { await this.save(); }
    catch (error) {
      rollback();
      const detail = this.remote && error?.message ? ` (${error.message})` : "";
      throw new CustomEndpointError(500, `Could not save the custom endpoint${detail}`, "server_error");
    }
    this.emit();
  }

  create(input) {
    return this.exclusive(async () => {
      await this.ensureReady();
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
      await this.commit(() => this.endpoints.push(endpoint), () => this.endpoints.splice(this.endpoints.indexOf(endpoint), 1));
      return this.describe(endpoint);
    });
  }

  /**
   * Partial update. Omitted fields keep their value. Keys are never echoed back,
   * so the panel changes them with `addApiKeys` (append) or `apiKeys` (replace all).
   */
  update(id, input) {
    return this.exclusive(async () => {
      await this.ensureReady();
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
      await this.commit(() => { this.endpoints[index] = next; }, () => { this.endpoints[index] = current; });
      return this.describe(next);
    });
  }

  remove(id) {
    return this.exclusive(async () => {
      await this.ensureReady();
      const index = this.endpoints.findIndex((endpoint) => endpoint.id === id);
      if (index < 0) throw new CustomEndpointError(404, `no custom endpoint "${id}"`, "not_found");
      const removed = this.endpoints[index];
      await this.commit(() => this.endpoints.splice(index, 1), () => this.endpoints.splice(index, 0, removed));
      return this.describe(removed);
    });
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
