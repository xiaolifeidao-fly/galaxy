import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import type {
  ArtifactRef, Metering, Provider, Resources, UnitEvent, UnitIO, WorkUnit,
} from "../../core/index.js";
import { inlineJSON } from "../../core/index.js";
import { localResources } from "../../../modules/pool/probe.js";

// video.edit.render 的节点 provider：本机 ffmpeg 渲染一条时间线。
//
// 三段都不经 Hub：素材从 OSS 直取，产物直传 OSS，中间只有进度事件走通道。
// 这正是 job 原语的意义 —— GB 级文件让 Hub 转发一遍是纯粹的浪费。

export interface FfmpegOptions {
  name: string;
  // binary 允许主人指定自己编的 ffmpeg（带硬件编码那种）。
  binary?: string;
  extraArgs?: string[];
}

interface Clip {
  src: ArtifactRef;
  in?: number;
  out?: number;
}

interface Timeline {
  timeline: { clips: Clip[] };
  output?: { codec?: string; resolution?: string; fps?: number };
}

export class FfmpegLocalProvider implements Provider {
  private readonly options: FfmpegOptions;
  private readonly running = new Map<string, () => void>();

  constructor(options: FfmpegOptions) {
    this.options = { binary: "ffmpeg", ...options };
  }

  kinds() {
    return [{ kind: "video.edit.render", versions: [1], provider: this.options.name }];
  }

  async probe(): Promise<{ resources: Resources; upstreamOK: boolean; detail?: string }> {
    const resources = localResources();
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(this.options.binary!, ["-version"], { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
    return ok ? { resources, upstreamOK: true } : { resources, upstreamOK: false, detail: "本机没有可用的 ffmpeg" };
  }

  async *run(unit: WorkUnit, io: UnitIO): AsyncIterable<UnitEvent> {
    const spec = inlineJSON<Timeline | null>(unit, "timeline", null);
    if (!spec?.timeline?.clips?.length) {
      yield { type: "error", class: "input_fault", code: "invalid_body", retryable: false, message: "时间线为空" };
      return;
    }
    const workDir = io.workDir;
    if (!workDir) {
      yield { type: "error", class: "node_fault", code: "capability_mismatch", retryable: true, message: "缺少工作目录" };
      return;
    }
    if (!io.signArtifact) {
      yield { type: "error", class: "node_fault", code: "capability_mismatch", retryable: true, message: "节点无法申请产物地址" };
      return;
    }

    // NDJSON：job 的上行是事件流，进度与产物都走它。
    yield { type: "head", status: 200, headers: { "content-type": "application/x-ndjson" } };

    const startedAt = Date.now();
    const controller = new AbortController();
    this.running.set(unit.id, () => controller.abort(new Error("cancelled")));
    const onAbort = () => controller.abort(io.signal.reason);
    if (io.signal.aborted) onAbort();
    else io.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await mkdir(workDir, { recursive: true, mode: 0o700 });

      // 1. 取素材。信封里的 ref 带着 Hub 现签的短期地址，直连 OSS。
      const locals: string[] = [];
      const refs = (unit.inputs ?? []).filter((item) => item.name === "clip" && item.ref?.url);
      for (const [index, payload] of refs.entries()) {
        const target = join(workDir, `clip-${index}${extensionOf(payload.ref!)}`);
        yield ndjson({ kind: "progress", data: { pct: pctOf(index, refs.length, 0, 30), stage: "download" } });
        await download(payload.ref!.url!, target, controller.signal);
        locals.push(target);
      }
      if (locals.length === 0) {
        yield { type: "error", class: "input_fault", code: "artifact_missing", retryable: false, message: "没有可用的素材" };
        return;
      }

      // 2. 渲染。用 concat demuxer 而不是 filter_complex：
      //    前者不重编码就能拼接同规格素材，快一个数量级。
      const listFile = join(workDir, "concat.txt");
      await writeFile(listFile, locals.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      const outputPath = join(workDir, "output.mp4");
      const args = buildArgs(this.options, listFile, outputPath, spec.output);

      io.log("ffmpeg_start", { clips: locals.length, args: args.length });
      const cpuStart = process.cpuUsage();
      for await (const pct of runFfmpeg(this.options.binary!, args, controller.signal)) {
        yield ndjson({ kind: "progress", data: { pct: pctOf(0, 1, 30, 90) + Math.round(pct * 0.6), stage: "render" } });
      }
      const cpu = process.cpuUsage(cpuStart);

      // 3. 直传 OSS。产物字节同样不经 Hub。
      const info = await stat(outputPath);
      yield ndjson({ kind: "progress", data: { pct: 92, stage: "upload" } });
      const ref = await io.signArtifact("output.mp4", "video/mp4", info.size);
      await upload(ref.url!, outputPath, info.size, "video/mp4", controller.signal);

      const usage: Metering = {
        "video.output_seconds": Math.round(durationOf(spec)),
        "cpu.seconds": Math.round((cpu.user + cpu.system) / 1_000_000),
        "storage.bytes": info.size,
      };
      const clean: ArtifactRef = { ...ref, url: undefined };
      yield ndjson({ kind: "artifact", data: clean });
      yield ndjson({ kind: "progress", data: { pct: 100, stage: "done" } });
      io.log("ffmpeg_done", { ms: Date.now() - startedAt, bytes: info.size });
      yield { type: "done", usage, outputs: [{ name: "output.mp4", ref: clean }] };
    } catch (e) {
      if (controller.signal.aborted) {
        yield { type: "error", class: "protocol", code: "unit_cancelled", retryable: false, message: "已取消" };
        return;
      }
      yield {
        type: "error", class: "node_fault", code: "node_offline", retryable: true,
        message: (e as Error)?.message ?? "渲染失败",
      };
    } finally {
      io.signal.removeEventListener("abort", onAbort);
      this.running.delete(unit.id);
      // 本地副本由运行循环统一删：它知道单元什么时候真的结束了。
    }
  }

  async cancel(unitId: string): Promise<void> {
    this.running.get(unitId)?.();
  }
}

function buildArgs(options: FfmpegOptions, listFile: string, output: string, spec?: Timeline["output"]): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile];
  const filters: string[] = [];
  if (spec?.resolution) filters.push(`scale=${spec.resolution.replace("x", ":")}`);
  if (spec?.fps) filters.push(`fps=${spec.fps}`);
  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
    args.push("-c:v", codecOf(spec?.codec));
  } else {
    // 没有任何转换时直接拷流：拼接不需要重编码，这是 concat demuxer 的全部意义。
    args.push("-c", "copy");
  }
  args.push(...(options.extraArgs ?? []));
  args.push(output);
  return args;
}

