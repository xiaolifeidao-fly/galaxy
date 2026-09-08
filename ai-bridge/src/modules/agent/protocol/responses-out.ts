import type { Response } from "express";
import { randomUUID } from "node:crypto";
import type { ChatChunk } from "../adapters/types.js";

export function writeSSEHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

const rid = () => randomUUID().replace(/-/g, "").slice(0, 24);

type DoneUsage = Extract<ChatChunk, { type: "done" }>["usage"];

function mapUsage(u?: DoneUsage) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens:
      u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

function responseEnvelope(
  id: string,
  createdAt: number,
  model: string,
  status: string,
  output: any[],
  usage: any
) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage,
    metadata: {},
  };
}

export async function streamInternalToResponsesSSE(
  res: Response,
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  const responseId = `resp_${rid()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const send = (type: string, data: Record<string, unknown>) => {
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: seq++ })}\n\n`
    );
  };

  send("response.created", {
    response: responseEnvelope(responseId, createdAt, model, "in_progress", [], null),
  });
  send("response.in_progress", {
    response: responseEnvelope(responseId, createdAt, model, "in_progress", [], null),
  });

  let outputIndex = -1;
  const finalOutput: any[] = [];

  // reasoning item
  let reasoningOpen = false;
  let reasoningIndex = -1;
  let reasoningItemId = "";
  let reasoningText = "";

  // message item
  let messageOpen = false;
  let messageEverOpened = false;
  let messageIndex = -1;
  let messageItemId = "";
  let messageText = "";

  // tool calls：内部 chunk.index → 状态
  const tools = new Map<
    number,
    { outputIndex: number; itemId: string; callId: string; name: string; args: string }
  >();

  const openReasoning = () => {
    reasoningOpen = true;
    reasoningIndex = ++outputIndex;
    reasoningItemId = `rs_${rid()}`;
    send("response.output_item.added", {
      output_index: reasoningIndex,
      item: { type: "reasoning", id: reasoningItemId, summary: [] },
    });
    send("response.reasoning_summary_part.added", {
      item_id: reasoningItemId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  };
  const closeReasoning = () => {
    if (!reasoningOpen) return;
    send("response.reasoning_summary_text.done", {
      item_id: reasoningItemId,
      output_index: reasoningIndex,
      summary_index: 0,
      text: reasoningText,
    });
    send("response.reasoning_summary_part.done", {
      item_id: reasoningItemId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: reasoningText },
    });
    const item = {
      type: "reasoning",
      id: reasoningItemId,
      summary: reasoningText ? [{ type: "summary_text", text: reasoningText }] : [],
    };
    send("response.output_item.done", { output_index: reasoningIndex, item });
    finalOutput.push(item);
    reasoningOpen = false;
  };

  const openMessage = () => {
    messageOpen = true;
    messageEverOpened = true;
    messageText = "";
    messageIndex = ++outputIndex;
    messageItemId = `msg_${rid()}`;
    send("response.output_item.added", {
      output_index: messageIndex,
      item: { type: "message", id: messageItemId, role: "assistant", status: "in_progress", content: [] },
    });
    send("response.content_part.added", {
      item_id: messageItemId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };
  const closeMessage = () => {
    if (!messageOpen) return;
    send("response.output_text.done", {
      item_id: messageItemId,
      output_index: messageIndex,
      content_index: 0,
      text: messageText,
    });
    send("response.content_part.done", {
      item_id: messageItemId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text: messageText, annotations: [] },
    });
    const item = {
      type: "message",
      id: messageItemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: messageText, annotations: [] }],
    };
    send("response.output_item.done", { output_index: messageIndex, item });
    finalOutput.push(item);
    messageOpen = false;
  };

  const emitImage = (mediaType: string, data: string) => {
    if (reasoningOpen) closeReasoning();
    if (messageOpen) closeMessage();
    const oi = ++outputIndex;
    const itemId = `ig_${rid()}`;
    send("response.output_item.added", {
      output_index: oi,
      item: { type: "image_generation_call", id: itemId, status: "in_progress" },
    });
    const item = {
      type: "image_generation_call",
      id: itemId,
      status: "completed",
      result: data,
      output_format: mediaType.split("/")[1] || "png",
    };
    send("response.output_item.done", { output_index: oi, item });
    finalOutput.push(item);
  };

  // 往 assistant 消息里追加文本（必要时先关 reasoning、开 message）
  const appendText = (delta: string) => {
    if (reasoningOpen) closeReasoning();
    if (!messageOpen) openMessage();
    messageText += delta;
    send("response.output_text.delta", {
      item_id: messageItemId,
      output_index: messageIndex,
      content_index: 0,
      delta,
    });
  };

  let usage: any = null;

  for await (const chunk of stream) {
    if (chunk.type === "image") {
      emitImage(chunk.mediaType, chunk.data);
    } else if (chunk.type === "file") {
      // Responses 无原生"生成文件"输出项，内联进 assistant 文本，客户端可据此还原/保存
      const body =
        chunk.text !== undefined
          ? `\n\n[file: ${chunk.name}]\n${chunk.text}\n`
          : `\n\n[file: ${chunk.name} | base64 ${chunk.mediaType}]\n${chunk.data}\n`;
      appendText(body);
    } else if (chunk.type === "thinking_delta") {
      // reasoning 只能在 message 之前出；message 已开则丢弃乱序的 reasoning
      if (messageEverOpened) continue;
      if (!reasoningOpen) openReasoning();
      reasoningText += chunk.delta;
      send("response.reasoning_summary_text.delta", {
        item_id: reasoningItemId,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: chunk.delta,
      });
    } else if (chunk.type === "text") {
      appendText(chunk.delta);
    } else if (chunk.type === "tool_use_start") {
      if (reasoningOpen) closeReasoning();
      if (messageOpen) closeMessage();
      const oi = ++outputIndex;
      const itemId = `fc_${rid()}`;
      tools.set(chunk.index, { outputIndex: oi, itemId, callId: chunk.id, name: chunk.name, args: "" });
      send("response.output_item.added", {
        output_index: oi,
        item: { type: "function_call", id: itemId, call_id: chunk.id, name: chunk.name, arguments: "" },
      });
    } else if (chunk.type === "tool_use_args_delta") {
      const t = tools.get(chunk.index);
      if (t) {
        t.args += chunk.partialJson;
        send("response.function_call_arguments.delta", {
          item_id: t.itemId,
          output_index: t.outputIndex,
          delta: chunk.partialJson,
        });
      }
    } else if (chunk.type === "tool_use_stop") {
      const t = tools.get(chunk.index);
      if (t) {
        send("response.function_call_arguments.done", {
          item_id: t.itemId,
          output_index: t.outputIndex,
          arguments: t.args,
        });
        const item = {
          type: "function_call",
          id: t.itemId,
          call_id: t.callId,
          name: t.name,
          arguments: t.args,
          status: "completed",
        };
        send("response.output_item.done", { output_index: t.outputIndex, item });
        finalOutput.push(item);
      }
    } else if (chunk.type === "done") {
      usage = mapUsage(chunk.usage);
    }
  }

  // 收尾：关掉未结束的 item（含没有 tool_use_stop 的工具调用）
  if (reasoningOpen) closeReasoning();
  if (messageOpen) closeMessage();
  for (const t of tools.values()) {
    if (finalOutput.some((o) => o.id === t.itemId)) continue;
    send("response.function_call_arguments.done", {
      item_id: t.itemId,
      output_index: t.outputIndex,
      arguments: t.args,
    });
    const item = {
      type: "function_call",
      id: t.itemId,
      call_id: t.callId,
      name: t.name,
      arguments: t.args,
      status: "completed",
    };
    send("response.output_item.done", { output_index: t.outputIndex, item });
    finalOutput.push(item);
  }

  send("response.completed", {
    response: responseEnvelope(responseId, createdAt, model, "completed", finalOutput, usage),
  });
  res.end();
}

