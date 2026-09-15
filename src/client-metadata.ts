import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./connect-wire.js";

/**
 * Cognition gates Devin Local-only models (Sol / Terra / Luna, Opus 5, Fable 5)
 * by client IDE name. `windsurf` is rejected with "This model is only in Devin
 * Local."; `devin-desktop` is accepted. Chat/GetChatMessage must use this.
 */
export const CLIENT_IDE = "devin-desktop";

/**
 * GetCliModelConfigs / GetCascadeModelConfigs only return the real family list
 * when ide is `windsurf`. `devin-desktop` comes back as an empty/BYOK stub.
 */
export const CATALOG_CLIENT_IDE = "windsurf";

/** Windsurf/Devin Desktop version string the API server accepts. */
export const CLIENT_VERSION = "3.6.27";

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  version?: string;
  ide?: string;
}

/** Build the Metadata protobuf attached to every Devin RPC. */
export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.version ?? CLIENT_VERSION;
  const ide = input.ide ?? CLIENT_IDE;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const parts: Buffer[] = [
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
    encodeString(28, ide),
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
