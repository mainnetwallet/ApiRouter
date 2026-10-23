/**
 * Pure view-model helpers for the Unified Model Configurator.
 *
 * The page renders what the gateway says, and every decision it can get wrong
 * is made here so it can be tested without a browser:
 *
 *   normalized payload   a partial or malformed response can never reach the
 *                        table (missing arrays become [], unknown sources fall
 *                        back to "environment")
 *   capability state     declared-by-the-operator is kept apart from
 *                        executable-by-an-adapter, because a checkbox must never
 *                        pretend a capability works when no wire form exists
 *   filtering/summary    one implementation for the page and its tests
 */

const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value, fallback = "") => (typeof value === "string" ? value : fallback);

export const SOURCE_LABELS = Object.freeze({
  configured: "Configured",
  environment: "Environment"
});

export const EMPTY_SUMMARY = Object.freeze({
  total: 0, configured: 0, environmentOnly: 0, enabled: 0, disabled: 0, declaredUnsupported: 0
});

function normalizeRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const provider = asString(raw.provider).trim();
  const model = asString(raw.model).trim();
  if (!provider || !model) return null;
  const stored = raw.stored === true || raw.source === "configured";
  return {
    id: asString(raw.id) || `${provider}/${model}`,
    configId: asString(raw.configId) || null,
    provider,
    model,
    displayName: asString(raw.displayName) || model,
    enabled: raw.enabled !== false,
    enabledByConfig: raw.enabledByConfig !== false,
    disabledBySwitch: raw.disabledBySwitch === true,
    disabledByProvider: raw.disabledByProvider === true,
    capabilities: asArray(raw.capabilities).filter((id) => typeof id === "string"),
    capabilitiesSource: raw.capabilitiesSource === "configured" ? "configured" : "inferred",
    executableCapabilities: asArray(raw.executableCapabilities).filter((id) => typeof id === "string"),
    unsupportedCapabilities: asArray(raw.unsupportedCapabilities).filter((id) => typeof id === "string"),
    protocol: asString(raw.protocol) || null,
    protocols: asArray(raw.protocols).filter((protocol) => typeof protocol === "string"),
    keyCount: Number.isFinite(raw.keyCount) ? raw.keyCount : 0,
    configuredInEnvironment: raw.configuredInEnvironment !== false,
    stored,
    source: stored ? "configured" : "environment",
    warnings: asArray(raw.warnings).filter((warning) => typeof warning === "string"),
    updatedAt: raw.updatedAt ?? null
  };
}

/** Safe shape for the page: never throws, never trusts the server's array-ness. */
export function normalizeModelConfigPayload(data) {
  if (!data || typeof data !== "object") {
    return {
      available: false,
      models: [],
      summary: { ...EMPTY_SUMMARY },
      schema: { version: 1, capabilities: [], protocols: [] },
      adapters: {},
      storage: null,
      warnings: [],
      revision: null,
      updatedAt: null
    };
  }

  const models = asArray(data.models).map(normalizeRow).filter(Boolean);
  const adapters = data.adapters && typeof data.adapters === "object" ? data.adapters : {};
  return {
    available: data.available !== false,
    models,
    summary: summarizeModels(models),
    schema: {
      version: Number.isFinite(data.schema?.version) ? data.schema.version : 1,
      capabilities: asArray(data.schema?.capabilities),
      protocols: asArray(data.schema?.protocols)
    },
    adapters,
    storage: data.storage && typeof data.storage === "object" ? data.storage : null,
    warnings: asArray(data.warnings).filter((warning) => typeof warning === "string"),
    revision: typeof data.revision === "string" ? data.revision : null,
    updatedAt: data.updatedAt ?? null
  };
}

export function summarizeModels(models) {
  const list = asArray(models);
  return {
    total: list.length,
    configured: list.filter((row) => row.stored).length,
    environmentOnly: list.filter((row) => !row.stored).length,
    enabled: list.filter((row) => row.enabled).length,
    disabled: list.filter((row) => !row.enabled).length,
    declaredUnsupported: list.filter((row) => row.unsupportedCapabilities.length > 0).length
  };
}

/** The schema grouped for rendering, in the schema's own order. */
export function capabilityGroups(schema) {
  const groups = [];
  const index = new Map();
  for (const entry of asArray(schema?.capabilities)) {
    if (!entry?.id) continue;
    const group = asString(entry.group) || "Other";
    if (!index.has(group)) {
      const bucket = { id: group.toLowerCase().replace(/\s+/g, "-"), label: group, items: [] };
      index.set(group, bucket);
      groups.push(bucket);
    }
    index.get(group).items.push({
      id: entry.id,
      label: asString(entry.label) || entry.id,
      description: asString(entry.description),
      requestable: entry.requestable !== false
    });
  }
  return groups;
}

/** True when at least one protocol this model speaks has a wire form for it. */
export function adapterSupports(adapters, protocols, capabilityId) {
  return asArray(protocols).some((protocol) => asArray(adapters?.[protocol]).includes(capabilityId));
}

/**
 * The editor's three-way adapter answer. "unknown" is not "unsupported": a
 * blank Add form has no provider/model yet, so no protocol list exists and the
 * page must not claim every capability is impossible.
 */
