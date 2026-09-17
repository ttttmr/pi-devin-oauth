import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { DEFAULT_DEVIN_HOST, fetchDevinModelCatalog, type CatalogModel } from "../src/cli-model-catalog.js";
import {
  readDevinCatalogCache,
  readStoredDevinApiKey,
  writeDevinCatalogCache,
} from "../src/devin-catalog-cache.js";

/** Refresh the live catalog at most once per TTL, matching pi's own catalog refresh throttle. */
const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;

function shouldRefreshLiveCatalog(): boolean {
  if (process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true") return false;
  const cached = readDevinCatalogCache();
  if (!cached) return true;
  return Date.now() - cached.fetchedAt > CATALOG_TTL_MS;
}
import { modelsFromCatalog } from "../src/devin-models.js";
import { streamDevin } from "../src/stream-devin.js";
import { loginDevinWithWindsurf } from "../src/windsurf-login.js";

const PROVIDER_ID = "devin";

let _pi: ExtensionAPI | null = null;

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin",
    api: "devin-local",
    baseUrl: DEFAULT_DEVIN_HOST,
    models,
    oauth: {
      name: "Devin (Windsurf)",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const credentials = await loginDevinWithWindsurf(callbacks);
        if (_pi) {
          try {
            await loadLiveCatalog(_pi, credentials.access);
          } catch {
            // keep cache / current models
          }
        }
        return credentials;
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
      modifyModels(models: Model<Api>[]): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

function modelsFromCache(): ProviderModelConfig[] {
  const cached = readDevinCatalogCache();
  return cached ? modelsFromCatalog(cached.catalog) : [];
}

async function loadLiveCatalog(pi: ExtensionAPI, apiKey: string): Promise<CatalogModel[]> {
  const catalog = await fetchDevinModelCatalog(apiKey, DEFAULT_DEVIN_HOST);
  writeDevinCatalogCache({ fetchedAt: Date.now(), host: DEFAULT_DEVIN_HOST, catalog });
  registerDevinProvider(pi, modelsFromCatalog(catalog));
  return catalog;
}

export default function (pi: ExtensionAPI): void {
  _pi = pi;
  registerDevinProvider(pi, modelsFromCache());

  // Register cached models synchronously so startup never blocks on the network;
  // refresh the live catalog in the background when the cache is stale.
  const apiKey = readStoredDevinApiKey();
  if (apiKey && shouldRefreshLiveCatalog()) {
    void loadLiveCatalog(pi, apiKey).catch(() => {
      // keep cached models
    });
  }

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
