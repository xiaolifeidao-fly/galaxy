import { z } from "zod";
import type {
  CacheHint,
  ChatMessage,
  ChatRequest,
  ContentBlock,
  ToolChoice,
} from "../adapters/types.js";

const CacheControlSchema = z
  .object({ type: z.literal("ephemeral"), ttl: z.enum(["5m", "1h"]).optional() })
  .optional();

const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControlSchema,
});
const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
  cache_control: CacheControlSchema,
});
const DocumentBlock = z.object({
  type: z.literal("document"),
  source: z.union([
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
  cache_control: CacheControlSchema,
});
const ThinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  cache_control: CacheControlSchema,
});
const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z
    .union([
      z.string(),
      z.array(z.union([TextBlock, z.object({ type: z.string() }).passthrough()])),
    ])
    .optional(),
  is_error: z.boolean().optional(),
  cache_control: CacheControlSchema,
});

const ContentBlockSchema = z.union([
  TextBlock,
  ImageBlock,
  DocumentBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  z.object({ type: z.string() }).passthrough(),
]);

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).default({}),
  cache_control: CacheControlSchema,
});

const ToolChoiceSchema = z.union([
  z.object({ type: z.literal("auto") }),
  z.object({ type: z.literal("any") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("tool"), name: z.string() }),
]);

const ThinkingSchema = z.object({
  type: z.enum(["enabled", "disabled"]),
  budget_tokens: z.number().int().positive().optional(),
});

export const AnthropicMessagesBodySchema = z
  .object({
    model: z.string().optional().default("default"),
    messages: z.array(MessageSchema).min(1),
    system: z
      .union([
        z.string(),
        z.array(
          z.union([TextBlock, z.object({ type: z.string() }).passthrough()])
        ),
      ])
      .optional(),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    thinking: ThinkingSchema.optional(),
  })
  .passthrough();

export type AnthropicMessagesBody = z.infer<typeof AnthropicMessagesBodySchema>;

function toCacheHint(cc: any): CacheHint | undefined {
  if (!cc) return undefined;
  return { type: "ephemeral", ttl: cc.ttl };
}

function blockToInternal(b: any): ContentBlock | null {
  const cacheHint = toCacheHint(b.cache_control);
  if (b.type === "text") {
    return { type: "text", text: b.text, ...(cacheHint ? { cacheHint } : {}) };
  }
  if (b.type === "image") {
    if (b.source.type === "base64") {
      return { type: "image", mediaType: b.source.media_type, data: b.source.data, ...(cacheHint ? { cacheHint } : {}) };
    }
    return { type: "image", mediaType: "image/jpeg", url: b.source.url, ...(cacheHint ? { cacheHint } : {}) };
  }
  if (b.type === "document") {
    if (b.source.type === "base64") {
      return { type: "file", mediaType: b.source.media_type, data: b.source.data, ...(cacheHint ? { cacheHint } : {}) };
    }
    return { type: "file", mediaType: "application/pdf", url: b.source.url, ...(cacheHint ? { cacheHint } : {}) };
  }
  if (b.type === "thinking") {
    return { type: "thinking", text: b.thinking, signature: b.signature };
  }
  if (b.type === "tool_use") {
    return { type: "tool_use", id: b.id, name: b.name, input: b.input, ...(cacheHint ? { cacheHint } : {}) };
  }
  if (b.type === "tool_result") {
    let text = "";
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) text = b.content.map((p: any) => (p?.type === "text" ? p.text : "")).join("");
    return { type: "tool_result", toolUseId: b.tool_use_id, content: text, isError: b.is_error, ...(cacheHint ? { cacheHint } : {}) };
  }
  return null;
}

function blocksFromContent(content: any): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    const c = blockToInternal(b);
    if (c) out.push(c);
  }
  return out;
}

function systemToBlocks(sys: any): ContentBlock[] {
  if (!sys) return [];
  if (typeof sys === "string") return [{ type: "text", text: sys }];
  if (Array.isArray(sys)) {
    const out: ContentBlock[] = [];
    for (const b of sys) {
      if (b?.type === "text") {
        out.push({
          type: "text",
          text: b.text,
          ...(b.cache_control ? { cacheHint: toCacheHint(b.cache_control)! } : {}),
        });
      }
    }
    return out;
  }
  return [];
}

function convertToolChoice(tc: any): ToolChoice | undefined {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto": return "auto";
    case "none": return "none";
    case "any": return "required";
    case "tool": return { name: tc.name };
  }
  return undefined;
}

export function anthropicToInternal(body: AnthropicMessagesBody): ChatRequest {
  const { model, messages, system, max_tokens, stream, temperature, top_p, stop_sequences, tools, tool_choice, thinking, ...rest } = body as any;

  const internalMessages: ChatMessage[] = [];
  const sysBlocks = systemToBlocks(system);
  if (sysBlocks.length) internalMessages.push({ role: "system", content: sysBlocks });
  for (const m of messages) {
    internalMessages.push({ role: m.role, content: blocksFromContent(m.content) });
  }

  return {
    model,
    messages: internalMessages,
    stream: !!stream,
    temperature,
    top_p,
    max_tokens,
    stop: stop_sequences,
    tools: tools?.map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? {},
      ...(t.cache_control ? { cacheHint: toCacheHint(t.cache_control)! } : {}),
    })),
    tool_choice: convertToolChoice(tool_choice),
    ...(thinking?.type === "enabled"
      ? { thinking: { enabled: true, budgetTokens: thinking.budget_tokens } }
      : {}),
    passthrough: rest,
  };
}