export async function collectInternalToResponsesJson(
  model: string,
  stream: AsyncIterable<ChatChunk>
) {
  const responseId = `resp_${rid()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  let messageText = "";
  let reasoningText = "";
  let usage: any = null;
  const images: { mediaType: string; data: string }[] = [];
  const toolSlots = new Map<number, { id: string; callId: string; name: string; args: string }>();

  for await (const chunk of stream) {
    if (chunk.type === "text") messageText += chunk.delta;
    else if (chunk.type === "thinking_delta") reasoningText += chunk.delta;
    else if (chunk.type === "image") images.push({ mediaType: chunk.mediaType, data: chunk.data });
    else if (chunk.type === "file") {
      messageText +=
        chunk.text !== undefined
          ? `\n\n[file: ${chunk.name}]\n${chunk.text}\n`
          : `\n\n[file: ${chunk.name} | base64 ${chunk.mediaType}]\n${chunk.data}\n`;
    } else if (chunk.type === "tool_use_start") {
      toolSlots.set(chunk.index, { id: `fc_${rid()}`, callId: chunk.id, name: chunk.name, args: "" });
    } else if (chunk.type === "tool_use_args_delta") {
      const s = toolSlots.get(chunk.index);
      if (s) s.args += chunk.partialJson;
    } else if (chunk.type === "done") {
      usage = mapUsage(chunk.usage);
    }
  }

  const output: any[] = [];
  if (reasoningText) {
    output.push({ type: "reasoning", id: `rs_${rid()}`, summary: [{ type: "summary_text", text: reasoningText }] });
  }
  if (messageText || (toolSlots.size === 0 && images.length === 0)) {
    output.push({
      type: "message",
      id: `msg_${rid()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: messageText, annotations: [] }],
    });
  }
  for (const img of images) {
    output.push({
      type: "image_generation_call",
      id: `ig_${rid()}`,
      status: "completed",
      result: img.data,
      output_format: img.mediaType.split("/")[1] || "png",
    });
  }
  for (const [, s] of [...toolSlots.entries()].sort(([a], [b]) => a - b)) {
    output.push({
      type: "function_call",
      id: s.id,
      call_id: s.callId,
      name: s.name,
      arguments: s.args,
      status: "completed",
    });
  }

  return {
    ...responseEnvelope(responseId, createdAt, model, "completed", output, usage),
    output_text: messageText,
  };
}
