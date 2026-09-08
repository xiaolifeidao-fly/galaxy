import { mkdtemp, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatCallContext,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ContentBlock,
  ModelAdapter,
} from "./types.js";
import type { ProviderConfig } from "../../../config/schema.js";
import { log } from "../../../core/logger.js";

// 可识别为"图片"的扩展名 → mediaType
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
// 只把"栅格图"当 image_generation_call 回传；SVG 是 XML 文本，走文件通道（见 TEXT_EXT）。
function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null;
}
function extOfMime(mime: string): string {
  const hit = Object.entries(IMAGE_MIME).find(([, m]) => m === mime);
  return hit ? hit[0] : ".png";
}

// codex-sdk 是 ESM 包，CJS 项目里只能用动态 import。lazy 加载并缓存。
let codexModulePromise: Promise<any> | null = null;
function loadCodex(): Promise<any> {
  if (!codexModulePromise) {
    codexModulePromise = import("@openai/codex-sdk") as Promise<any>;
  }
  return codexModulePromise;
}

/**
 * 把内部 ChatRequest 的消息历史拼成 codex 单次 prompt。
 *
 * 设计权衡：codex 是 agentic CLI，每次 runStreamed 对应"接到一个任务"，
 * 它不像 chat 模型那样消费 messages 数组。我们这里：
 *   - system 消息合并到 prompt 开头作为"persona/约束"
 *   - 把历史 user/assistant 文本拼成对话脚本，让 codex 在新 turn 里有上下文
 *   - 最后一条 user 消息作为本轮"实际任务"
 *
 * 工具调用、图片、文件等块忽略 —— codex 走自己的 sandbox + 工具体系。
 */
function buildPrompt(messages: ChatMessage[]): {
  prompt: string;
  images: ContentBlock[];
  files: ContentBlock[];
} {
  const sys: string[] = [];
  const history: { role: string; text: string; images: ContentBlock[]; files: ContentBlock[] }[] = [];

  for (const m of messages) {
    const text = m.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("");
    const images = m.content.filter((b) => b.type === "image") as ContentBlock[];
    const files = m.content.filter((b) => b.type === "file") as ContentBlock[];
    if (!text && !images.length && !files.length) continue;
    if (m.role === "system") sys.push(text);
    else history.push({ role: m.role, text, images, files });
  }

  // 最后一条 user → 本轮任务；之前的当上下文。图片/文件只取这条 user 的（本轮附件）
  const lastUserIdx = [...history].reverse().findIndex((h) => h.role === "user");
  let task = "";
  let priorScript = "";
  let images: ContentBlock[] = [];
  let files: ContentBlock[] = [];
  if (lastUserIdx >= 0) {
    const realIdx = history.length - 1 - lastUserIdx;
    task = history[realIdx].text;
    images = history[realIdx].images;
    files = history[realIdx].files;
    const prior = history.slice(0, realIdx);
    if (prior.length) {
      priorScript =
        "Prior conversation context:\n" +
        prior.map((h) => `${h.role}: ${h.text}`).join("\n\n") +
        "\n\n---\n\n";
    }
  } else if (history.length) {
    // 没 user 消息时，把整段当任务
    task = history.map((h) => `${h.role}: ${h.text}`).join("\n\n");
  }

  const sysBlock = sys.length ? sys.join("\n\n") + "\n\n" : "";
  return { prompt: (sysBlock + priorScript + task).trim(), images, files };
}

// 文本类文件的 mediaType / 扩展名（用于决定输出文件回传时内联文本还是 base64）
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".yaml", ".yml",
  ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".sh", ".sql", ".log", ".ini", ".toml", ".env", ".srt", ".vtt", ".svg",
]);
function isTextual(path: string, mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (/(json|xml|yaml|javascript|typescript|csv|html|markdown|svg)/.test(mediaType)) return true;
  return TEXT_EXT.has(extname(path).toLowerCase());
}
function mimeOfExt(path: string): string {
  const e = extname(path).toLowerCase();
  if (IMAGE_MIME[e]) return IMAGE_MIME[e];
  if (e === ".svg") return "image/svg+xml";
  if (e === ".pdf") return "application/pdf";
  if (TEXT_EXT.has(e)) return e === ".json" ? "application/json" : "text/plain";
  return "application/octet-stream";
}

