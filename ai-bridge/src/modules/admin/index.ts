import { Router } from "express";
import { z } from "zod";
import type { BridgeModule } from "../types.js";
import { ScopeSchema } from "../../config/schema.js";
import { addFileToken, revokeFileToken } from "../../auth/token-store.js";
import { httpError } from "../../core/errors.js";

// admin 模块：运行时看状态、管 token。默认只允许 loopback + admin scope。
// 所有写操作只动 tokenFile，不改 config.yaml。
const AddTokenBody = z.object({
  alias: z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/),
  scopes: z.array(ScopeSchema).min(1).default(["relay:anthropic", "relay:openai"]),
  concurrency: z.number().int().positive().optional(),
});

export const adminModule: BridgeModule = {
  name: "admin",
  enabled: (cfg) => cfg.admin.enabled,
  routes(ctx) {
    const r = Router();
    r.use("/admin", ctx.auth.authenticate, ctx.auth.requireLoopbackIfConfigured, ctx.auth.requireScope("admin"));
    const tokenFile = ctx.tokenFile;

    r.get("/admin/status", (_req, res) => {
      res.json({
        ok: true,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        queue: ctx.gate.stats(),
        relay: { anthropic: ctx.cfg.relay.anthropic ?? null, openai: ctx.cfg.relay.openai ?? null },
        agent: { enabled: ctx.cfg.agent.enabled, header: ctx.cfg.agent.header },
        auth: { enabled: ctx.cfg.auth.enabled, tokens: ctx.tokens.size(), ipAllowlist: ctx.cfg.auth.ipAllowlist },
      });
    });

    r.get("/admin/tokens", (_req, res) => {
      res.json({ tokens: ctx.tokens.list() });
    });

    r.post("/admin/tokens", async (req, res, next) => {
      try {
        const body = AddTokenBody.parse(req.body);
        if (ctx.tokens.hasAlias(body.alias)) throw httpError(409, "alias_exists", `alias "${body.alias}" 已存在`);
        const { token } = await addFileToken(tokenFile, body);
        await ctx.tokens.load();
        ctx.log.info("admin_token_added", { alias: body.alias, scopes: body.scopes });
        // 明文 token 只在这一次响应里出现
        res.status(201).json({ alias: body.alias, token, scopes: body.scopes });
      } catch (e) {
        next(e instanceof z.ZodError ? httpError(400, "invalid_request", e.message) : e);
      }
    });

    r.delete("/admin/tokens/:alias", async (req, res, next) => {
      try {
        const removed = await revokeFileToken(tokenFile, req.params.alias);
        if (!removed) throw httpError(404, "alias_not_found", `alias "${req.params.alias}" 不在 token 文件里（config 内联的 token 请改配置文件）`);
        await ctx.tokens.load();
        ctx.log.info("admin_token_revoked", { alias: req.params.alias });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    });

    r.post("/admin/tokens/reload", async (_req, res, next) => {
      try {
        await ctx.tokens.load();
        res.json({ ok: true, tokens: ctx.tokens.size() });
      } catch (e) {
        next(e);
      }
    });

    return r;
  },
};
