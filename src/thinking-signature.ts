/**
 * Devin streams a thinking summary plus an opaque signature. The signature
 * must be replayed on the next request so the server can continue the trace.
 * Pi stores one string per thinking block (`thinkingSignature`); the type
 * is prefixed only when it cannot be inferred from the signature itself.
 */

const TYPE_SEPARATOR = "\u001f";

export interface ChatThinking {
  /** Thinking text as sent by the server (already summarized upstream). */
  text: string;
  /** Opaque signature for server-side verification/continuation. */
  signature: string;
  /** `signature_type` reported by the server. */
  signatureType?: string;
  /** Server flagged the trace as redacted by safety filters. */
  redacted?: boolean;
}

export function signatureTypeOf(signature: string): string {
  return signature.startsWith("sealed.") ? "sealed" : "non-sealed";
}

/** Store `signature` in pi's `thinkingSignature` without losing the type. */
export function packThinkingSignature(signature: string, signatureType?: string): string {
  if (!signatureType || signatureType === signatureTypeOf(signature)) return signature;
  return `${signatureType}${TYPE_SEPARATOR}${signature}`;
}

export function unpackThinkingSignature(value: string | undefined): {
  signature?: string;
  signatureType?: string;
} {
  if (!value) return {};
  const index = value.indexOf(TYPE_SEPARATOR);
  if (index === -1) return { signature: value, signatureType: signatureTypeOf(value) };
  return { signatureType: value.slice(0, index), signature: value.slice(index + 1) };
}