function codecOf(codec?: string): string {
  switch (codec) {
    case "h265": case "hevc": return "libx265";
    case "vp9": return "libvpx-vp9";
    default: return "libx264";
  }
}

// runFfmpeg 解析 -progress 的键值输出，产出 0..1 的完成度。
// ffmpeg 不报总时长，所以这里只按 out_time 相对推进，拿不到就不报。
async function* runFfmpeg(binary: string, args: string[], signal: AbortSignal): AsyncIterable<number> {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const onAbort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });

  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });

  let buffer = "";
  let lastPct = 0;
  child.stdout.setEncoding("utf8");
  const queue: number[] = [];
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (const line of buffer.split("\n")) {
      const [key, value] = line.split("=");
      if (key === "progress" && value?.trim() === "end") queue.push(1);
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    // 没有总时长就只能用「还在动」表示进展，不谎报具体百分比。
    lastPct = Math.min(0.95, lastPct + 0.02);
    queue.push(lastPct);
  });

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const finished = await Promise.race([exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200).unref?.())]);
      if (finished === undefined) continue;
      if (finished !== 0) throw new Error(`ffmpeg 以 ${finished} 退出：${stderr.slice(-512)}`);
      return;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function download(url: string, target: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`取素材失败：${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(target), { signal });
}

async function upload(url: string, path: string, size: number, contentType: string, signal: AbortSignal): Promise<void> {
  const { createReadStream } = await import("node:fs");
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(size) },
    body: Readable.toWeb(createReadStream(path)) as ReadableStream,
    duplex: "half",
    signal,
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`上传产物失败：${response.status}`);
}

function durationOf(spec: Timeline): number {
  return spec.timeline.clips.reduce((total, clip) => {
    const span = (clip.out ?? 0) - (clip.in ?? 0);
    return total + (span > 0 ? span : 0);
  }, 0);
}

function extensionOf(ref: ArtifactRef): string {
  const dot = ref.key.lastIndexOf(".");
  return dot > 0 ? ref.key.slice(dot) : ".mp4";
}

function pctOf(index: number, total: number, from: number, to: number): number {
  if (total <= 0) return from;
  return from + Math.round(((index + 1) / total) * (to - from));
}

function ndjson(event: unknown): UnitEvent {
  return { type: "chunk", bytes: new TextEncoder().encode(JSON.stringify(event) + "\n") };
}
