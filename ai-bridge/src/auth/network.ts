import { BlockList, isIP } from "node:net";
import type { Request } from "express";

// 来源 IP 策略。用 node 自带的 BlockList 做 CIDR 匹配，v4 / v6 都支持。
// 注意：BlockList 的语义是"命中即在名单里"，我们把它当 allowlist 用。

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  // express 在 IPv6 栈上会给出 ::ffff:127.0.0.1 这种映射地址，统一还原成 v4
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export function clientIp(req: Request): string | undefined {
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? undefined);
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

export class IpAllowlist {
  private readonly list: BlockList | null;

  constructor(entries: string[]) {
    if (entries.length === 0) {
      this.list = null;
      return;
    }
    const list = new BlockList();
    for (const raw of entries) {
      const [addr, prefixStr] = raw.split("/");
      const family = isIP(addr);
      if (!family) throw new Error(`auth.ipAllowlist 里不是合法 IP/CIDR：${raw}`);
      const fam = family === 4 ? "ipv4" : "ipv6";
      if (prefixStr === undefined) {
        list.addAddress(addr, fam);
      } else {
        const prefix = Number(prefixStr);
        const max = family === 4 ? 32 : 128;
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
          throw new Error(`auth.ipAllowlist 里 CIDR 前缀不合法：${raw}`);
        }
        list.addSubnet(addr, prefix, fam);
      }
    }
    this.list = list;
  }

  // 没配名单 = 全部放行
  allows(ip: string | undefined): boolean {
    if (!this.list) return true;
    if (!ip) return false;
    const family = isIP(ip);
    if (!family) return false;
    return this.list.check(ip, family === 4 ? "ipv4" : "ipv6");
  }
}
