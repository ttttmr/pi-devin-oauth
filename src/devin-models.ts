import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogModel } from "./cli-model-catalog.js";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi's own defaults, used only if the catalog omits a field (it does not today). */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

const VARIANT_SUFFIXES = [
  "none-priority",
  "low-priority",
  "medium-priority",
  "high-priority",
  "xhigh-priority",
  "max-priority",
  "low-fast",
  "medium-fast",
  "high-fast",
  "xhigh-fast",
  "max-fast",
  "thinking-1m",
  "thinking",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "minimal",
];

function variantKey(uid: string): string | null {
  for (const suffix of VARIANT_SUFFIXES) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}

function thinkingFromSuffix(suffix: string | null): keyof ThinkingLevelMap | null {
  if (!suffix) return "high";
  if (suffix === "none" || suffix === "none-priority") return "off";
  if (suffix === "minimal") return "minimal";
  if (suffix.startsWith("low")) return "low";
  if (suffix.startsWith("medium")) return "medium";
  if (suffix.startsWith("high") && !suffix.startsWith("xhigh")) return "high";
  if (suffix.startsWith("xhigh")) return "xhigh";
  if (suffix.startsWith("max")) return "max";
  if (suffix.includes("thinking")) return "high";
  return null;
}

function preferredDefault(map: ThinkingLevelMap): string | undefined {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"] as const) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isSkuVariant(key: string | null): boolean {
  return Boolean(key && (key.includes("priority") || key.includes("fast") || key === "thinking-1m"));
}

function familyIdOf(uid: string, key: string | null): string {
  if (!key || uid === key) return uid;
  return uid.slice(0, uid.length - key.length - 1);
}

function familyLabelOf(label: string, familyId: string): string {
  const stripped = label.replace(/\s+(None|Minimal|Low|Medium|High|XHigh|Max|Thinking)\b.*$/i, "").trim();
  return stripped || familyId;
}

interface FamilyBucket {
  id: string;
  variants: CatalogModel[];
}

/** Group a live catalog into one Pi model per family, thinking levels via Pi. */
export function modelsFromCatalog(catalog: CatalogModel[]): ProviderModelConfig[] {
  const enabled = catalog.filter((entry) => !entry.disabled && entry.modelUid);
  const usable = enabled.filter((entry) => !isSkuVariant(variantKey(entry.modelUid)));
  const source = usable.length > 0 ? usable : enabled;

  const buckets = new Map<string, FamilyBucket>();
  for (const entry of source) {
    const key = variantKey(entry.modelUid);
    const id = familyIdOf(entry.modelUid, key);
    const bucket = buckets.get(id) ?? { id, variants: [] };
    bucket.variants.push(entry);
    buckets.set(id, bucket);
  }

  const models: ProviderModelConfig[] = [];
  for (const bucket of buckets.values()) {
    const thinkingLevelMap: ThinkingLevelMap = {};
    for (const variant of bucket.variants) {
      const level = thinkingFromSuffix(variantKey(variant.modelUid));
      if (level && thinkingLevelMap[level] === undefined) {
        thinkingLevelMap[level] = variant.modelUid;
      }
    }
    for (const level of THINKING_ORDER) {
      if (thinkingLevelMap[level] === undefined) thinkingLevelMap[level] = null;
    }

    const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
    // The catalog's feature flag is authoritative. A family that ships several
    // thinking variants still counts as reasoning when the flag is absent.
    const supportsThinking = bucket.variants.some((variant) => variant.supportsThinking === true);
    const reasoning = supportsThinking || mappedLevels.length > 1;
    const defaultUid = preferredDefault(thinkingLevelMap) ?? bucket.variants[0]?.modelUid;
    if (!defaultUid) continue;
    const sample = bucket.variants.find((variant) => variant.modelUid === defaultUid) ?? bucket.variants[0];

    // Taken from the catalog's model_info, never widened by a local floor. Pi
    // stores one window per model, so a family shipping several variants takes
    // the smallest: understating compacts early, overstating overflows the
    // request before compaction can run.
    const contexts = bucket.variants
      .map((variant) => variant.contextWindow)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const outputs = bucket.variants
      .map((variant) => variant.maxOutputTokens)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const contextWindow = contexts.length > 0 ? Math.min(...contexts) : FALLBACK_CONTEXT_WINDOW;
    const maxTokens = outputs.length > 0 ? Math.min(...outputs) : FALLBACK_MAX_TOKENS;
    // Cost comes straight from the catalog's price rows. Models bundled with
    // the plan have none, so they stay at zero. Pi has no field for cache
    // writes and the catalog publishes no rate for them; zero keeps the
    // estimate honest instead of inventing a multiplier.
    const priced = bucket.variants.find((variant) => variant.price);
    const cost: ProviderModelConfig["cost"] = {
      input: priced?.price?.input ?? 0,
      output: priced?.price?.output ?? 0,
      cacheRead: priced?.price?.cachedInput ?? 0,
      cacheWrite: 0,
    };
    const supportsImages = bucket.variants.some((variant) => variant.supportsImages);

    models.push({
      id: reasoning ? bucket.id : defaultUid,
      name: familyLabelOf(sample.label, bucket.id),
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
      input: supportsImages ? ["text", "image"] : ["text"],
      cost,
      contextWindow,
      maxTokens,
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return models;
}

/** Map Pi's thinking level onto the Devin model uid sent on the wire. */
export function resolveModelUid(
  modelId: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
  reasoning?: string,
): string {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}
