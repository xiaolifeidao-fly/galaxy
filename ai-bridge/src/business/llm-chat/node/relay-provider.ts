import type {
  Metering, Provider, Resources, UnitEvent, UnitIO, WorkUnit,
} from "../../core/index.js";
import { inlineInput, inlineJSON, inlineText } from "../../core/index.js";
import type { ProviderConfig } from "../../../config/schema.js";
import { resolveUpstream, type CredentialRegistry } from "../../../credentials/index.js";
import type { Principal } from "../../../auth/principal.js";
import { cpus, freemem, totalmem, platform } from "node:os";
import { prepareClaudeRequest } from "../../../credentials/claude-request.js";

// llm.chat 的节点 provider：补齐订阅协议要求后转发请求，响应逐字节透传。
//
// 与 relay 模块的区别只有「请求从哪来」：那边是本机客户端直连，这边是 Hub 派下来的
// 工作单元。凭据、订阅协议适配和响应透传的语义完全一致，上游凭据一样不出本机。

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export interface RelayProviderOptions {
  // name 是路由键里的 provider：claude_oauth / codex_chatgpt。
  name: string;
  provider: ProviderConfig;
  credentials: CredentialRegistry;
}

export class RelayProvider implements Provider {
  private readonly options: RelayProviderOptions;
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: RelayProviderOptions) {
    this.options = options;
  }

  kinds() {
    return [{ kind: "llm.chat", versions: [1], provider: this.options.name }];
  }

  async probe(): Promise<{ resources: Resources; upstreamOK: boolean; detail?: string }> {
    const resources = localResources();
    try {
      // 只解析上游与凭据，不发请求：探测不该消耗主人的额度，也不该在上游留下痕迹。
      const credential = this.options.credentials.resolve(this.options.provider);
      await credential.headers({
        header: () => undefined,
        principal: probePrincipal,
        requestId: "probe",
        provider: this.options.provider,
        providerName: this.options.name,
        upstream: await resolveUpstream(this.options.provider),
      });
      return { resources, upstreamOK: true };
    } catch (e) {
      return { resources, upstreamOK: false, detail: (e as Error)?.message };
    }
  }

  async *run(unit: WorkUnit, io: UnitIO): AsyncIterable<UnitEvent> {
    const path = inlineText(unit, "path") ?? "/v1/messages";
    const body = inlineInput(unit, "body");
    const clientHeaders = inlineJSON<Record<string, string>>(unit, "headers", {});
    if (!body) {
      yield { type: "error", class: "input_fault", code: "invalid_body", retryable: false, message: "工作单元缺少请求体" };
      return;
    }

    const config = this.options.provider;
    const credential = this.options.credentials.resolve(config);
    // 收单侧再校验一次：Hub 是路由权威，但本机执行边界由本机自己守（原则 8）。
    if (!credential.supportsPath(path)) {
      yield { type: "error", class: "node_fault", code: "capability_mismatch", retryable: true, message: `${credential.mode} 不支持 ${path}` };
      return;
    }

    // 上游跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。
    // 每个单元重新解析，主人改完 CLI 配置不用重启桥接。
    let authHeaders: Record<string, string>;
    let baseURL: string;
    let requestBody: Uint8Array = body;
    try {
      const upstream = await resolveUpstream(config);
      if (upstream.wireApi === "chat" && path === "/v1/responses") {
        yield { type: "error", class: "node_fault", code: "capability_mismatch", retryable: true, message: `本机 Codex 中转的 wire_api 是 chat，承接不了 ${path}` };
        return;
      }
      baseURL = upstream.baseURL;
      requestBody = prepareClaudeRequest(body, config, upstream);
      authHeaders = await credential.headers({
        header: (name) => clientHeaders[name.toLowerCase()] ?? clientHeaders[name],
        // 消费者对节点是匿名的：这里只有 ck_… 这个匿名标识，没有任何身份信息（C-12）。
        principal: { alias: unit.consumerKey, scopes: new Set(["*"] as const), source: "anonymous" },
        requestId: unit.id,
        provider: config,
        providerName: this.options.name,
        upstream,
      });
    } catch (e) {
      // 凭据失效：这条贡献要标成 upstreamOK=false 并通知主人（P-12）。
      yield { type: "error", class: "node_fault", code: "credentials_unavailable", retryable: true, message: (e as Error)?.message ?? "凭据不可用" };
      return;
    }

    const controller = new AbortController();
    this.aborts.set(unit.id, controller);
    const onAbort = () => controller.abort(io.signal.reason);
    if (io.signal.aborted) onAbort();
    else io.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const url = baseURL + path.replace(/^\/v1(?=\/)/, "");
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: isAnthropic(path) ? "text/event-stream" : "text/event-stream, application/json",
          ...authHeaders,
        },
        body: new Uint8Array(requestBody),
        signal: controller.signal,
        redirect: "error",
      });

      yield { type: "head", status: upstream.status, headers: passthroughHeaders(upstream.headers) };
      const failure = upstreamFailure(upstream.status, upstream.headers);
      if (!upstream.body) {
        yield failure ?? { type: "done", usage: {} };
        return;
      }
      // 边收边吐：不缓冲整段响应，背压顺着 Hub 一路顶回上游。
      const reader = upstream.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          yield { type: "chunk", bytes: value };
        }
      }
      io.log("relay_upstream_done", { status: upstream.status, bytes, url });
      // usage 交给 Hub 从流里解析。节点这里不重复解析一遍：
      // 自报值只用于对账，多算一次也不会更可信。
      yield failure ?? { type: "done", usage: {} as Metering };
    } catch (e) {
      if (controller.signal.aborted) {
        yield { type: "error", class: "protocol", code: "unit_cancelled", retryable: false, message: "已取消" };
        return;
      }
      yield {
        type: "error", class: "upstream_fault", code: "upstream_timeout", retryable: true,
        message: (e as Error)?.message ?? "上游请求失败",
      };
    } finally {
      this.aborts.delete(unit.id);
      io.signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(unitId: string): Promise<void> {
    this.aborts.get(unitId)?.abort(new Error("cancelled"));
  }
}

function upstreamFailure(status: number, headers: Headers): Extract<UnitEvent, { type: "error" }> | undefined {
  if (status < 400) return;
  const requestId = headers.get("request-id");
  return {
    type: "error", class: "upstream_fault",
    code: status === 429 ? "upstream_429" : status >= 500 ? "upstream_5xx" : "upstream_rejected",
    retryable: (status === 429 || status >= 500) && headers.get("x-should-retry") !== "false",
    message: `上游返回 HTTP ${status}${requestId ? `，request-id: ${requestId}` : ""}`,
  };
}

const probePrincipal: Principal = { alias: "probe", scopes: new Set(["*"] as const), source: "anonymous" };

function isAnthropic(path: string): boolean {
  return ANTHROPIC_PATHS.has(path);
}

// 带回给消费者的上游头：限流提示与请求追踪。其余一律不带。
function passthroughHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "request-id" || lower === "retry-after" ||
        lower === "x-should-retry" || lower.startsWith("anthropic-ratelimit-") || lower.startsWith("x-ratelimit-")) {
      out[lower] = value;
    }
  });
  return out;
}

export function localResources(): Resources {
  return {
    os: platform(),
    cpu: cpus().length,
    memGB: Math.round(totalmem() / 1024 / 1024 / 1024),
    gpu: null,
    diskFreeGB: Math.round(freemem() / 1024 / 1024 / 1024),
  };
}
