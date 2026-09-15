import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CatalogModel } from "./cli-model-catalog.js";

export interface DevinCatalogCache {
  fetchedAt: number;
  host: string;
  catalog: CatalogModel[];
}

/** On-disk catalog so /reload and startup have models before a live fetch. */
export function devinCatalogCachePath(): string {
  return join(homedir(), ".pi/agent/cache/devin-oauth-catalog.json");
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!value || typeof value !== "object") return false;
  const entry = value as CatalogModel;
  return typeof entry.modelUid === "string" && typeof entry.label === "string" && typeof entry.disabled === "boolean";
}

/** Last successful Devin catalog, or null if none has been stored. */
export function readDevinCatalogCache(): DevinCatalogCache | null {
  const path = devinCatalogCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DevinCatalogCache>;
    if (!Array.isArray(parsed.catalog) || !parsed.catalog.every(isCatalogModel)) return null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      host: typeof parsed.host === "string" ? parsed.host : "",
      catalog: parsed.catalog,
    };
  } catch {
    return null;
  }
}

export function writeDevinCatalogCache(cache: DevinCatalogCache): void {
  const path = devinCatalogCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/** API key already stored by `/login devin` in Pi's auth.json. */
export function readStoredDevinApiKey(): string | null {
  const path = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as {
      devin?: { type?: string; access?: string; key?: string };
    };
    const entry = auth.devin;
    if (!entry) return null;
    if (typeof entry.access === "string" && entry.access) return entry.access;
    if (typeof entry.key === "string" && entry.key) return entry.key;
    return null;
  } catch {
    return null;
  }
}
