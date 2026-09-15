import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { DEFAULT_DEVIN_HOST, fetchDevinModelCatalog, type CatalogModel } from "../src/cli-model-catalog.js";
import {
  readDevinCatalogCache,
  readStoredDevinApiKey,
  writeDevinCatalogCache,
} from "../src/devin-catalog-cache.js";
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

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  registerDevinProvider(pi, modelsFromCache());

  const apiKey = readStoredDevinApiKey();
  if (apiKey) {
    try {
      await loadLiveCatalog(pi, apiKey);
    } catch {
      // cached models already registered
    }
  }

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
