#!/usr/bin/env node
// 把本插件登记到 Codex 的个人市场（~/.agents/plugins/marketplace.json），幂等。
// Codex 的 local source 路径是相对 ~ 的，所以先把插件同步到 ~/plugins/ai-bridge，再登记那条路径。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const file = join(homedir(), ".agents", "plugins", "marketplace.json");
const entry = {
  name: "ai-bridge",
  source: { source: "local", path: "./plugins/ai-bridge" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
};

let data = { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
if (existsSync(file)) data = JSON.parse(await readFile(file, "utf8"));
if (!Array.isArray(data.plugins)) data.plugins = [];
const idx = data.plugins.findIndex((p) => p?.name === entry.name);
if (idx >= 0) data.plugins[idx] = entry; else data.plugins.push(entry);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(data, null, 2) + "\n");
console.log(`registered ai-bridge in ${file}`);
