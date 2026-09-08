import type { Response } from "express";
import type { ChatChunk } from "../adapters/types.js";
import { writeSSEHeaders } from "./openai-out.js";

function sseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function mapFinishReason(r: any): string {
  if (!r) return "end_turn";
  if (r === "stop") return "end_turn";
  if (r === "length") return "max_tokens";
  if (r === "tool_calls") return "tool_use";
  return r;
}

export { writeSSEHeaders };

interface BlockState {
  kind: "text" | "thinking" | "tool_use";
  index: number;
  // 用于 tool_use：内部 index → block index 的反向
  toolIdx?: number;
}

export async function streamInternalToAnthropicSSE(
  res: Response,
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  sseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let currentBlock: BlockState | null = null;
  let nextBlockIndex = 0;
  const toolBlockIndex = new Map<number, number>();

  let stopReason = "end_turn";
  let usage: any;

  const closeCurrent = () => {
    if (currentBlock) {
      sseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: currentBlock.index,
      });
      currentBlock = null;
    }
  };

  const ensureKind = (kind: "text" | "thinking", openPayload: any) => {
    if (currentBlock?.kind === kind) return;
    closeCurrent();
    const index = nextBlockIndex++;
    sseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: openPayload,
    });
    currentBlock = { kind, index };
  };

  for await (const chunk of stream) {
    if (chunk.type === "text") {
      ensureKind("text", { type: "text", text: "" });
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: currentBlock!.index,
        delta: { type: "text_delta", text: chunk.delta },
      });
    } else if (chunk.type === "thinking_delta") {
      ensureKind("thinking", { type: "thinking", thinking: "" });
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: currentBlock!.index,
        delta: { type: "thinking_delta", thinking: chunk.delta },
      });
    } else if (chunk.type === "thinking_signature") {
      if (currentBlock?.kind === "thinking") {
        sseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: currentBlock.index,
          delta: { type: "signature_delta", signature: chunk.signature },
        });
      }
    } else if (chunk.type === "tool_use_start") {
      closeCurrent();
      const index = nextBlockIndex++;
      toolBlockIndex.set(chunk.index, index);
      currentBlock = { kind: "tool_use", index, toolIdx: chunk.index };
      sseEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} },
      });
    } else if (chunk.type === "tool_use_args_delta") {
      const idx = toolBlockIndex.get(chunk.index);
      if (idx !== undefined) {
        sseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: chunk.partialJson },
        });
      }
    } else if (chunk.type === "tool_use_stop") {
      const idx = toolBlockIndex.get(chunk.index);
      if (idx !== undefined && currentBlock?.index === idx) {
        closeCurrent();
      }
    } else if (chunk.type === "done") {
      stopReason = mapFinishReason(chunk.finish_reason);
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: chunk.usage.cache_read_input_tokens }
            : {}),
          ...(chunk.usage.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens }
            : {}),
        };
      }
    }
  }

  closeCurrent();
  sseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  });
  sseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

interface ToolAccum {
  id: string;
  name: string;
  args: string;
}

export async function collectInternalToAnthropicJson(
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  let text = "";
  let thinkingText = "";
  let thinkingSig: string | undefined;
  const tools = new Map<number, ToolAccum>();
  let stopReason = "end_turn";
  let usage: any;

  for await (const chunk of stream) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "thinking_delta") thinkingText += chunk.delta;
    else if (chunk.type === "thinking_signature") thinkingSig = chunk.signature;
    else if (chunk.type === "tool_use_start") tools.set(chunk.index, { id: chunk.id, name: chunk.name, args: "" });
    else if (chunk.type === "tool_use_args_delta") {
      const t = tools.get(chunk.index);
      if (t) t.args += chunk.partialJson;
    } else if (chunk.type === "done") {
      stopReason = mapFinishReason(chunk.finish_reason);
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: chunk.usage.cache_read_input_tokens }
            : {}),
          ...(chunk.usage.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens }
            : {}),
        };
      }
    }
  }

  const contentBlocks: any[] = [];
  if (thinkingText) {
    contentBlocks.push({
      type: "thinking",
      thinking: thinkingText,
      ...(thinkingSig ? { signature: thinkingSig } : {}),
    });
  }
  if (text) contentBlocks.push({ type: "text", text });
  for (const [, t] of [...tools.entries()].sort(([a], [b]) => a - b)) {
    let input: unknown = {};
    try { input = t.args ? JSON.parse(t.args) : {}; } catch { input = t.args; }
    contentBlocks.push({ type: "tool_use", id: t.id, name: t.name, input });
  }

  return {
    id: `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage ? { usage } : {}),
  };
}