export class CodexLocalAdapter implements ModelAdapter {
  readonly name: string;
  private cfg: ProviderConfig;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async *chatStream(req: ChatRequest, ctx: ChatCallContext): AsyncIterable<ChatChunk> {
    const { Codex } = await loadCodex();

    const effectiveReasoning =
      req.reasoning?.effort ?? this.cfg.codex?.defaultReasoningEffort;

    // minimal 模式不兼容 image_gen / web_search 工具，自动禁掉。
    // codex 的正确 key 是顶级 `web_search="disabled"` 和 `features.image_generation=false`
    // 用户在 extraConfig 里显式设过的优先
    const userExtra = (this.cfg.codex?.extraConfig ?? {}) as Record<string, any>;
    const mergedConfig: Record<string, any> = { ...userExtra };
    if (effectiveReasoning === "minimal") {
      if (mergedConfig.web_search === undefined) mergedConfig.web_search = "disabled";
      const userFeatures = (userExtra.features ?? {}) as Record<string, any>;
      mergedConfig.features = {
        image_generation: userFeatures.image_generation ?? false,
        ...userFeatures,
      };
    }

    const codex = new Codex({
      codexPathOverride: this.cfg.codex?.codexPathOverride,
      baseUrl: this.cfg.baseURL,
      apiKey: this.cfg.apiKey || undefined,
      ...(Object.keys(mergedConfig).length ? { config: mergedConfig } : {}),
    });

    // 工作区：用户显式配了就用配的（持久）；否则每请求开一个临时目录，结束即删，
    // 不在服务端留任何数据。codex 生成图片靠往工作区写文件，所以工作区必须可写。
    const configuredWd = this.cfg.codex?.workingDirectory;
    const ownsWorkspace = !configuredWd;
    const workdir = configuredWd ?? (await mkdtemp(join(tmpdir(), "aisdk-codex-")));

    const { prompt, images, files } = buildPrompt(req.messages);

    const emittedPaths = new Set<string>();
    const inputItems: any[] = [];
    const fetchToBuf = async (b: any): Promise<{ buf: Buffer; mime: string } | null> => {
      let mime = b.mediaType || "application/octet-stream";
      if (b.data) return { buf: Buffer.from(b.data, "base64"), mime };
      if (b.url) {
        const r = await fetch(b.url, { signal: ctx.signal });
        mime = r.headers.get("content-type") || mime;
        return { buf: Buffer.from(await r.arrayBuffer()), mime };
      }
      return null; // file_id 无法在本机解析，跳过
    };

    // 输入图（vision）：base64 落临时文件，用 local_image path 喂 codex
    for (const img of images) {
      if (img.type !== "image") continue;
      try {
        const r = await fetchToBuf(img);
        if (!r) continue;
        const p = join(workdir, `__input_${randomUUID().slice(0, 8)}${extOfMime(r.mime || "image/png")}`);
        await writeFile(p, r.buf);
        emittedPaths.add(p);
        inputItems.push({ type: "local_image", path: p });
      } catch (e: any) {
        log.warn("codex_input_image_failed", { requestId: ctx.requestId, message: e?.message });
      }
    }

    // 输入文件：codex-sdk 无文件输入类型，所以落进工作区 + 在 prompt 里告诉 codex 路径，
    // 让它用自带工具（Read 等）去读。
    const inputFileNotes: string[] = [];
    for (const f of files) {
      if (f.type !== "file") continue;
      try {
        const r = await fetchToBuf(f);
        if (!r) continue;
        const safe = (f.filename || `__input_${randomUUID().slice(0, 8)}`).replace(/[/\\]/g, "_");
        const p = join(workdir, safe);
        await writeFile(p, r.buf);
        emittedPaths.add(p);
        inputFileNotes.push(`./${safe}`);
      } catch (e: any) {
        log.warn("codex_input_file_failed", { requestId: ctx.requestId, message: e?.message });
      }
    }

    let promptText = prompt;
    if (inputFileNotes.length) {
      promptText =
        (promptText ? promptText + "\n\n" : "") +
        `Attached files are in the working directory: ${inputFileNotes.join(", ")}. Read them as needed.`;
    }
    if (promptText) inputItems.unshift({ type: "text", text: promptText });

    // 收尾要扫描的基线：run 之前工作区已有的文件不算"新生成"
    for (const p of await walkFiles(workdir)) emittedPaths.add(p);

    // 把工作区新出现的文件读出来 → 图片走 image chunk，其它走 file chunk（文本内联 / 二进制 base64）
    const scanNewFiles = async function* (): AsyncGenerator<ChatChunk> {
      for (const p of await walkFiles(workdir)) {
        if (emittedPaths.has(p)) continue;
        emittedPaths.add(p);
        try {
          const buf = await readFile(p);
          if (!buf.length) continue;
          const imgMime = imageMimeOf(p);
          if (imgMime) {
            yield { type: "image", mediaType: imgMime, data: buf.toString("base64"), name: basename(p) };
            continue;
          }
          const mime = mimeOfExt(p);
          if (isTextual(p, mime)) {
            yield { type: "file", mediaType: mime, name: basename(p), text: buf.toString("utf8") };
          } else {
            yield { type: "file", mediaType: mime, name: basename(p), data: buf.toString("base64") };
          }
        } catch (e: any) {
          log.warn("codex_output_file_failed", { requestId: ctx.requestId, path: p, message: e?.message });
        }
      }
    };

    const thread = codex.startThread({
      model: req.model,
      workingDirectory: workdir,
      sandboxMode: this.cfg.codex?.sandboxMode,
      approvalPolicy: this.cfg.codex?.approvalPolicy,
      skipGitRepoCheck: this.cfg.codex?.skipGitRepoCheck ?? true,
      ...(effectiveReasoning ? { modelReasoningEffort: effectiveReasoning as any } : {}),
    });

    const input = inputItems.length ? inputItems : prompt;
    log.debug("codex_run_start", {
      requestId: ctx.requestId,
      promptChars: prompt.length,
      inputImages: inputItems.filter((i) => i.type === "local_image").length,
      inputFiles: inputFileNotes.length,
      workdir,
      ephemeral: ownsWorkspace,
    });

    // codex 的 agent_message / reasoning item 的 text 是"累计全文"，需要计算 delta。
    // 用 item id → 已发送字符数 的 map 来增量产出。
    const sentLen = new Map<string, number>();
    const sentReasoningLen = new Map<string, number>();

    let finishReason: any = "stop";
    let usage: any;

    try {
      const streamed = await thread.runStreamed(input, { signal: ctx.signal });

      for await (const event of streamed.events as AsyncIterable<any>) {
        switch (event.type) {
          case "thread.started":
          case "turn.started":
            break;

          case "item.updated":
          case "item.completed": {
            const item = event.item;
            if (!item) break;

            if (item.type === "agent_message" && typeof item.text === "string") {
              const prev = sentLen.get(item.id) ?? 0;
              if (item.text.length > prev) {
                yield { type: "text", delta: item.text.slice(prev) };
                sentLen.set(item.id, item.text.length);
              }
            } else if (item.type === "reasoning" && typeof item.text === "string") {
              const prev = sentReasoningLen.get(item.id) ?? 0;
              if (item.text.length > prev) {
                yield { type: "thinking_delta", delta: item.text.slice(prev) };
                sentReasoningLen.set(item.id, item.text.length);
              }
            } else if (item.type === "file_change" && event.type === "item.completed") {
              // 文件补丁落盘 → 看看有没有新文件/图片，有就回传
              yield* scanNewFiles();
            } else if (item.type === "error" && event.type === "item.completed") {
              // codex item-level 非致命错误，作为文本告诉客户端
              yield { type: "text", delta: `\n[codex error] ${item.message}\n` };
            } else if (item.type === "command_execution" && event.type === "item.completed") {
              // 命令执行结束的可见摘要（按需开启）
              log.debug("codex_command_done", {
                requestId: ctx.requestId,
                command: item.command,
                exit_code: item.exit_code,
              });
            }
            break;
          }

          case "item.started":
            // 不产 chunk，只观测
            break;

          case "turn.completed": {
            // 兜底：codex 可能直接用 shell/工具写文件（不走 file_change），收尾再扫一次
            yield* scanNewFiles();
            const u = event.usage;
            if (u) {
              usage = {
                prompt_tokens: u.input_tokens,
                completion_tokens: u.output_tokens,
                total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) || undefined,
                ...(u.cached_input_tokens !== undefined
                  ? { cache_read_input_tokens: u.cached_input_tokens }
                  : {}),
              };
            }
            break;
          }

          case "turn.failed": {
            const msg = event.error?.message ?? "codex turn failed";
            const e: any = new Error(msg);
            e.status = 502;
            e.code = "upstream_error";
            throw e;
          }

          case "error": {
            const msg = event.message ?? "codex stream error";
            const e: any = new Error(msg);
            e.status = 502;
            e.code = "upstream_error";
            throw e;
          }

          default:
            break;
        }
      }
    } catch (e: any) {
      // AbortSignal 触发的取消正常传播
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw e;
    } finally {
      // 临时工作区：无论成功/失败/取消，都清掉，不在服务端留数据
      if (ownsWorkspace) {
        await rm(workdir, { recursive: true, force: true }).catch((e) =>
          log.warn("codex_workspace_cleanup_failed", { requestId: ctx.requestId, workdir, message: e?.message })
        );
      }
    }

    yield { type: "done", finish_reason: finishReason, usage };
  }
}

// 递归列出目录下所有非空文件的绝对路径（忽略隐藏目录/文件如 .git）
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        try {
          const s = await stat(full);
          if (s.size > 0) out.push(full);
        } catch {}
      }
    }
  }
  await walk(dir);
  return out;
}
