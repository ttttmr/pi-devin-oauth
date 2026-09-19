// src/cli-model-catalog.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/connect-wire.ts
import * as zlib from "node:zlib";
function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  if (v < 0n) throw new RangeError(`encodeVarint: negative input (${value})`);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 128);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}
function encodeTag(fieldNum, wire) {
  return encodeVarint(fieldNum << 3 | wire);
}
function encodeString(fieldNum, s) {
  const buf = Buffer.from(s, "utf8");
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}
function encodeMessage(fieldNum, body) {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body]);
}
function encodeVarintField(fieldNum, v) {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(v)]);
}
function encodeFixed64Field(fieldNum, v) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return Buffer.concat([encodeTag(fieldNum, 1), b]);
}
function encodeTimestampBody() {
  const now = Date.now();
  const seconds = Math.floor(now / 1e3);
  const nanos = now % 1e3 * 1e6;
  return Buffer.concat([
    encodeVarintField(1, seconds),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0)
  ]);
}
function decodeVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    res |= BigInt(b & 127) << shift;
    if (!(b & 128)) return [res, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}
function* iterFields(buf) {
  let i = 0;
  while (i < buf.length) {
    const [tagBig, next] = decodeVarint(buf, i);
    i = next;
    const tag = Number(tagBig);
    const num = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [v, after] = decodeVarint(buf, i);
      i = after;
      yield { num, wire, value: v };
    } else if (wire === 1) {
      if (i + 8 > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const [n, after] = decodeVarint(buf, i);
      i = after;
      const len = Number(n);
      if (len < 0 || i + len > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + len) };
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + 4) };
      i += 4;
    } else {
      return;
    }
  }
}
function frameConnectStream(body, compress = true) {
  let payload = body;
  let flags = 0;
  if (compress) {
    payload = zlib.gzipSync(body);
    flags |= 1;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// src/client-metadata.ts
var CLIENT_IDE = "devin-desktop";
var CATALOG_CLIENT_IDE = "windsurf";
var CLIENT_VERSION = "3.6.27";
function buildMetadata(input) {
  const version = input.version ?? CLIENT_VERSION;
  const ide = input.ide ?? CLIENT_IDE;
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const parts = [
    encodeString(1, ide),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, ide),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, ide)
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}

// src/mint-user-jwt.ts
import { randomUUID } from "node:crypto";
function anySignal(signals) {
  const builtin = AbortSignal.any;
  if (typeof builtin === "function") return builtin(signals);
  const controller = new AbortController();
  const onAbort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      onAbort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => onAbort(signal.reason), { once: true });
  }
  return controller.signal;
}
async function mintUserJwt(apiKey, host, signal) {
  const metadata = buildMetadata({
    apiKey,
    sessionId: randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID()
  });
  const timeout = AbortSignal.timeout(3e4);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1"
    },
    body: new Uint8Array(encodeMessage(1, metadata)),
    signal: combined
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(`GetUserJwt HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }
  let jwt = null;
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const value = field.value.toString("utf8");
      if (value.startsWith("eyJ")) {
        jwt = value;
        break;
      }
    }
  }
  if (!jwt) throw new Error("GetUserJwt returned no JWT");
  let expiresAt = Math.floor(Date.now() / 1e3) + 600;
  try {
    const payload = jwt.split(".")[1] ?? "";
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const parsed = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof parsed.exp === "number") expiresAt = parsed.exp;
  } catch {
  }
  return { jwt, expiresAt };
}
var cache = null;
var inFlight = /* @__PURE__ */ new Map();
async function getCachedUserJwt(apiKey, host, signal) {
  const now = Math.floor(Date.now() / 1e3);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt;
  }
  const key = `${host}${apiKey}`;
  const existing = inFlight.get(key);
  if (existing) return (await existing).jwt;
  const promise = mintUserJwt(apiKey, host, signal);
  inFlight.set(key, promise);
  try {
    const minted = await promise;
    cache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
    return minted.jwt;
  } finally {
    inFlight.delete(key);
  }
}

// src/cli-model-catalog.ts
var DEFAULT_DEVIN_HOST = "https://server.codeium.com";
function roundPrice(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}
function parsePriceRow(buf) {
  let label = "";
  let price;
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      label = field.value.toString("utf8");
    } else if (field.num === 2 && field.wire === 5 && Buffer.isBuffer(field.value) && field.value.length === 4) {
      price = roundPrice(field.value.readFloatLE(0));
    }
  }
  return { label, price };
}
function parseModelFeatures(buf) {
  let supportsImages;
  let supportsThinking;
  for (const field of iterFields(buf)) {
    if (field.wire !== 0) continue;
    if (field.num === 11) supportsImages = field.value === 1n;
    if (field.num === 15) supportsThinking = field.value === 1n;
  }
  return { supportsImages, supportsThinking };
}
function parseModelInfo(buf) {
  let supportsImages;
  let supportsThinking;
  let contextWindow;
  let maxOutputTokens;
  for (const field of iterFields(buf)) {
    if (field.num === 4 && field.wire === 0) {
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
function parseClientModelConfig(buf) {
  let label = "";
  let modelUid = "";
  let disabled = false;
  let supportsImages = false;
  let supportsThinking;
  let contextWindow;
  let maxOutputTokens;
  let input;
  let cachedInput;
  let output;
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
      if (info.supportsImages !== void 0) supportsImages = info.supportsImages;
      supportsThinking = info.supportsThinking;
      if (info.contextWindow !== void 0) contextWindow = info.contextWindow;
      maxOutputTokens = info.maxOutputTokens;
    } else if (field.num === 32 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const row = parsePriceRow(field.value);
      if (row.price === void 0) continue;
      if (row.label === "Input") input = row.price;
      else if (row.label === "Cached input") cachedInput = row.price;
      else if (row.label === "Output") output = row.price;
    }
  }
  if (!modelUid) return null;
  const price = input !== void 0 || cachedInput !== void 0 || output !== void 0 ? { input: input ?? 0, cachedInput: cachedInput ?? 0, output: output ?? 0 } : void 0;
  return {
    modelUid,
    label: label || modelUid,
    disabled,
    supportsImages,
    supportsThinking,
    contextWindow,
    maxOutputTokens,
    price
  };
}
function parseClientModelConfigs(buf) {
  const out = [];
  for (const field of iterFields(buf)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    const entry = parseClientModelConfig(field.value);
    if (entry) out.push(entry);
  }
  return out;
}
async function postModelCatalog(apiKey, host, rpc, signal) {
  const userJwt = await getCachedUserJwt(apiKey, host, signal);
  const metadata = buildMetadata({
    apiKey,
    userJwt,
    ide: CATALOG_CLIENT_IDE,
    sessionId: randomUUID2(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID2()
  });
  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.api_server_pb.ApiServerService/${rpc}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1"
    },
    body: new Uint8Array(encodeMessage(1, metadata)),
    signal: signal ?? AbortSignal.timeout(15e3)
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(`${rpc} HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }
  return parseClientModelConfigs(buf);
}
async function fetchDevinModelCatalog(apiKey, host = DEFAULT_DEVIN_HOST, signal) {
  try {
    const cli = await postModelCatalog(apiKey, host, "GetCliModelConfigs", signal);
    if (cli.length > 0) return cli;
  } catch {
  }
  return postModelCatalog(apiKey, host, "GetCascadeModelConfigs", signal);
}

