import { randomUUID } from "node:crypto";
import { buildMetadata, CATALOG_CLIENT_IDE } from "./client-metadata.js";
import { encodeMessage, iterFields } from "./connect-wire.js";
import { getCachedUserJwt } from "./mint-user-jwt.js";

export const DEFAULT_DEVIN_HOST = "https://server.codeium.com";

export interface CatalogModel {
  modelUid: string;
  label: string;
  disabled: boolean;
  supportsImages: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

function parseModelFeatures(buf: Buffer): { supportsImages?: boolean; supportsThinking?: boolean } {
  let supportsImages: boolean | undefined;
  let supportsThinking: boolean | undefined;
  for (const field of iterFields(buf)) {
    if (field.wire !== 0) continue;
    if (field.num === 11) supportsImages = field.value === 1n;
    if (field.num === 15) supportsThinking = field.value === 1n;
  }
  return { supportsImages, supportsThinking };
}

function parseModelInfo(buf: Buffer): {
  supportsImages?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  let supportsImages: boolean | undefined;
  let supportsThinking: boolean | undefined;
  let contextWindow: number | undefined;
  let maxOutputTokens: number | undefined;
  for (const field of iterFields(buf)) {
    if (field.num === 4 && field.wire === 0) {
      // model_info.max_context_tokens: the only field the catalog fills in for
      // every entry. ClientModelConfig field 18 mirrors it for a few models.
      const n = Number(field.value);
      if (n > 0) contextWindow = n;
    } else if (field.num === 6 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const features = parseModelFeatures(field.value);
      supportsImages = features.supportsImages;
      supportsThinking = features.supportsThinking;
    } else if (field.num === 13 && field.wire === 0) {
      const n = Number(field.value);
      if (n > 0) maxOutputTokens = n;
    }
  }
  return { supportsImages, supportsThinking, contextWindow, maxOutputTokens };
}

function parseClientModelConfig(buf: Buffer): CatalogModel | null {
  let label = "";
  let modelUid = "";
  let disabled = false;
  let supportsImages = false;
  let supportsThinking: boolean | undefined;
  let contextWindow: number | undefined;
  let maxOutputTokens: number | undefined;

  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      label = field.value.toString("utf8");
    } else if (field.num === 4 && field.wire === 0) {
      disabled = field.value === 1n;
    } else if (field.num === 5 && field.wire === 0) {
      supportsImages = field.value === 1n;
    } else if (field.num === 18 && field.wire === 0) {
      const n = Number(field.value);
      if (n > 0) contextWindow = n;
    } else if (field.num === 22 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      modelUid = field.value.toString("utf8");
    } else if (field.num === 23 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const info = parseModelInfo(field.value);
      if (info.supportsImages !== undefined) supportsImages = info.supportsImages;
      supportsThinking = info.supportsThinking;
      if (info.contextWindow !== undefined) contextWindow = info.contextWindow;
      maxOutputTokens = info.maxOutputTokens;
    }
  }

  if (!modelUid) return null;
  return {
    modelUid,
    label: label || modelUid,
    disabled,
    supportsImages,
    supportsThinking,
    contextWindow,
    maxOutputTokens,
  };
}

/** Decode repeated ClientModelConfig from GetCli/GetCascadeModelConfigs. */
export function parseClientModelConfigs(buf: Buffer): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const field of iterFields(buf)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const entry = parseClientModelConfig(field.value);
    if (entry) out.push(entry);
  }
  return out;
}

async function postModelCatalog(
  apiKey: string,
  host: string,
  rpc: "GetCliModelConfigs" | "GetCascadeModelConfigs",
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  const userJwt = await getCachedUserJwt(apiKey, host, signal);
  const metadata = buildMetadata({
    apiKey,
    userJwt,
    ide: CATALOG_CLIENT_IDE,
    sessionId: randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
  });
  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.api_server_pb.ApiServerService/${rpc}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: new Uint8Array(encodeMessage(1, metadata)),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(`${rpc} HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }
  return parseClientModelConfigs(buf);
}

/**
 * Live Devin model catalog for this account. Prefers GetCliModelConfigs
 * (Devin Local); falls back to GetCascadeModelConfigs if that RPC is missing.
 */
export async function fetchDevinModelCatalog(
  apiKey: string,
  host: string = DEFAULT_DEVIN_HOST,
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  try {
    const cli = await postModelCatalog(apiKey, host, "GetCliModelConfigs", signal);
    if (cli.length > 0) return cli;
  } catch {
    // try cascade catalog
  }
  return postModelCatalog(apiKey, host, "GetCascadeModelConfigs", signal);
}
