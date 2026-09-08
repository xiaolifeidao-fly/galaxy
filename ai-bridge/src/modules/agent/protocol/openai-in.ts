import { z } from "zod";
import type {
  ChatMessage,
  ChatRequest,
  ContentBlock,
  ToolChoice,
  ToolDefinition,
} from "../adapters/types.js";

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const ImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }),
});
const AudioPart = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({ data: z.string(), format: z.string() }),
});
const FilePart = z.object({
  type: z.literal("file"),
  file: z.union([
    z.object({ file_id: z.string() }),
    z.object({
      file_data: z.string(), // "data:application/pdf;base64,..."
      filename: z.string().optional(),
    }),
  ]),
});
const ContentPart = z.union([
  TextPart,
  ImagePart,
  AudioPart,
  FilePart,
  z.object({ type: z.string() }).passthrough(),
]);

const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const Message = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCall).optional(),
});

const Tool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).default({}),
  }),
});

const ToolChoiceS = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);

export const OpenAIChatBodySchema = z
  .object({
    model: z.string().optional().default("default"),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    tools: z.array(Tool).optional(),
    tool_choice: ToolChoiceS.optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  })
  .passthrough();

export type OpenAIChatBody = z.infer<typeof OpenAIChatBodySchema>;

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function partsToBlocks(parts: any[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const du = parseDataUrl(p.image_url.url);
      if (du) out.push({ type: "image", mediaType: du.mediaType, data: du.data });
      else out.push({ type: "image", mediaType: "image/jpeg", url: p.image_url.url });
    } else if (p.type === "input_audio") {
      out.push({ type: "audio", format: p.input_audio.format, data: p.input_audio.data });
    } else if (p.type === "file") {
      if ("file_id" in p.file) {
        out.push({ type: "file", mediaType: "application/octet-stream", fileId: p.file.file_id });
      } else {
        const du = parseDataUrl(p.file.file_data);
        if (du) {
          out.push({
            type: "file",
            mediaType: du.mediaType,
            data: du.data,
            filename: p.file.filename,
          });
        }
      }
    }
  }
  return out;
}

function messageToBlocks(m: any): ChatMessage[] {
  if (m.role === "tool") {
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
        ? m.content.map((p: any) => (p?.type === "text" ? p.text : "")).join("")
        : "";
    return [{
      role: "user",
      content: [{ type: "tool_result", toolUseId: m.tool_call_id ?? "", content }],
    }];
  }

  if (m.role === "assistant" && m.tool_calls?.length) {
    const blocks: ContentBlock[] = [];
    if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) blocks.push(...partsToBlocks(m.content));
    for (const tc of m.tool_calls) {
      let parsed: unknown = {};
      try { parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { parsed = tc.function.arguments; }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
    }
    return [{ role: "assistant", content: blocks }];
  }

  const role: "system" | "user" | "assistant" =
    m.role === "developer" ? "system" : m.role;
  let content: ContentBlock[] = [];
  if (typeof m.content === "string") content = m.content ? [{ type: "text", text: m.content }] : [];
  else if (Array.isArray(m.content)) content = partsToBlocks(m.content);
  return [{ role, content }];
}

function convertToolChoice(tc: any): ToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === "string") return tc as ToolChoice;
  if (tc?.type === "function") return { name: tc.function.name };
  return undefined;
}

function convertTools(tools?: any[]): ToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters ?? {},
  }));
}

export function openaiToInternal(body: OpenAIChatBody): ChatRequest {
  const {
    model, messages, stream, temperature, top_p,
    max_tokens, max_completion_tokens, stop,
    tools, tool_choice, reasoning_effort,
    ...rest
  } = body as any;
  const internalMessages: ChatMessage[] = [];
  for (const m of messages) internalMessages.push(...messageToBlocks(m));
  return {
    model,
    messages: internalMessages,
    stream: !!stream,
    temperature,
    top_p,
    max_tokens: max_completion_tokens ?? max_tokens,
    stop,
    tools: convertTools(tools),
    tool_choice: convertToolChoice(tool_choice),
    ...(reasoning_effort ? { reasoning: { effort: reasoning_effort } } : {}),
    passthrough: rest,
  };
}
