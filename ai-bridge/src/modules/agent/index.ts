import type { RequestHandler } from "express";
import type { BridgeContext, BridgeModule } from "../types.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { makeAgentHandler, type ProtocolBinding } from "./handler.js";
import { OpenAIChatBodySchema, openaiToInternal } from "./protocol/openai-in.js";
import { collectInternalToOpenAIJson, streamInternalToOpenAISSE, writeSSEHeaders as openaiSSE } from "./protocol/openai-out.js";
import { ResponsesBodySchema, responsesToInternal } from "./protocol/responses-in.js";
import { collectInternalToResponsesJson, streamInternalToResponsesSSE, writeSSEHeaders as responsesSSE } from "./protocol/responses-out.js";
import { AnthropicMessagesBodySchema, anthropicToInternal } from "./protocol/anthropic-in.js";
import { collectInternalToAnthropicJson, streamInternalToAnthropicSSE, writeSSEHeaders as anthropicSSE } from "./protocol/anthropic-out.js";

// agent 模块：请求带 agent.header 时，不透传，而是在桥接所在机器上跑 Claude Code / Codex agent，
// 把结果按客户端协议（OpenAI Chat / Responses / Anthropic Messages）流回去。
// 它不注册自己的路径，只把 handler 挂进 ctx.shared.agentDispatch，由 relay 模块分发。
// 默认关闭：开了意味着桥接机会替调用方执行命令、写文件。

const bindings: Record<string, ProtocolBinding> = {
  "/v1/chat/completions": {
    parse: (body) => openaiToInternal(OpenAIChatBodySchema.parse(body)),
    writeStream: streamInternalToOpenAISSE,
    writeJson: async (res, model, stream) => { res.json(await collectInternalToOpenAIJson(model, stream)); },
    writeSSEHeaders: openaiSSE,
    errorBody: (status, code, message) => ({ error: { type: code, code, message, status } }),
  },
  "/v1/responses": {
    parse: (body) => responsesToInternal(ResponsesBodySchema.parse(body)),
    writeStream: streamInternalToResponsesSSE,
    writeJson: async (res, model, stream) => { res.json(await collectInternalToResponsesJson(model, stream)); },
    writeSSEHeaders: responsesSSE,
    errorBody: (status, code, message) => ({ error: { message, type: code, code, param: null } }),
  },
  "/v1/messages": {
    parse: (body) => anthropicToInternal(AnthropicMessagesBodySchema.parse(body)),
    writeStream: streamInternalToAnthropicSSE,
    writeJson: async (res, model, stream) => { res.json(await collectInternalToAnthropicJson(model, stream)); },
    writeSSEHeaders: anthropicSSE,
    errorBody: (status, code, message) => ({ type: "error", error: { type: code, message, status } }),
  },
};

export const agentModule: BridgeModule = {
  name: "agent",
  enabled: (cfg) => cfg.agent.enabled,
  init(ctx: BridgeContext) {
    const registry = new AdapterRegistry(ctx.cfg);
    const handlers = new Map<string, RequestHandler>();
    for (const [path, binding] of Object.entries(bindings)) {
      handlers.set(path, makeAgentHandler(ctx, registry, binding));
    }
    ctx.shared.agentDispatch = {
      header: ctx.cfg.agent.header,
      handlerFor: (path) => handlers.get(path),
    };
    ctx.log.warn("agent_enabled", {
      message: "agent 模块已开启：带 agent 头的请求会在本机执行命令/写文件，确认 token scope 只发给可信调用方。",
      header: ctx.cfg.agent.header,
      routes: ctx.cfg.agent.routes.map((r) => `${r.match} → ${r.provider}`),
    });
  },
  health(ctx) {
    return { header: ctx.cfg.agent.header, routes: ctx.cfg.agent.routes.length };
  },
};