export function adapterSupportState(adapters, protocols, capabilityId) {
  const list = asArray(protocols);
  const known = adapters && typeof adapters === "object" ? Object.keys(adapters) : [];
  if (list.length === 0 || known.length === 0) return "unknown";
  return adapterSupports(adapters, list, capabilityId) ? "supported" : "unsupported";
}

/**
 * The three facts a checkbox shows, kept distinct:
 *   declared      the operator ticked it
 *   executable    some adapter on this model's protocols can carry it
 *   unsupported   declared, but no adapter can execute it
 */
export function capabilityState(row, capabilityId) {
  const declared = asArray(row?.capabilities).includes(capabilityId);
  const executable = asArray(row?.executableCapabilities).includes(capabilityId);
  const unsupported = asArray(row?.unsupportedCapabilities).includes(capabilityId);
  return { declared, executable, unsupported };
}

export function filterModels(models, { search = "", provider = null, status = null, source = null } = {}) {
  const needle = String(search || "").trim().toLowerCase();
  return asArray(models).filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (status === "enabled" && !row.enabled) return false;
    if (status === "disabled" && row.enabled) return false;
    if (source && row.source !== source) return false;
    if (!needle) return true;
    return [row.provider, row.model, row.displayName, ...row.capabilities]
      .join(" ").toLowerCase().includes(needle);
  });
}

export function providerChoices(models) {
  return [...new Set(asArray(models).map((row) => row.provider))].sort();
}

/** The draft shape both the edit and the create drawer use. */
export function draftFromRow(row) {
  return {
    displayName: row?.displayName ?? row?.model ?? "",
    enabled: row?.enabledByConfig !== false,
    capabilities: [...asArray(row?.capabilities)],
    protocol: row?.protocol ?? ""
  };
}

export function draftFromCandidate({
  provider,
  model,
  capabilities = [],
  displayName = null,
  enabled = true,
  protocol = ""
}) {
  return {
    provider: provider ?? "",
    model: model ?? "",
    displayName: displayName ?? model ?? "",
    enabled,
    capabilities: [...capabilities],
    protocol
  };
}

/** The environment row for a provider/model, matched case-insensitively by provider. */
export function findModelRow(models, provider, model) {
  const wantedProvider = asString(provider).trim().toLowerCase();
  const wantedModel = asString(model).trim();
  if (!wantedProvider || !wantedModel) return null;
  return asArray(models).find((row) => row.provider === wantedProvider && row.model === wantedModel) ?? null;
}

/** Only a persisted declaration has an id the DELETE route can act on. */
export function canRemoveModel(row) {
  return Boolean(row?.stored && row?.configId);
}

/**
 * What clicking a table row opens. A persisted declaration edits its own fields;
 * an environment-only row opens a CREATE drawer prefilled with that model, so
 * the page never sends `/api/model-config/null`.
 */
export function editorFromRow(row) {
  if (row?.stored && row.configId) {
    return { mode: "edit", row, draft: draftFromRow(row) };
  }
  return {
    mode: "create",
    row: row ?? null,
    draft: draftFromCandidate({
      provider: row?.provider ?? "",
      model: row?.model ?? "",
      displayName: row?.displayName ?? row?.model ?? "",
      // Preserve the effective off state for an environment model, but do not
      // turn a provider-off model into a permanently disabled declaration.
      enabled: row ? row.enabledByConfig !== false && !row.disabledBySwitch : true,
      capabilities: row?.capabilities ?? [],
      protocol: row?.protocol ?? ""
    })
  };
}

export function toggleCapability(capabilities, capabilityId) {
  const list = asArray(capabilities);
  return list.includes(capabilityId)
    ? list.filter((id) => id !== capabilityId)
    : [...list, capabilityId];
}

/** Only the fields the API accepts. Empty protocol means "no override". */
export function buildDraftPayload(draft) {
  return {
    displayName: asString(draft?.displayName).trim(),
    enabled: draft?.enabled !== false,
    capabilities: asArray(draft?.capabilities),
    protocol: draft?.protocol ? draft.protocol : null
  };
}

/** Says why a model is unavailable, in the operator's words. */
export function availabilityNote(row) {
  if (!row) return "";
  if (row.disabledByProvider) return "The whole provider is switched off on the Providers page.";
  // The declaration is authoritative for a configured model. If a legacy/stale
  // switch is also present, name the declaration (the reason that survives a
  // restart) rather than the mirrored switch.
  if (!row.enabledByConfig) return "Switched off in the Model Configurator.";
  if (row.disabledBySwitch) return "Switched off in the Control Panel (Models page).";
  if (!row.configuredInEnvironment) return "No provider currently configures this model, so it cannot be routed.";
  return "";
}

export function selectionLabel(row) {
  return "";
}

/** Row-level attention: what an operator should look at first. */
export function rowTone(row) {
  if (!row) return "neutral";
  if (row.disabledByProvider || row.disabledBySwitch || !row.enabledByConfig) return "off";
  if (row.unsupportedCapabilities.length > 0) return "warn";
  if (!row.configuredInEnvironment) return "warn";
  return row.stored ? "ok" : "neutral";
}
