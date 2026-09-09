import { spawn } from "node:child_process";
import { cpus, freemem, platform, totalmem } from "node:os";
import type { AppConfig } from "../../config/schema.js";
import { CredentialRegistry } from "../../credentials/index.js";
import type { ProbeResult, Resources } from "../../business/core/index.js";

// 能力探测（P-02）：看看本机有什么可以贡献。
//
// 探测结果只供主人挑选，不会自动申报 —— 「机器上装了 Claude Code」和
// 「我愿意把 Claude 订阅共享出去」是两件事，中间必须有主人的一次点头。
export async function probe(cfg: AppConfig): Promise<ProbeResult> {
  const credentials = new CredentialRegistry();
  const capabilities: ProbeResult["capabilities"] = [];

  for (const [name, provider] of Object.entries(cfg.providers)) {
    if (provider.type !== "relay" || !provider.authMode) continue;
    try {
      const credential = credentials.resolve(provider);
      // 只解析凭据，不发请求：探测不该消耗主人的额度，也不该在上游留痕迹。
      await credential.headers({
        header: () => undefined,
        principal: { alias: "probe", scopes: new Set(["*"] as const), source: "anonymous" },
        requestId: "probe",
        provider,
        providerName: name,
      });
      capabilities.push({
        kind: "llm.chat", provider: provider.authMode, available: true,
        detail: `providers.${name}`, upstream: name,
      });
    } catch (e) {
      capabilities.push({
        kind: "llm.chat", provider: provider.authMode, available: false,
        detail: `providers.${name}: ${(e as Error)?.message ?? "凭据不可用"}`, upstream: name,
      });
    }
  }
  // 本机执行类能力目前一个都不探：
  //
  // · video.edit.render（ffmpeg）—— 实现是完整的（business/video-edit/node/ffmpeg-local.ts
  //   还在），但产品上暂时不把视频渲染算力放进共享池，控制台也不展示它。
  //   探它只是白起一个 `ffmpeg -version` 子进程 —— 健康重探每 60 秒一次，
  //   这个开销没有任何人受益。要放出来时，把下面那段注释掉的代码恢复即可。
  //
  // · delivery.task —— 执行器是主人自己写的命令（exec），「机器上有什么」根本
  //   推断不出来，而且 delivery-task-planner 侧的 --stdio 入口还没做
  //   （见 doc/galaxy/README.md 的「尚未实现」）。探出来也跑不了。
  //
  // 恢复 ffmpeg 探测：
  //   const ffmpeg = await commandWorks("ffmpeg", ["-version"]);
  //   capabilities.push({
  //     kind: "video.edit.render", provider: "ffmpeg-local", available: ffmpeg,
  //     detail: ffmpeg ? "ffmpeg" : "本机没有可用的 ffmpeg（装一个再刷新）",
  //   });

  return { resources: localResources(), capabilities };
}

// commandWorks 目前没有调用方 —— 上面那段 ffmpeg 探测被注释掉了。
// 别删：恢复探测时要用它，而且再写一遍很容易漏掉超时和 kill 这两处。
//
// commandWorks 只看命令能不能起来、退出码是不是 0。不解析版本号：
// 这里要回答的是「能不能用」，版本细节留给真正跑的时候报错。
function commandWorks(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
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
