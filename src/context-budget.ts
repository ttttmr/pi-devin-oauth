import {
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { normalizeContextForDevin } from "./chat-context-map.js";

/** Clamp Devin's output reservation after normalizing resumed system messages. */
export function clampMaxTokensForDevin(model: Model<Api>, context: Context, maxTokens: number): number {
  const normalizedContext = normalizeContextForDevin(context);
  return clampMaxTokensToContext(
    model,
    normalizedContext as Parameters<typeof clampMaxTokensToContext>[1],
    maxTokens,
  );
}
