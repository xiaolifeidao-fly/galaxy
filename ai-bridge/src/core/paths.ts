import { homedir } from "node:os";
import { join } from "node:path";

// 桥接服务在用户机器上的落点，遵循 XDG 习惯：
//   配置：~/.config/ai-bridge/config.yaml
//   状态：~/.local/state/ai-bridge/（tokens.json、pid、日志）
// 都可以被环境变量覆盖，方便一台机器跑多个实例或做测试。
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, homedir());
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_BRIDGE_CONFIG_DIR) return expandHome(env.AI_BRIDGE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(xdg, "ai-bridge");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_BRIDGE_CONFIG) return expandHome(env.AI_BRIDGE_CONFIG);
  return join(configDir(env), "config.yaml");
}

export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_BRIDGE_RUNTIME_DIR) return expandHome(env.AI_BRIDGE_RUNTIME_DIR);
  const xdg = env.XDG_STATE_HOME ? expandHome(env.XDG_STATE_HOME) : join(homedir(), ".local", "state");
  return join(xdg, "ai-bridge");
}
