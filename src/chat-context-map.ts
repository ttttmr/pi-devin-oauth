import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { unpackThinkingSignature, type ChatThinking } from "./thinking-signature.js";

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  base64Data?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  /** Prior reasoning, replayed so the server can verify and continue it. */
  thinking?: ChatThinking;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface MappedChat {
  /** Goes into GetChatMessageRequest.prompt, the server's system slot. */
  systemPrompt?: string;
  messages: ChatHistoryItem[];
  tools: ToolDef[];
}

type RuntimeSystemMessage = {
  role: "system";
  content: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string }>;
};

function isRuntimeSystemMessage(message: unknown): message is RuntimeSystemMessage {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "system");
}

function textFromRuntimeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function runtimeSystemPrompt(messages: RuntimeSystemMessage[]): string | undefined {
  if (messages.length === 0) return undefined;

  const contentParts: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    const content = textFromRuntimeContent(message.content);
    if (content) contentParts.push(content);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }

  const parts = [...contentParts, ...sections.values()].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function runtimeSystemTools(messages: RuntimeSystemMessage[], fallback?: Tool[]): Tool[] | undefined {
  const tools = new Map<string, Tool>();
  let hasToolDeclarations = false;
  for (const message of messages) {
    for (const tool of message.toolsRemoved ?? []) {
      hasToolDeclarations = true;
      tools.delete(tool.name);
    }
    for (const tool of message.toolsAdded ?? []) {
      hasToolDeclarations = true;
      tools.set(tool.name, tool);
    }
  }
  return hasToolDeclarations ? [...tools.values()] : fallback;
}

/** Remove runtime system messages and project their text into Devin's system slot. */
export function normalizeContextForDevin(context: Context): Context {
  const runtimeMessages = context.messages as unknown as Array<unknown>;
  const systemMessages = runtimeMessages.filter(isRuntimeSystemMessage);
  const systemPrompt = runtimeSystemPrompt(systemMessages);
  const existingSystemPrompt = context.systemPrompt;
  const combinedSystemPrompt = [existingSystemPrompt, systemPrompt]
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join("\n\n");
  const messages = runtimeMessages.filter((message) => !isRuntimeSystemMessage(message)) as Message[];
  const tools = runtimeSystemTools(systemMessages, context.tools);

  return {
    ...context,
    ...(combinedSystemPrompt ? { systemPrompt: combinedSystemPrompt } : { systemPrompt: undefined }),
    ...(tools ? { tools } : {}),
    messages,
  };
}

function userContent(content: Message["content"]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
    }
  }
  return parts;
}

/** Map a Pi Context onto Cognition chat history + tools. */
export function mapContextToChat(context: Context): MappedChat {
  const normalizedContext = normalizeContextForDevin(context);
  const messages: ChatHistoryItem[] = [];

  for (const message of normalizedContext.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let thinking: ChatThinking | undefined;
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
        if (part.type === "thinking") {
          const decoded = unpackThinkingSignature(part.thinkingSignature);
          if (part.thinking && decoded.signature) {
            thinking = {
              text: part.thinking,
              signature: decoded.signature,
              signatureType: decoded.signatureType,
              redacted: part.redacted,
            };
          }
        }
      }
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      messages.push({
        role: "tool",
        content: text,
        tool_call_id: message.toolCallId,
      });
    }
  }

  const tools: ToolDef[] = (normalizedContext.tools ?? []).map((tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return { systemPrompt: normalizedContext.systemPrompt || undefined, messages, tools };
}
