import type { BridgeModule } from "./types.js";
import type { ModuleRegistry } from "./registry.js";
import { healthModule } from "./health/index.js";
import { agentModule } from "./agent/index.js";
import { relayModule } from "./relay/index.js";
import { adminModule } from "./admin/index.js";

// 模块清单。顺序即 init / mount 顺序：
//   health 最前（无鉴权探针）；agent 在 relay 之前 init，因为 relay mount 时要读 agentDispatch。
// 新模块在这里加一行。
export function builtinModules(getRegistry: () => ModuleRegistry): BridgeModule[] {
  return [healthModule(getRegistry), agentModule, relayModule, adminModule];
}

export type { BridgeModule, BridgeContext } from "./types.js";
export { ModuleRegistry } from "./registry.js";
