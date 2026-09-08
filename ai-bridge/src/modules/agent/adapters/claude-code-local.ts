import type {
  ChatCallContext,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelAdapter,
} from "./types.js";
import type { ProviderConfig } from "../../../config/schema.js";
import { log } from "../../../core/logger.js";

// claude-agent-sdk 是 ESM 包
let sdkPromise: Promise<any> | null = null;
function loadSdk(): Promise<any> {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk") as Promise<any>;
  return sdkPromise;
}

/**
 * 把消息历史拼成 Claude Code 的 prompt。
 * Claude Code 是 agent 模式，每次 query 启动新会话；多轮上下文交给客户端传完整 history。
 */
function buildPrompt(messages: ChatMessage[]): { system?: string; prompt: string } {
  const sys: string[] = [];
  const history: { role: string; text: string }[] = [];
  for (const m of messages) {
    const text = m.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    if (!text) continue;
    if (m.role === "system") sys.push(text);
    else history.push({ role: m.role, text });
  }

  const lastUserRev = [...history].reverse().findIndex((h) => h.role === "user");
  let task = "";
  let prior = "";
  if (lastUserRev >= 0) {
    const realIdx = history.length - 1 - lastUserRev;
    task = history[realIdx].text;
    const before = history.slice(0, realIdx);
    if (before.length) {
      prior =
        "Prior conversation context:\n" +
        before.map((h) => `${h.role}: ${h.text}`).join("\n\n") +
        "\n\n---\n\n";
    }
  } else if (history.length) {
    task = history.map((h) => `${h.role}: ${h.text}`).join("\n\n");
  }

  return {
    system: sys.length ? sys.join("\n\n") : undefined,
    prompt: (prior + task).trim(),
  };
}

export class ClaudeCodeLocalAdapter implements ModelAdapter {
  readonly name: string;
  private cfg: ProviderConfig;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async *chatStream(req: ChatRequest, ctx: ChatCallContext): AsyncIterable<ChatChunk> {
    const { query } = await loadSdk();
    const { system, prompt } = buildPrompt(req.messages);

    const ac = new AbortController();
    // 把外部 signal 链到 SDK 的 abortController
    if (ctx.signal.aborted) ac.abort(ctx.signal.reason);
    else ctx.signal.addEventListener("abort", () => ac.abort(ctx.signal.reason), { once: true });

    const cc = this.cfg.claudeCode ?? {};

    const toolsOption =
      cc.toolsPreset === "none"
        ? []
        : { type: "preset" as const, preset: "claude_code" as const };

    // 客户端 systemPrompt > messages 里的 system > 不传
    const effectiveSystem = cc.systemPrompt ?? system;

    const q = query({
      prompt,
      options: {
        cwd: cc.cwd,
        model: req.model,
        abortController: ac,
        permissionMode: cc.permissionMode ?? "bypassPermissions",
        includePartialMessages: true,
        tools: toolsOption,
        ...(cc.allowedTools ? { allowedTools: cc.allowedTools } : {}),
        ...(cc.disallowedTools ? { disallowedTools: cc.disallowedTools } : {}),
        ...(cc.additionalDirectories ? { additionalDirectories: cc.additionalDirectories } : {}),
        ...(cc.maxTurns ? { maxTurns: cc.maxTurns } : {}),
        ...(effectiveSystem ? { systemPrompt: effectiveSystem } : {}),
        // 上游 thinking 配置（按 Anthropic 入参形态）
        ...(req.thinking?.enabled
          ? {
              thinking: {
                type: "enabled" as const,
                ...(req.thinking.budgetTokens ? { budgetTokens: req.thinking.budgetTokens } : {}),
              },
            }
          : {}),
        ...(req.passthrough ?? {}),
      },
    });

    log.debug("claude_code_run_start", {
      requestId: ctx.requestId,
      cwd: cc.cwd,
      model: req.model,
      promptChars: prompt.length,
    });

    let finishReason: any = "stop";
    let usage: any;

    // 跟踪 streaming 状态：当前 content_block 是 thinking 还是 tool_use
    const blockKind = new Map<number, "text" | "thinking" | "tool_use">();
    const blockToolIdx = new Map<number, number>();
    let nextToolIdx = 0;

    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === "stream_event") {
          // SDKPartialAssistantMessage: event 是 Anthropic raw stream event
          const ev = msg.event;
          if (!ev) continue;

          if (ev.type === "content_block_start") {
            const cb = ev.content_block;
            if (cb?.type === "tool_use") {
              const idx = nextToolIdx++;
              blockKind.set(ev.index, "tool_use");
              blockToolIdx.set(ev.index, idx);
              yield { type: "tool_use_start", index: idx, id: cb.id, name: cb.name };
            } else if (cb?.type === "thinking") {
              blockKind.set(ev.index, "thinking");
            } else if (cb?.type === "text") {
              blockKind.set(ev.index, "text");
            }
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            const kind = blockKind.get(ev.index);
            if (d?.type === "text_delta" && typeof d.text === "string") {
              yield { type: "text", delta: d.text };
            } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
              yield { type: "thinking_delta", delta: d.thinking };
            } else if (d?.type === "signature_delta" && typeof d.signature === "string") {
              yield { type: "thinking_signature", signature: d.signature };
            } else if (d?.type === "input_json_delta" && kind === "tool_use") {
              const idx = blockToolIdx.get(ev.index);
              if (idx !== undefined && typeof d.partial_json === "string") {
                yield { type: "tool_use_args_delta", index: idx, partialJson: d.partial_json };
              }
            }
          } else if (ev.type === "content_block_stop") {
            const idx = blockToolIdx.get(ev.index);
            if (idx !== undefined) yield { type: "tool_use_stop", index: idx };
          } else if (ev.type === "message_delta") {
            if (ev.delta?.stop_reason) {
              const r = ev.delta.stop_reason;
              finishReason =
                r === "end_turn" ? "stop" :
                r === "max_tokens" ? "length" :
                r === "tool_use" ? "tool_calls" : r;
            }
            if (ev.usage) usage = { ...usage, ...ev.usage };
          } else if (ev.type === "message_start") {
            if (ev.message?.usage) usage = { ...usage, ...ev.message.usage };
          }
        } else if (msg.type === "result") {
          // 终态结果：含完整 usage / cost
          if (msg.usage) {
            usage = {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
            };
          }
          if (msg.subtype === "success" && msg.stop_reason) {
            const r = msg.stop_reason;
            finishReason =
              r === "end_turn" ? "stop" :
              r === "max_tokens" ? "length" :
              r === "tool_use" ? "tool_calls" : r;
          } else if (msg.subtype !== "success") {
            const errMsg = (msg as any).error?.message ?? msg.subtype ?? "claude code error";
            const e: any = new Error(errMsg);
            e.status = (msg as any).api_error_status ?? 502;
            e.code = "upstream_error";
            throw e;
          }
        }
        // 其它消息（system 通知、tool_progress 等）不产 chunk
      }
    } catch (e: any) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw e;
    }

    yield {
      type: "done",
      finish_reason: finishReason,
      usage: usage
        ? {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens:
              ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)) || undefined,
            ...(usage.cache_read_input_tokens !== undefined
              ? { cache_read_input_tokens: usage.cache_read_input_tokens }
              : {}),
            ...(usage.cache_creation_input_tokens !== undefined
              ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
              : {}),
          }
        : undefined,
    };
  }
}
