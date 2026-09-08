// 配置向导的页面。
//
// 它由本机的临时服务自己吐出来，不是 galaxy 控制台跨源来调 —— 页面与接口同源
// （都在 http://127.0.0.1:<port>），因此没有 CORS、没有混合内容、不受
// Private Network Access 那套预检影响。控制台只负责给安装教程和配对码。
//
// 一次性令牌直接内联进页面：它是同源的，别的站点读不到；也就免了让用户
// 从终端里复制粘贴一串 token。
//
// 纯手写 HTML，不引任何框架：这个页面一辈子只被打开一两次，
// 为它拉一条前端构建链不值当，而且插件要能在离线机器上跑起来。

export function setupPage(token: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>加入共享算力池</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --text:#1c1e26; --muted:#6b7280;
          --line:#e5e7eb; --brand:#4f46e5; --ok:#16a34a; --warn:#b45309; --bad:#dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161c; --card:#1c1f27; --text:#e8eaf0; --muted:#9aa1ad; --line:#2c313b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,
         "Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 4px; display:flex; align-items:center; gap:8px; }
  .step { display:inline-flex; width:22px; height:22px; border-radius:50%; background:var(--brand); color:#fff;
          align-items:center; justify-content:center; font-size:12px; flex:none; }
  .hint { color:var(--muted); font-size:13px; margin:0 0 14px; }
  label { display:block; margin:12px 0 4px; font-size:13px; color:var(--muted); }
  input[type=text] { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px;
                     background:transparent; color:var(--text); font:inherit; }
  input[type=text]:focus { outline:2px solid var(--brand); outline-offset:-1px; }
  button { padding:9px 18px; border:0; border-radius:8px; background:var(--brand); color:#fff;
           font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .cap { display:flex; gap:10px; align-items:flex-start; padding:11px 0; border-top:1px solid var(--line); }
  .cap:first-of-type { border-top:0; }
  .cap input { margin-top:4px; flex:none; }
  .cap .name { font-weight:600; }
  .cap .why { color:var(--muted); font-size:12px; word-break:break-all; }
  .cap.off .name { color:var(--muted); }
  .tier { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  .tier label { display:flex; gap:6px; align-items:center; margin:0; padding:8px 12px; border:1px solid var(--line);
                border-radius:8px; cursor:pointer; color:var(--text); }
  .tier input { margin:0; }
  .row { display:flex; gap:16px; flex-wrap:wrap; }
  .row > div { flex:1; min-width:180px; }
  .msg { margin-top:14px; padding:10px 12px; border-radius:8px; font-size:13px; display:none; white-space:pre-wrap; }
  .msg.show { display:block; }
  .msg.ok { background:rgba(22,163,74,.12); color:var(--ok); }
  .msg.bad { background:rgba(220,38,38,.12); color:var(--bad); }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; background:rgba(22,163,74,.14); color:var(--ok); }
  code { background:rgba(127,127,127,.14); padding:2px 6px; border-radius:4px; font-size:12.5px; }
  .done { display:none; }
  .done.show { display:block; }
</style>
</head>
<body>
<div class="wrap">
  <h1>加入共享算力池</h1>
  <p class="sub">这个页面只在本机运行，配置完就会自动退出。凭据不会离开这台机器。</p>

  <div class="card">
    <h2><span class="step">1</span> 连接到平台 <span id="pairedBadge" class="badge" hidden></span></h2>
    <p class="hint">配对码在控制台「加入共享池」页面生成，10 分钟内有效，只能用一次。</p>
    <div class="row">
      <div>
        <label for="hubURL">平台地址</label>
        <input id="hubURL" type="text" placeholder="https://galaxy.example.com" />
      </div>
      <div>
        <label for="name">这台机器叫什么</label>
        <input id="name" type="text" />
      </div>
    </div>
    <label for="code">配对码</label>
    <input id="code" type="text" placeholder="粘贴配对码" autocomplete="off" />
    <div style="margin-top:14px"><button id="join">配对</button></div>
    <div id="joinMsg" class="msg"></div>
  </div>

  <div class="card">
    <h2><span class="step">2</span> 共享哪些能力</h2>
    <p class="hint">只列出本机探测到、且向导支持的能力。<strong>没勾的，平台看不到</strong>，相关代码也不会加载。</p>
    <div id="caps"></div>
  </div>

  <div class="card">
    <h2><span class="step">3</span> 每天最多共享多少</h2>
    <p class="hint">用满就停止接单，在跑的请求正常跑完，第二天自动恢复。</p>
    <div class="tier" id="tiers"></div>
    <div class="row" style="margin-top:16px">
      <div>
        <label for="seats">同时服务几个人</label>
        <input id="seats" type="text" value="3" />
      </div>
      <div>
        <label for="window">挂机时段（留空 = 全天）</label>
        <input id="window" type="text" placeholder="23:00-08:00" />
      </div>
    </div>
  </div>

  <div style="display:flex; gap:10px; align-items:center">
    <button id="save">保存并完成</button>
    <button id="quit" class="ghost">退出</button>
  </div>
  <div id="saveMsg" class="msg"></div>

  <div id="done" class="card done" style="margin-top:16px">
    <h2>配置好了</h2>
    <p class="hint" id="doneDetail"></p>
    <p class="hint">回到终端运行 <code>ai-bridge start</code> 就开始接单。这个页面可以关掉了。</p>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
// 档位表由服务端下发：额度单位必须落在各 kind 声明的允许集合里，
// 这件事只有服务端知道，页面自己编一份迟早和后端对不上。
let state = null;

const KIND_NAMES = { "llm.chat": "对话模型", "video.edit.render": "视频渲染" };
const UNIT_NAMES = {
  "llm.input_tokens": "输入 token",
  "llm.output_tokens": "输出 token",
  "video.output_seconds": "成片时长",
  "cpu.seconds": "算力",
};

function fmtLimit(unit, value) {
  if (unit.endsWith("_tokens")) return (value / 1000000).toFixed(0) + "M";
  // 匹配 endsWith("seconds") 而不是 "_seconds"：video.output_seconds 是下划线，
  // cpu.seconds 是点号，只认下划线的话算力秒会原样吐出一个 72000。
  if (unit.endsWith("seconds")) return value >= 3600 ? (value / 3600).toFixed(0) + "h" : value + "s";
  return String(value);
}

function tierLabel(tier, kinds) {
  const parts = kinds.map((kind) =>
    (tier.quota[kind] || []).map((q) => (UNIT_NAMES[q.unit] || q.unit) + " " + fmtLimit(q.unit, q.limit)).join(" / ")
  ).filter(Boolean);
  return tier.name + "（" + parts.join("；") + " 每天）";
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-setup-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || ("HTTP " + res.status));
  return payload;
}

function show(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "msg show " + (ok ? "ok" : "bad");
}

// 档位说明只列出**已勾中**的能力：勾了对话模型却给你念视频渲染的时长，
// 只会让人以为自己多共享了什么。
function renderTiers() {
  if (!state) return;
  const kinds = [...new Set(pickedCaps().map((c) => c.kind))];
  const shown = kinds.length > 0 ? kinds : Object.keys(state.tiers[0]?.quota ?? {});
  const current = document.querySelector("input[name=tier]:checked")?.value ?? "medium";
  document.getElementById("tiers").innerHTML = state.tiers.map((tier) =>
    '<label><input type="radio" name="tier" value="' + tier.id + '"' +
    (tier.id === current ? " checked" : "") + ' />' + tierLabel(tier, shown) + "</label>"
  ).join("");
  for (const input of document.querySelectorAll("input[name=tier]")) input.onchange = renderTiers;
}

function capKey(c) { return c.kind + "|" + (c.upstream || c.provider || ""); }

function renderCaps() {
  const caps = state.capabilities.filter((c) => c.supported);
  if (caps.length === 0) {
    document.getElementById("caps").innerHTML =
      '<p class="hint">没有探测到可共享的能力。对话模型需要本机先用官方 CLI 登录过' +
      '（Claude 跑 <code>claude auth login</code>，Codex 登录一次）；视频渲染需要本机装了 ffmpeg。' +
      '弄好之后刷新这个页面。</p>';
    return;
  }
  document.getElementById("caps").innerHTML = caps.map((c) => {
    const on = c.available;
    const picked = state.picked.has(capKey(c));
    const title = (KIND_NAMES[c.kind] || c.kind) + " · " + c.provider +
      (c.upstream ? "（" + c.upstream + "）" : "");
    return '<div class="cap' + (on ? "" : " off") + '">' +
      '<input type="checkbox" data-key="' + capKey(c) + '"' +
        (on ? "" : " disabled") + (on && picked ? " checked" : "") + ' />' +
      '<div><div class="name">' + title + '</div>' +
      '<div class="why">' + (on ? "可用" : "不可用：" + (c.detail || "")) + '</div></div></div>';
  }).join("");
  // 勾选变了，档位说明要跟着换 —— 它列的是「你选的这几项各给多少」。
  for (const box of document.querySelectorAll("#caps input[type=checkbox]")) box.onchange = renderTiers;
}

function pickedCaps() {
  if (!state) return [];
  const keys = new Set([...document.querySelectorAll("#caps input[type=checkbox]:checked")]
    .map((el) => el.dataset.key));
  return state.capabilities.filter((c) => keys.has(capKey(c)));
}

async function refresh() {
  state = await api("/api/state");
  state.picked = new Set(state.contributions.map((c) => c.kind + "|" + (c.upstream || c.provider || "")));
  document.getElementById("hubURL").value = state.hubURL || "";
  document.getElementById("name").value = state.displayName || "";
  const badge = document.getElementById("pairedBadge");
  if (state.paired) {
    badge.hidden = false;
    badge.textContent = "已配对 " + state.nodeId;
    document.getElementById("code").placeholder = "已经配过了，要换账号才需要重新粘";
  }
  if (state.contributions.length > 0) {
    const first = state.contributions[0];
    document.getElementById("seats").value = String(first.seats ?? 3);
    document.getElementById("window").value = first.window || "";
  }
  renderCaps();
  renderTiers();
}

document.getElementById("join").onclick = async () => {
  const btn = document.getElementById("join");
  btn.disabled = true;
  try {
    const result = await api("/api/join", {
      hubURL: document.getElementById("hubURL").value.trim(),
      code: document.getElementById("code").value.trim(),
      displayName: document.getElementById("name").value.trim(),
    });
    show("joinMsg", "配对成功：" + result.nodeId, true);
    await refresh();
  } catch (e) {
    show("joinMsg", String(e.message || e), false);
  } finally {
    btn.disabled = false;
  }
};

document.getElementById("save").onclick = async () => {
  const btn = document.getElementById("save");
  btn.disabled = true;
  try {
    const result = await api("/api/save", {
      hubURL: document.getElementById("hubURL").value.trim(),
      picks: pickedCaps().map((c) => ({ kind: c.kind, upstream: c.upstream, provider: c.provider })),
      tier: document.querySelector("input[name=tier]:checked").value,
      seats: Number(document.getElementById("seats").value) || 3,
      window: document.getElementById("window").value.trim(),
    });
    show("saveMsg", "已写入 " + result.configPath, true);
    document.getElementById("doneDetail").textContent =
      "共享 " + result.count + " 项能力，配置在 " + result.configPath +
      (result.backup ? "，改动前的那份备份在 " + result.backup : "");
    document.getElementById("done").classList.add("show");
  } catch (e) {
    show("saveMsg", String(e.message || e), false);
  } finally {
    btn.disabled = false;
  }
};

document.getElementById("quit").onclick = async () => {
  try { await api("/api/finish", {}); } catch {}
  document.body.innerHTML = '<div class="wrap"><h1>已退出</h1>' +
    '<p class="sub">本机的配置服务已经关掉，可以关闭这个标签页了。</p></div>';
};

refresh().catch((e) => show("joinMsg", String(e.message || e), false));
</script>
</body>
</html>`;
}
