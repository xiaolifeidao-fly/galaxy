import { z } from "zod";
import type {
  ChatMessage,
  ChatRequest,
  ContentBlock,
  ToolChoice,
  ToolDefinition,
} from "../adapters/types.js";

// ── Responses API 输入块（input item 内的 content part）────────────────────
const InputTextPart = z.object({ type: z.literal("input_text"), text: z.string() });
const OutputTextPart = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.any()).optional(),
});
const InputImagePart = z.object({
  type: z.literal("input_image"),
  image_url: z.string().optional(),
  file_id: z.string().optional(),
  detail: z.string().optional(),
});
const InputFilePart = z.object({
  type: z.literal("input_file"),
  file_id: z.string().optional(),
  filename: z.string().optional(),
  file_data: z.string().optional(),
});
const AnyPart = z.union([
  InputTextPart,
  OutputTextPart,
  InputImagePart,
  InputFilePart,
  z.object({ type: z.string() }).passthrough(),
]);

// ── input item（数组形态）────────────────────────────────────────────────
const MessageItem = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(AnyPart)]),
});
const FunctionCallItem = z.object({
  type: z.literal("function_call"),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const FunctionCallOutputItem = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.union([z.string(), z.array(z.any()), z.record(z.any())]),
});
const InputItem = z.union([
  FunctionCallItem,
  FunctionCallOutputItem,
  MessageItem,
  z.object({ type: z.string() }).passthrough(), // reasoning / item_reference 等，忽略
]);

// ── tools（Responses 的 function 是扁平结构，不嵌在 function 字段下）────────
const ToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional().nullable(),
  parameters: z.record(z.unknown()).optional().default({}),
  strict: z.boolean().optional().nullable(),
});

const ToolChoiceS = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({ type: z.literal("function"), name: z.string() }),
  z.object({ type: z.string() }).passthrough(),
]);

export const ResponsesBodySchema = z
  .object({
    model: z.string().optional().default("default"),
    input: z.union([z.string(), z.array(InputItem)]),
    instructions: z.string().optional().nullable(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional().nullable(),
    top_p: z.number().optional().nullable(),
    max_output_tokens: z.number().int().positive().optional().nullable(),
    tools: z.array(z.union([ToolSchema, z.object({ type: z.string() }).passthrough()])).optional(),
    tool_choice: ToolChoiceS.optional(),
    reasoning: z
      .object({
        effort: z.enum(["minimal", "low", "medium", "high"]).optional().nullable(),
        summary: z.any().optional(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

export type ResponsesBody = z.infer<typeof ResponsesBodySchema>;

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function partsToBlocks(parts: any[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const p of parts) {
    if (p.type === "input_text" || p.type === "output_text") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if (p.type === "input_image") {
      if (p.image_url) {
        const du = parseDataUrl(p.image_url);
        if (du) out.push({ type: "image", mediaType: du.mediaType, data: du.data });
        else out.push({ type: "image", mediaType: "image/jpeg", url: p.image_url });
      } else if (p.file_id) {
        out.push({ type: "file", mediaType: "application/octet-stream", fileId: p.file_id });
      }
    } else if (p.type === "input_file") {
      if (p.file_data) {
        const du = parseDataUrl(p.file_data);
        if (du) out.push({ type: "file", mediaType: du.mediaType, data: du.data, filename: p.filename });
      } else if (p.file_id) {
        out.push({ type: "file", mediaType: "application/octet-stream", fileId: p.file_id, filename: p.filename });
      }
    }
  }
  return out;
}

function itemToMessages(item: any): ChatMessage[] {
  // function_call → assistant 的 tool_use
  if (item.type === "function_call") {
    let parsed: unknown = {};
    try { parsed = item.arguments ? JSON.parse(item.arguments) : {}; } catch { parsed = item.arguments; }
    return [{
      role: "assistant",
      content: [{ type: "tool_use", id: item.call_id, name: item.name, input: parsed }],
    }];
  }
  // function_call_output → user 的 tool_result
  if (item.type === "function_call_output") {
    const content =
      typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    return [{
      role: "user",
      content: [{ type: "tool_result", toolUseId: item.call_id, content }],
    }];
  }
  // message（type 可省略；有 role 即视为消息）
  if (item.role) {
    const role: "system" | "user" | "assistant" =
      item.role === "developer" ? "system" : item.role;
    let content: ContentBlock[] = [];
    if (typeof item.content === "string") content = item.content ? [{ type: "text", text: item.content }] : [];
    else if (Array.isArray(item.content)) content = partsToBlocks(item.content);
    return [{ role, content }];
  }
  // reasoning / 其它 → 忽略（adapter 也只消费 text）
  return [];
}

function convertTools(tools?: any[]): ToolDefinition[] | undefined {
  const fns = (tools ?? []).filter((t) => t?.type === "function");
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    name: t.name,
    description: t.description ?? undefined,
    parameters: t.parameters ?? {},
  }));
}

function convertToolChoice(tc: any): ToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === "string") return tc as ToolChoice;
  if (tc?.type === "function" && tc.name) return { name: tc.name };
  return undefined;
}

export function responsesToInternal(body: ResponsesBody): ChatRequest {
  const messages: ChatMessage[] = [];

  // instructions → 开头的 system 消息
  if (body.instructions) {
    messages.push({ role: "system", content: [{ type: "text", text: body.instructions }] });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: body.input }] });
  } else {
    for (const item of body.input) messages.push(...itemToMessages(item));
  }

  const reasoningEffort = body.reasoning?.effort ?? undefined;

  return {
    model: body.model,
    messages,
    stream: !!body.stream,
    temperature: body.temperature ?? undefined,
    top_p: body.top_p ?? undefined,
    max_tokens: body.max_output_tokens ?? undefined,
    tools: convertTools(body.tools),
    tool_choice: convertToolChoice(body.tool_choice),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  };
}
