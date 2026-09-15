import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogModel } from "./cli-model-catalog.js";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
    const reasoning = mappedLevels.length > 1;
    const defaultUid = preferredDefault(thinkingLevelMap) ?? bucket.variants[0]?.modelUid;
    if (!defaultUid) continue;
    const sample = bucket.variants.find((variant) => variant.modelUid === defaultUid) ?? bucket.variants[0];

    const contextWindow = Math.max(
      256_000,
      ...bucket.variants.map((variant) => variant.contextWindow ?? 0),
    );
    const maxTokens = Math.max(
      128_000,
      ...bucket.variants.map((variant) => variant.maxOutputTokens ?? 0),
    );
    const supportsImages = bucket.variants.some((variant) => variant.supportsImages);

    models.push({
      id: reasoning ? bucket.id : defaultUid,
      name: familyLabelOf(sample.label, bucket.id),
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
      input: supportsImages ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
