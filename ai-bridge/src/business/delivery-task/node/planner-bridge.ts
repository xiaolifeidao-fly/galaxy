import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  Metering, Provider, Resources, UnitEvent, UnitIO, WorkUnit, WorkspaceRef,
} from "../../core/index.js";
import { inlineJSON } from "../../core/index.js";
import { localResources } from "../../../modules/pool/probe.js";

// delivery.task 的节点 provider：把一个回合交给本机的 agent 执行器跑。
//
// 它刻意不认识 delivery-task-planner 的内部结构，只约定一套进程协议：
//   stdin  收到一个 JSON（回合入参 + 续接上下文）
//   stdout 吐 NDJSON 事件流，每行一个 { kind, data?, usage? }
//   最后一行 kind=done 时带 usage 与 contextDelta
// 这样换执行器只要换命令，不用改这里；而 agent 在主人机器上跑命令、写文件，
// 这条边界由节点自己守，不信任 Hub（原则 8）。

export interface ExecSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface PlannerBridgeOptions {
  name: string;
  exec: ExecSpec;
}

// TurnPayload 是交给执行器的东西。字段名与服务端 dto 对齐，
// 执行器只读它，不需要知道共享池的存在。
interface TurnPayload {
  unitId: string;
  sid: string;
  seq: number;
  op: string;
  turn: unknown;
  resume?: unknown;
}

export class PlannerBridgeProvider implements Provider {
  private readonly options: PlannerBridgeOptions;
  private readonly running = new Map<string, () => void>();

  constructor(options: PlannerBridgeOptions) {
    this.options = options;
  }

  kinds() {
    return [{ kind: "delivery.task", versions: [1], provider: this.options.name }];
  }

  async probe(): Promise<{ resources: Resources; upstreamOK: boolean; detail?: string }> {
    const resources = localResources();
    // 只确认执行器起得来，不真的跑一个回合：探测不该在主人的工作区里留下痕迹。
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(this.options.exec.command, ["--version"], { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("exit", () => resolve(true));
    });
    return ok
      ? { resources, upstreamOK: true }
      : { resources, upstreamOK: false, detail: `执行器不可用：${this.options.exec.command}` };
  }

  async *run(unit: WorkUnit, io: UnitIO): AsyncIterable<UnitEvent> {
    const payload: TurnPayload = {
      unitId: unit.id,
      sid: unit.sid ?? "",
      seq: unit.seq ?? 0,
      op: unit.op ?? "turn",
      turn: inlineJSON<unknown>(unit, "turn", {}),
    };
    // 续接上下文只在跨节点那一次才有：同节点续跑时执行器手里还有 thread。
    const resume = inlineJSON<unknown>(unit, "resume", null);
    if (resume) payload.resume = resume;

    // NDJSON 而不是原始字节：session 的上行是事件流，Hub 收进日志供消费者随时订阅。
    yield { type: "head", status: 200, headers: { "content-type": "application/x-ndjson" } };

    const exec = this.options.exec;
    const child = spawn(exec.command, exec.args ?? [], {
      cwd: exec.cwd,
      env: { ...process.env, ...(exec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const kill = () => {
      try { child.kill("SIGTERM"); } catch { /* 已经退了 */ }
    };
    this.running.set(unit.id, kill);
    const onAbort = () => kill();
    if (io.signal.aborted) onAbort();
    else io.signal.addEventListener("abort", onAbort, { once: true });

    const timeout = exec.timeoutMs ? setTimeout(kill, exec.timeoutMs) : undefined;
    timeout?.unref?.();

    // stderr 只进本机日志，不上行：它可能带主人的路径与环境变量。
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => io.log("planner_stderr", { bytes: chunk.length }));

    child.stdin.write(JSON.stringify(payload) + "\n");
    child.stdin.end();

    const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    let usage: Metering = {};
    let contextDelta: unknown;
    let workspaceRef: WorkspaceRef | undefined;
    let sawDone = false;

    try {
      for await (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        let event: { kind?: string; data?: unknown; usage?: Metering; contextDelta?: unknown; workspaceRef?: WorkspaceRef };
        try {
          event = JSON.parse(text);
        } catch {
          // 执行器吐了不合规的一行：当成一条日志事件送上去，别整段丢掉 ——
          // 排障时要能看出是执行器的问题。
          yield ndjson({ kind: "malformed", data: { line: text.slice(0, 512) } });
          continue;
        }
        if (event.usage) usage = { ...usage, ...event.usage };
        if (event.contextDelta) contextDelta = event.contextDelta;
        if (event.workspaceRef) workspaceRef = event.workspaceRef;
        if (event.kind === "done") {
          sawDone = true;
          continue;
        }
        yield ndjson(event);
      }

      const code = await exited;
      if (code !== 0 && !sawDone) {
        yield {
          type: "error", class: "node_fault", code: "node_offline", retryable: false,
          message: `执行器以 ${code} 退出`,
        };
        return;
      }
      yield { type: "done", usage, contextDelta, workspaceRef };
    } catch (e) {
      if (io.signal.aborted) {
        yield { type: "error", class: "protocol", code: "unit_cancelled", retryable: false, message: "已取消" };
        return;
      }
      yield {
        type: "error", class: "node_fault", code: "node_offline", retryable: false,
        message: (e as Error)?.message ?? "执行器失败",
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      io.signal.removeEventListener("abort", onAbort);
      this.running.delete(unit.id);
      kill();
    }
  }

  async cancel(unitId: string): Promise<void> {
    this.running.get(unitId)?.();
  }
}

// ndjson 把一条事件包成上行字节。Hub 的写回器按行解析，所以必须带换行。
function ndjson(event: unknown): UnitEvent {
  return { type: "chunk", bytes: new TextEncoder().encode(JSON.stringify(event) + "\n") };
}