// src/devin-catalog-cache.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function devinCatalogCachePath() {
  return join(homedir(), ".pi/agent/cache/devin-oauth-catalog.json");
}
function isCatalogModel(value) {
  if (!value || typeof value !== "object") return false;
  const entry = value;
  return typeof entry.modelUid === "string" && typeof entry.label === "string" && typeof entry.disabled === "boolean";
}
function readDevinCatalogCache() {
  const path = devinCatalogCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed.catalog) || !parsed.catalog.every(isCatalogModel)) return null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      host: typeof parsed.host === "string" ? parsed.host : "",
      catalog: parsed.catalog
    };
  } catch {
    return null;
  }
}
function writeDevinCatalogCache(cache2) {
  const path = devinCatalogCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache2)}
`, { mode: 384 });
}
function readStoredDevinApiKey() {
  const path = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8"));
    const entry = auth.devin;
    if (!entry) return null;
    if (typeof entry.access === "string" && entry.access) return entry.access;
    if (typeof entry.key === "string" && entry.key) return entry.key;
    return null;
  } catch {
    return null;
  }
}

// src/devin-models.ts
var THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var FALLBACK_CONTEXT_WINDOW = 128e3;
var FALLBACK_MAX_TOKENS = 16384;
var VARIANT_SUFFIXES = [
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
  "minimal"
];
function variantKey(uid) {
  for (const suffix of VARIANT_SUFFIXES) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}
function thinkingFromSuffix(suffix) {
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
function preferredDefault(map) {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"]) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return void 0;
}
function isSkuVariant(key) {
  return Boolean(key && (key.includes("priority") || key.includes("fast") || key === "thinking-1m"));
}
function familyIdOf(uid, key) {
  if (!key || uid === key) return uid;
  return uid.slice(0, uid.length - key.length - 1);
}
function familyLabelOf(label, familyId) {
  const stripped = label.replace(/\s+(None|Minimal|Low|Medium|High|XHigh|Max|Thinking)\b.*$/i, "").trim();
  return stripped || familyId;
}
function modelsFromCatalog(catalog) {
  const enabled = catalog.filter((entry) => !entry.disabled && entry.modelUid);
  const usable = enabled.filter((entry) => !isSkuVariant(variantKey(entry.modelUid)));
  const source = usable.length > 0 ? usable : enabled;
  const buckets = /* @__PURE__ */ new Map();
  for (const entry of source) {
    const key = variantKey(entry.modelUid);
    const id = familyIdOf(entry.modelUid, key);
    const bucket = buckets.get(id) ?? { id, variants: [] };
    bucket.variants.push(entry);
    buckets.set(id, bucket);
  }
  const models = [];
  for (const bucket of buckets.values()) {
    const thinkingLevelMap = {};
    for (const variant of bucket.variants) {
      const level = thinkingFromSuffix(variantKey(variant.modelUid));
      if (level && thinkingLevelMap[level] === void 0) {
        thinkingLevelMap[level] = variant.modelUid;
      }
    }
    for (const level of THINKING_ORDER) {
      if (thinkingLevelMap[level] === void 0) thinkingLevelMap[level] = null;
    }
    const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
    const supportsThinking = bucket.variants.some((variant) => variant.supportsThinking === true);
    const reasoning = supportsThinking || mappedLevels.length > 1;
    const defaultUid = preferredDefault(thinkingLevelMap) ?? bucket.variants[0]?.modelUid;
    if (!defaultUid) continue;
    const sample = bucket.variants.find((variant) => variant.modelUid === defaultUid) ?? bucket.variants[0];
    const contexts = bucket.variants.map((variant) => variant.contextWindow).filter((n) => typeof n === "number" && n > 0);
    const outputs = bucket.variants.map((variant) => variant.maxOutputTokens).filter((n) => typeof n === "number" && n > 0);
    const contextWindow = contexts.length > 0 ? Math.min(...contexts) : FALLBACK_CONTEXT_WINDOW;
    const maxTokens = outputs.length > 0 ? Math.min(...outputs) : FALLBACK_MAX_TOKENS;
    const priced = bucket.variants.find((variant) => variant.price);
    const cost = {
      input: priced?.price?.input ?? 0,
      output: priced?.price?.output ?? 0,
      cacheRead: priced?.price?.cachedInput ?? 0,
      cacheWrite: 0
    };
    const supportsImages = bucket.variants.some((variant) => variant.supportsImages);
    models.push({
      id: reasoning ? bucket.id : defaultUid,
      name: familyLabelOf(sample.label, bucket.id),
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : void 0,
      input: supportsImages ? ["text", "image"] : ["text"],
      cost,
      contextWindow,
      maxTokens
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return models;
}
function resolveModelUid(modelId, thinkingLevelMap, reasoning) {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}

// src/stream-devin.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import * as zlib2 from "node:zlib";
import {
  calculateCost,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";

// node_modules/@earendil-works/pi-ai/dist/utils/estimate.js
var CHARS_PER_TOKEN = 4;
var ESTIMATED_IMAGE_CHARS = 4800;
function calculateContextTokens(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
function estimateTextAndImageContentChars(content) {
  if (typeof content === "string")
    return content.length;
  let chars = 0;
  for (const block of content)
    chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  return chars;
}
function estimateTextTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function estimateTextAndImageContentTokens(content) {
  return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}
function estimateMessageTokens(message) {
  let chars = 0;
  if (message.role === "user")
    return estimateTextAndImageContentTokens(message.content);
  if (message.role === "toolResult")
    return estimateTextAndImageContentTokens(message.content);
  for (const block of message.content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
    } else {
      chars += block.name.length + safeJsonStringify(block.arguments).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
function getLastAssistantUsageInfo(messages) {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usageInfo;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") {
      const assistant = message;
      const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
      if (usageAppliesToPrefix && assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && calculateContextTokens(assistant.usage) > 0) {
        usageInfo = { usage: assistant.usage, index: i };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }
  return usageInfo;
}
function estimateMessages(messages) {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (usageInfo) {
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
      trailingTokens += estimateMessageTokens(messages[i]);
    }
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
  }
  let tokens = 0;
  for (const message of messages)
    tokens += estimateMessageTokens(message);
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
function estimateToolsTokens(tools) {
  if (!tools || tools.length === 0)
    return 0;
  return estimateTextTokens(safeJsonStringify(tools));
}
function isMessageArray(value) {
  return Array.isArray(value);
}
function estimateContextTokens(context) {
  if (isMessageArray(context))
    return estimateMessages(context);
  const estimate = estimateMessages(context.messages);
  if (estimate.lastUsageIndex !== null) {
    const addedNames = new Set(context.messages.slice(estimate.lastUsageIndex + 1).filter((message) => message.role === "toolResult").flatMap((message) => message.addedToolNames ?? []));
    const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
    return {
      tokens: estimate.tokens + addedToolTokens,
      usageTokens: estimate.usageTokens,
      trailingTokens: estimate.trailingTokens + addedToolTokens,
      lastUsageIndex: estimate.lastUsageIndex
    };
  }
  const prefixTokens = (context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);
  return {
    tokens: estimate.tokens + prefixTokens,
    usageTokens: estimate.usageTokens,
    trailingTokens: estimate.trailingTokens + prefixTokens,
    lastUsageIndex: estimate.lastUsageIndex
  };
}

// node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
var CONTEXT_SAFETY_TOKENS = 4096;
var MIN_MAX_TOKENS = 1;
function clampMaxTokensToContext(model, context, maxTokens) {
  if (model.contextWindow <= 0)
    return Math.max(MIN_MAX_TOKENS, maxTokens);
  const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

// src/thinking-signature.ts
var TYPE_SEPARATOR = "";
function signatureTypeOf(signature) {
  return signature.startsWith("sealed.") ? "sealed" : "non-sealed";
}
function packThinkingSignature(signature, signatureType) {
  if (!signatureType || signatureType === signatureTypeOf(signature)) return signature;
  return `${signatureType}${TYPE_SEPARATOR}${signature}`;
}
function unpackThinkingSignature(value) {
  if (!value) return {};
  const index = value.indexOf(TYPE_SEPARATOR);
  if (index === -1) return { signature: value, signatureType: signatureTypeOf(value) };
  return { signatureType: value.slice(0, index), signature: value.slice(index + 1) };
}

// src/chat-context-map.ts
function userContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
    }
  }
  return parts;
}
function mapContextToChat(context) {
  const messages = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const texts = [];
      const toolCalls = [];
      let thinking;
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {})
          });
        }
        if (part.type === "thinking") {
          const decoded = unpackThinkingSignature(part.thinkingSignature);
          if (part.thinking && decoded.signature) {
            thinking = {
              text: part.thinking,
              signature: decoded.signature,
              signatureType: decoded.signatureType,
              redacted: part.redacted
            };
          }
        }
      }
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : void 0,
        thinking
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      messages.push({
        role: "tool",
        content: text,
        tool_call_id: message.toolCallId
      });
    }
  }
  const tools = (context.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return { systemPrompt: context.systemPrompt || void 0, messages, tools };
}

// src/stream-devin.ts
var SOURCE_BY_ROLE = {
  user: 1,
  assistant: 2,
  tool: 4
};
function normalizeContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}
function encodeImageData(img) {
  return Buffer.concat([
    encodeString(1, img.base64Data ?? ""),
    encodeString(2, img.mimeType ?? "image/png")
  ]);
}
function encodeChatToolCall(tc) {
  return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}
function encodeChatMessagePrompt(content, source, opts) {
  const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  const parts = [
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1)
  ];
  if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId));
  for (const tc of opts?.toolCalls ?? []) parts.push(encodeMessage(6, encodeChatToolCall(tc)));
  for (const img of content.filter((part) => part.type === "image")) {
    parts.push(encodeMessage(10, encodeImageData(img)));
  }
  if (opts?.thinking) {
    parts.push(encodeString(11, opts.thinking.text));
    parts.push(encodeString(12, opts.thinking.signature));
    if (opts.thinking.redacted) parts.push(encodeVarintField(13, 1));
    if (opts.thinking.signatureType) parts.push(encodeString(18, opts.thinking.signatureType));
  }
  return Buffer.concat(parts);
}
function encodeCompletionConfiguration(maxOutputTokens) {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, maxOutputTokens),
    encodeVarintField(3, 400),
    encodeFixed64Field(5, 1),
    encodeVarintField(7, 40),
    encodeFixed64Field(8, 0.95)
  ]);
}
function encodeTrajectoryReference(trajectoryId) {
  return Buffer.concat([
    encodeString(1, trajectoryId),
    encodeVarintField(3, 4),
    encodeVarintField(4, 14)
  ]);
}
function encodeToolDef(tool) {
  const description = tool.description.length > 6998 ? `${tool.description.slice(0, 6995)}...` : tool.description;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(tool.parameters ?? {}))
  ]);
}
function buildGetChatMessageRequest(args) {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId
  });
  const prompts = args.messages.map(
    (message) => encodeMessage(
      3,
      encodeChatMessagePrompt(normalizeContent(message.content), SOURCE_BY_ROLE[message.role] ?? 1, {
        toolCallId: message.role === "tool" ? message.tool_call_id : void 0,
        toolCalls: message.role === "assistant" ? message.tool_calls : void 0,
        thinking: message.role === "assistant" ? message.thinking : void 0
      })
    )
  );
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...args.systemPrompt ? [encodeString(2, args.systemPrompt)] : [],
    ...prompts,
    encodeVarintField(7, 5),
    encodeMessage(8, encodeCompletionConfiguration(args.maxOutputTokens)),
    ...(args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool))),
    encodeMessage(15, encodeTrajectoryReference(args.trajectoryId)),
    encodeString(16, args.cascadeId),
    encodeVarintField(20, 1),
    encodeString(21, args.modelUid)
  ]);
}
function* decodeChatFrame(proto) {
  let signature;
  let signatureType;
  for (const field of iterFields(proto)) {
    if (field.num === 3 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "text", text };
    } else if (field.num === 9 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) yield { kind: "reasoning", text };
    } else if (field.num === 11 && field.wire === 0) {
      if (Number(field.value) !== 0) yield { kind: "reasoning_redacted" };
    } else if (field.num === 10 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) signature = text;
    } else if (field.num === 21 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const text = field.value.toString("utf8");
      if (text) signatureType = text;
    } else if (field.num === 6 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      let id;
      let name;
      let argsDelta;
      for (const inner of iterFields(field.value)) {
        if (inner.wire === 2 && Buffer.isBuffer(inner.value)) {
          const text = inner.value.toString("utf8");
          if (inner.num === 1) id = text;
          else if (inner.num === 2) name = text;
          else if (inner.num === 3) argsDelta = text;
        }
      }
      if (id !== void 0 && name !== void 0) yield { kind: "tool_call_start", id, name };
      if (argsDelta !== void 0) yield { kind: "tool_call_args", argsDelta, ...id ? { id } : {} };
    } else if (field.num === 5 && field.wire === 0) {
      const value = Number(field.value);
      let reason = "stop";
      if (value === 10) reason = "tool_calls";
      else if (value === 11) reason = "content_filter";
      else if (value === 1 || value === 3) reason = "length";
      yield { kind: "finish", reason };
    } else if (field.num === 28 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const usage = decodeUsage(field.value);
      if (usage) yield usage;
    }
  }
  if (signature) yield { kind: "reasoning_signature", signature, signatureType };
}
function decodeUsage(buf) {
  let promptTokens;
  let completionTokens;
  let cachedInputTokens;
  let cacheCreationInputTokens;
  for (const field of iterFields(buf)) {
    if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue;
    let metric;
    let value;
    for (const inner of iterFields(field.value)) {
      if (inner.num === 5 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        metric = inner.value.toString("utf8");
      } else if (inner.num === 4 && inner.wire === 2 && Buffer.isBuffer(inner.value)) {
        for (const dim of iterFields(inner.value)) {
          if (dim.num === 2 && dim.wire === 5 && Buffer.isBuffer(dim.value)) {
            value = dim.value.readFloatLE(0);
          }
        }
      }
    }
    if (!metric || value === void 0 || !Number.isFinite(value)) continue;
    const n = Math.round(value);
    if (metric === "input_tokens") promptTokens = n;
    else if (metric === "output_tokens") completionTokens = n;
    else if (metric.includes("cached") || metric.includes("cache_read")) cachedInputTokens = n;
    else if (metric.includes("cache_creation")) cacheCreationInputTokens = n;
  }
  if (promptTokens === void 0 && completionTokens === void 0) return null;
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    // Devin's input_tokens covers only the uncached prompt; the prefix cache is
    // reported separately. Pi's context gauge sums the components when a total
    // is absent, so an input+output total here understates the live context by
    // the whole cached prefix. Mirror Pi's own providers and include both cache
    // buckets.
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0),
    cachedInputTokens,
    cacheCreationInputTokens
  };
}
var sessionCache = /* @__PURE__ */ new Map();
function sessionIds(apiKey, host) {
  const key = `${host}${apiKey}`;
  let ids = sessionCache.get(key);
  if (!ids) {
    ids = { sessionId: randomUUID3(), cascadeId: randomUUID3(), trajectoryId: randomUUID3() };
    sessionCache.set(key, ids);
  }
  return ids;
}
async function* streamChatEvents(args) {
  const host = args.host.replace(/\/$/, "");
  const userJwt = await getCachedUserJwt(args.apiKey, host, args.signal);
  const ids = sessionIds(args.apiKey, host);
  const proto = buildGetChatMessageRequest({
    apiKey: args.apiKey,
    userJwt,
    modelUid: args.modelUid,
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    tools: args.tools,
    cascadeId: ids.cascadeId,
    trajectoryId: ids.trajectoryId,
    sessionId: ids.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: randomUUID3(),
    maxOutputTokens: args.maxOutputTokens
  });
  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip"
    },
    body: new Uint8Array(frameConnectStream(proto, true)),
    signal: args.signal
  });
  if (!resp.ok) {
    throw new Error(`GetChatMessage HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  if (!resp.body) throw new Error("GetChatMessage returned an empty body");
  const reader = resp.body.getReader();
  void reader.closed.catch(() => {
  });
  const queue = [];
  let queued = 0;
  let sawEos = false;
  let trailerError = null;
  const peek = (n) => {
    if (queued < n) return null;
    if (queue.length === 1 && queue[0].length >= n) return queue[0].subarray(0, n);
    const parts = [];
    let remaining = n;
    for (const chunk of queue) {
      if (remaining <= 0) break;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(parts, n);
  };
  const drop = (n) => {
    queued -= n;
    let remaining = n;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.length <= remaining) {
        queue.shift();
        remaining -= head.length;
      } else {
        queue[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        queue.push(Buffer.from(value));
        queued += value.length;
      }
      while (queued >= 5) {
        const header = peek(5);
        if (!header) break;
        const flags = header[0];
        const len = header.readUInt32BE(1);
        if (queued < 5 + len) break;
        drop(5);
        const raw = peek(len) ?? Buffer.alloc(0);
        drop(len);
        let payload = raw;
        if (flags & 1) payload = zlib2.gunzipSync(raw);
        if (flags & 2) {
          sawEos = true;
          const text = payload.toString("utf8");
          if (text.includes('"error"')) {
            try {
              const parsed = JSON.parse(text);
              trailerError = parsed.error?.message ?? text;
            } catch {
              trailerError = text;
            }
          }
          continue;
        }
        yield* decodeChatFrame(payload);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
    try {
      await resp.body?.cancel();
    } catch {
    }
  }
  if (trailerError) throw new Error(trailerError);
  if (!sawEos) throw new Error("Devin stream ended without an EOS trailer");
}
function streamDevin(model, context, options) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    };
    let textOpen = false;
    let thinkingOpen = false;
    let thinkingIndex = -1;
    let toolIndex = -1;
    let partialJson = "";
    let toolId = "";
    let toolName = "";
    const closeText = () => {
      if (!textOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
      }
      textOpen = false;
    };
    const closeThinking = () => {
      if (!thinkingOpen) return;
      const idx = output.content.length - 1;
      const block = output.content[idx];
      if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
      }
      thinkingOpen = false;
    };
    const closeTool = () => {
      if (toolIndex < 0) return;
      const block = output.content[toolIndex];
      if (block.type === "toolCall") {
        try {
          block.arguments = JSON.parse(partialJson);
        } catch {
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: toolIndex,
          toolCall: { type: "toolCall", id: toolId, name: toolName, arguments: block.arguments },
          partial: output
        });
      }
      toolIndex = -1;
    };
    try {
      const apiKey = options?.apiKey;
      if (!apiKey) throw new Error("No Devin credentials. Run /login devin.");
      const host = (options?.env?.DEVIN_API_SERVER_URL || "https://server.codeium.com").replace(/\/$/, "");
      const modelUid = resolveModelUid(model.id, model.thinkingLevelMap, options?.reasoning);
      const mapped = mapContextToChat(context);
      const maxOutputTokens = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
      stream.push({ type: "start", partial: output });
      for await (const event of streamChatEvents({
        apiKey,
        host,
        modelUid,
        systemPrompt: mapped.systemPrompt,
        messages: mapped.messages,
        tools: mapped.tools.length > 0 ? mapped.tools : void 0,
        maxOutputTokens,
        signal: options?.signal
      })) {
        if (event.kind === "text") {
          closeThinking();
          if (!textOpen) {
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
            textOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "text") {
            block.text += event.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "reasoning") {
          closeText();
          if (!thinkingOpen) {
            output.content.push({ type: "thinking", thinking: "" });
            thinkingIndex = output.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
            thinkingOpen = true;
          }
          const idx = output.content.length - 1;
          const block = output.content[idx];
          if (block.type === "thinking") {
            block.thinking += event.text;
            stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.text, partial: output });
          }
        } else if (event.kind === "reasoning_signature") {
          const block = thinkingIndex >= 0 ? output.content[thinkingIndex] : void 0;
          if (block?.type === "thinking") {
            block.thinkingSignature = packThinkingSignature(event.signature, event.signatureType);
          }
        } else if (event.kind === "reasoning_redacted") {
          const block = thinkingIndex >= 0 ? output.content[thinkingIndex] : void 0;
          if (block?.type === "thinking") block.redacted = true;
        } else if (event.kind === "tool_call_start") {
          closeText();
          closeThinking();
          closeTool();
          toolId = event.id;
          toolName = event.name;
          partialJson = "";
          output.content.push({ type: "toolCall", id: event.id, name: event.name, arguments: {} });
          toolIndex = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
        } else if (event.kind === "tool_call_args") {
          if (toolIndex < 0) continue;
          partialJson += event.argsDelta;
          const block = output.content[toolIndex];
          if (block.type === "toolCall") {
            try {
              block.arguments = JSON.parse(partialJson);
            } catch {
            }
          }
          stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: event.argsDelta, partial: output });
        } else if (event.kind === "finish") {
          closeText();
          closeThinking();
          closeTool();
          output.stopReason = event.reason === "tool_calls" ? "toolUse" : event.reason === "length" ? "length" : "stop";
        } else if (event.kind === "usage") {
          output.usage.input = event.promptTokens ?? 0;
          output.usage.output = event.completionTokens ?? 0;
          output.usage.cacheRead = event.cachedInputTokens ?? 0;
          output.usage.cacheWrite = event.cacheCreationInputTokens ?? 0;
          output.usage.totalTokens = event.totalTokens ?? output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }
      closeText();
      closeThinking();
      closeTool();
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

