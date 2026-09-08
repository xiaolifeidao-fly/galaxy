import type { Response } from "express";
import type { ChatChunk } from "../adapters/types.js";

function sseWrite(res: Response, data: unknown) {
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function writeSSEHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

// 工具调用索引 → OpenAI tool_calls 数组里的 id（同序号）
interface ToolSlot {
  id: string;
  name: string;
  args: string;
}

export async function streamInternalToOpenAISSE(
  res: Response,
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };

  sseWrite(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  for await (const chunk of stream) {
    if (chunk.type === "text") {
      sseWrite(res, {
        ...base,
        choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
      });
    } else if (chunk.type === "thinking_delta") {
      // DeepSeek / 国内厂商常用 reasoning_content 通道，vanilla OpenAI 客户端会忽略
      sseWrite(res, {
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: chunk.delta }, finish_reason: null }],
      });
    } else if (chunk.type === "thinking_signature") {
      // 无标准对应字段，丢弃
    } else if (chunk.type === "tool_use_start") {
      sseWrite(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: chunk.index,
              id: chunk.id,
              type: "function",
              function: { name: chunk.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      });
    } else if (chunk.type === "tool_use_args_delta") {
      sseWrite(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: chunk.index,
              function: { arguments: chunk.partialJson },
            }],
          },
          finish_reason: null,
        }],
      });
    } else if (chunk.type === "tool_use_stop") {
      // OpenAI 流里没有显式的 tool_use stop，跳过
    } else if (chunk.type === "done") {
      sseWrite(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: chunk.finish_reason ?? "stop" }],
        ...(chunk.usage ? { usage: chunk.usage } : {}),
      });
    }
  }
  sseWrite(res, "[DONE]");
  res.end();
}

export async function collectInternalToOpenAIJson(
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  let content = "";
  let reasoningContent = "";
  let finishReason: any = "stop";
  let usage: any;
  const toolSlots = new Map<number, ToolSlot>();

  for await (const chunk of stream) {
    if (chunk.type === "text") content += chunk.delta;
    else if (chunk.type === "thinking_delta") reasoningContent += chunk.delta;
    else if (chunk.type === "tool_use_start") {
      toolSlots.set(chunk.index, { id: chunk.id, name: chunk.name, args: "" });
    } else if (chunk.type === "tool_use_args_delta") {
      const slot = toolSlots.get(chunk.index);
      if (slot) slot.args += chunk.partialJson;
    } else if (chunk.type === "done") {
      finishReason = chunk.finish_reason ?? "stop";
      usage = chunk.usage;
    }
  }

  const tool_calls = [...toolSlots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, s]) => ({
      id: s.id,
      type: "function" as const,
      function: { name: s.name, arguments: s.args },
    }));

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(tool_calls.length ? { tool_calls } : {}),
      },
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };
}