// src/windsurf-login.ts
import { randomUUID as randomUUID4 } from "node:crypto";
var ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1e3;
var WINDSURF_WEBSITE = "https://windsurf.com";
var WINDSURF_REGISTER_URL = "https://register.windsurf.com";
var WINDSURF_OAUTH_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";
var REGISTER_USER_PATH = "/exa.seat_management_pb.SeatManagementService/RegisterUser";
var WindsurfRegistrationError = class extends Error {
  status;
  connectCode;
  constructor(message, status, connectCode) {
    super(message);
    this.name = "WindsurfRegistrationError";
    this.status = status;
    this.connectCode = connectCode;
  }
};
function looksLikeDevinApiKey(value) {
  return /^(devin-session-token\$|wspkce\$|sk-ws-|cog_)/.test(value);
}
function looksLikeJwt(value) {
  return value.startsWith("eyJ") && value.includes(".");
}
function extractPastedToken(pasted) {
  const trimmed = pasted.trim().replace(/^['"]|['"]$/g, "");
  try {
    const url = new URL(trimmed);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const fromHash = hash.get("access_token") || hash.get("id_token");
    if (fromHash) return fromHash;
    const fromQuery = url.searchParams.get("access_token") || url.searchParams.get("id_token") || url.searchParams.get("firebase_id_token");
    if (fromQuery) return fromQuery;
  } catch {
  }
  return trimmed;
}
function buildSignInUrl() {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: WINDSURF_OAUTH_CLIENT_ID,
    redirect_uri: "show-auth-token",
    state: randomUUID4(),
    prompt: "login"
  });
  return `${WINDSURF_WEBSITE}/windsurf/signin?${params.toString()}`;
}
function oauthCredentials(apiKey) {
  return {
    refresh: "",
    access: apiKey,
    expires: Date.now() + ONE_YEAR_MS
  };
}
async function registerWindsurfUser(firebaseIdToken) {
  if (!firebaseIdToken) {
    throw new WindsurfRegistrationError("Empty firebase_id_token", 0, "invalid_argument");
  }
  const url = `${WINDSURF_REGISTER_URL}${REGISTER_USER_PATH}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1"
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    signal: AbortSignal.timeout(3e4)
  });
  const text = await response.text();
  if (!response.ok) {
    let connectCode;
    let message = text || `RegisterUser failed with HTTP ${response.status}`;
    try {
      const errJson = JSON.parse(text);
      connectCode = errJson.code;
      if (errJson.message) message = errJson.message;
    } catch {
    }
    throw new WindsurfRegistrationError(message, response.status, connectCode);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WindsurfRegistrationError(
      `RegisterUser returned 200 but body is not JSON: ${text.slice(0, 200)}`,
      response.status,
      "internal"
    );
  }
  if (!parsed.api_key) {
    throw new WindsurfRegistrationError(
      "RegisterUser returned 200 but api_key was empty",
      response.status,
      "malformed_response"
    );
  }
  return parsed.api_key;
}
async function loginDevinWithWindsurf(callbacks) {
  const method = await callbacks.onSelect({
    message: "How do you want to sign in to Devin?",
    options: [
      { id: "browser", label: "Browser sign-in (Windsurf)" },
      { id: "key", label: "Paste an existing API key" }
    ]
  });
  if (!method) throw new Error("Devin login cancelled.");
  if (method === "key") {
    const pasted2 = await callbacks.onPrompt({ message: "Paste your Devin API key:" });
    const apiKey2 = extractPastedToken(pasted2 ?? "");
    if (!apiKey2) throw new Error("Devin login: no API key pasted.");
    return oauthCredentials(apiKey2);
  }
  callbacks.onAuth({ url: buildSignInUrl() });
  const pasted = await callbacks.onPrompt({
    message: "Paste the token from the sign-in page (or an existing API key):"
  });
  const token = extractPastedToken(pasted ?? "");
  if (!token) throw new Error("Devin login: no token pasted.");
  if (looksLikeDevinApiKey(token) && !looksLikeJwt(token)) {
    return oauthCredentials(token);
  }
  const apiKey = await registerWindsurfUser(token);
  return oauthCredentials(apiKey);
}

// extensions/index.ts
var CATALOG_TTL_MS = 4 * 60 * 60 * 1e3;
function shouldRefreshLiveCatalog() {
  if (process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true") return false;
  const cached = readDevinCatalogCache();
  if (!cached) return true;
  return Date.now() - cached.fetchedAt > CATALOG_TTL_MS;
}
var PROVIDER_ID = "devin";
var _pi = null;
function registerDevinProvider(pi, models) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin",
    api: "devin-local",
    baseUrl: DEFAULT_DEVIN_HOST,
    models,
    oauth: {
      name: "Devin (Windsurf)",
      async login(callbacks) {
        const credentials = await loginDevinWithWindsurf(callbacks);
        if (_pi) {
          try {
            await loadLiveCatalog(_pi, credentials.access);
          } catch {
          }
        }
        return credentials;
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
      modifyModels(models2) {
        return models2;
      }
    },
    streamSimple: streamDevin
  });
}
function modelsFromCache() {
  const cached = readDevinCatalogCache();
  return cached ? modelsFromCatalog(cached.catalog) : [];
}
async function loadLiveCatalog(pi, apiKey) {
  const catalog = await fetchDevinModelCatalog(apiKey, DEFAULT_DEVIN_HOST);
  writeDevinCatalogCache({ fetchedAt: Date.now(), host: DEFAULT_DEVIN_HOST, catalog });
  registerDevinProvider(pi, modelsFromCatalog(catalog));
  return catalog;
}
function index_default(pi) {
  _pi = pi;
  registerDevinProvider(pi, modelsFromCache());
  const apiKey = readStoredDevinApiKey();
  if (apiKey && shouldRefreshLiveCatalog()) {
    void loadLiveCatalog(pi, apiKey).catch(() => {
    });
  }
  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
export {
  index_default as default
};
