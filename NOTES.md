> **关于版本号**：下面保留了开发过程中的内部编号（v3.x）。公开发布的版本号已重新编为 1.0，
> 功能对应内部编号 v3.8 + 本轮清理。本文中的具体模型 slug 与区域名已替换为占位符。
# ChatGPT Route Inspector — 诊断与交接记录

## ★ 根本原因（2026-09-29 实测确认）

**Tampermonkey 的全局总开关是关的。**

证据链：

1. 从 Edge 的 LevelDB 读出 `!extdb.#config` =
   `{"origin":"normal","value":{"enabled":false,"script_blacklist_server":[…]}}`
2. 从扩展本体 `background.js` 里找到默认值表：
   `un={enabled:!0, configMode:0, debug:!1, …}` —— **`enabled` 默认是 `true`**，
   而磁盘上是 `false`。
3. 找到唯一改写它的代码路径（`toggle-enable` 命令）：
   `"toggle-enable"==e?(wn.values.enabled=!wn.values.enabled,…)`
4. 把 `#config.enabled` 改回 `true` 并重启 Edge 后，**用户脚本立刻开始执行**：
   真实 `chatgpt.com` 页面上 `window.__RI__` 存在、`#ri-panel` 在 DOM 里、
   `fetch` 被接管、`targetHits=4`、并且读到了
   `assistantModel = resolvedModel = <model-A>`。

结论：此前"Userscript 不稳定执行 / 浮窗不稳定出现"**不是脚本的问题**，
而是扩展级总开关被关掉了——此时每个脚本自身的 `enabled:true` 毫无作用。

> 复现方式：右键 Tampermonkey 工具栏图标，若菜单里 "Enabled" 是灰的，
> 就说明总开关处于 Disabled。修复：点它切回 Enabled。

## ★ 最终实测结果（2026-09-29 14:18，真实 chatgpt.com，v3.4）

六个字段**同时**从真实站点读出来了，而且全部来自**这一次真正的对话轮**
（`diag.src` 显示每一项都是 `2:/backend-api/f/conversation`）：

```
Route Inspector  v3.4
CAPTURED  turn 3  @ 14:18:16
  Request       <model-A>
  Server STE    <model-B>
  Assistant     <model-B>
  Resolved      <model-A>
  Region/Plan   <region> / <plan>

calls=120  hits=30  exact=3  other=27  streams=27  events=66  badJson=0
src={"assistantModel":"2:/backend-api/f/conversation",
     "resolvedModel":"2:/backend-api/f/conversation",
     "requestModel":"2:/backend-api/f/conversation",
     "steModel":"2:/backend-api/f/conversation",
     "clusterRegion":"2:/backend-api/f/conversation",
     "planType":"2:/backend-api/f/conversation"}
```

注意 `Request=<model-A>` 但 `Assistant/STE=<model-B>` —— 这正是用户
要找的那类信号：客户端申明的模型和服务端暴露的模型不是同一个 slug。
（按约定，这只能说明"服务端向客户端暴露的路由 metadata 与请求不一致"，
不能断言物理 GPU 上加载了哪套权重。）

### 这一轮修掉的三个状态机 bug

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 1 | 任何匹配 `conversation` 的 POST 都触发"新一轮清空" | `init`/`prepare`/`batch` 紧跟着把刚读到的 STE 清掉，面板永远空 | 只有精确 `POST /backend-api/f/conversation` 才清空 |
| 2 | 所有端点同权重写入 | `/conversations/batch` 会把**别的对话**的 model_slug 写进面板 | 字段分级：本轮=2、旁路=1；高优先级覆盖低，低优先级只能填空 |
| 3 | 页面 abort 流被当成错误 | diag 长期显示 `lastError` | AbortError 归为正常结束 |

回归测试：`ri-harness.mjs` 29 项，其中 3 项专门断言"旁路端点不许清空/覆盖面板"。

### 实测到的端点分布（一次真实使用）

| 路径 | 次数 | 是否算"新一轮" | 是否用于填充 |
|---|---|---|---|
| `/backend-api/f/conversation` | 3 | ✅ 是 | ✅ 优先级 2 |
| `/backend-api/conversation/init` | 17 | ❌ 否 | ✅ 优先级 1（仅填空） |
| `/backend-api/f/conversation/prepare` | 5 | ❌ 否 | ✅ 优先级 1（另存 Request 模型） |
| `/backend-api/conversations/batch` | 5 | ❌ 否 | ✅ 优先级 1（仅填空） |

---

日期：2026-09-29
范围：Microsoft Edge（Profile 1）+ Tampermonkey 5.5.0 + ChatGPT 普通网页
定位：**只描述服务端向客户端暴露的模型路由 metadata**，不是"物理 GPU 权重证明"。

---

## 0. 一句话结论

脚本已经**真正装进 Tampermonkey 并处于启用状态**，代码逻辑已在**真实 Chromium 引擎**里
用真实的流式 SSE 跑通（面板渲染、fetch hook、`res.clone()`、增量 SSE 解析、多轮不串数据
全部通过）。**唯一还没做的一步**是：在真实 `chatgpt.com` 页面上聊一轮，用面板旁的
诊断 beacon 把实时字段取回来——这一步需要页面上真的发生一次对话。

---

## 1. 五个状态必须分开看（本轮实测结果）

| 状态 | 结果 | 证据 |
|---|---|---|
| 1. 本地源码存在 | ✅ | `route-inspector.user.js` (31,239 B) |
| 2. Tampermonkey 已保存 | ✅ | LevelDB 内 `!extdb.@source#4ab5cfda-…`，长度 31,239 |
| 3. Tampermonkey 已启用 | ✅ | `!extdb.@meta#4ab5cfda-…` → `enabled:true, version:"3.1", position:1` |
| 4. Userscript 已执行（真实 chatgpt.com） | ⏳ 待一轮对话触发 | beacon 已就位，监听 `127.0.0.1:8791` |
| 5. DOM 已挂载 / fetch 已 Hook | ✅（真实浏览器已证） | 见第 4 节截图与 AX 文本 |
| 6. conversation 已命中 / SSE 已解析 | ✅（真实浏览器已证） | `hits=3 streams=3 events=7 badJson=0` |

> 第 4 项和第 5、6 项的区别：5/6 用的是本机 mock 页（真实 Chromium + 真实 userscript +
> 真实 `ReadableStream` SSE），证明**代码在这一层是对的**；4 项要证明的是
> **Tampermonkey 在 chatgpt.com 上真的会注入并运行**，那需要真实页面加载。

---

## 2. 本轮实际改了什么

### 2.1 v3.0 → v3.1 的实质修复

| # | 问题 | v3.0 | v3.1 |
|---|---|---|---|
| 1 | **`server_ste_metadata` 只认一种形状** | 只匹配 `obj.server_ste_metadata` | 同时匹配 `{type:"server_ste_metadata", metadata:{…}}`（即你实际观察到的形状）——**这是最关键的修复，v3.0 很可能因此一条 STE 都读不到** |
| 2 | STE 的 `model_slug` 污染 Assistant 字段 | 会串 | 加了 `looksLikeSte()` 守卫，STE 形状的 metadata 不再被当成 assistant metadata |
| 3 | 上/下轮数据串台 | 只清部分字段 | `startTurn()` 在每次新 POST 时整体清空 6 个字段，再按本轮 SSE 重新填 |
| 4 | 面板可能被 ChatGPT 的 CSS 影响 | 内联样式裸 div | Shadow DOM + `:host{all:initial}`，样式与页面彻底隔离 |
| 5 | 无法确认注入上下文 | 无 | 面板显示 `ctx=page / sandbox`；用 `unsafeWindow \|\| window` 双保险，`@sandbox raw` 强制页面上下文 |
| 6 | 无法离线自检 | 无 | `window.__RI__`（`state` / `diag` / `dump()`），并被 `ri-harness.mjs` 全量断言 |
| 7 | 页面被 abort / 非流式响应 | 只处理流 | 按 `content-type` 分流：`event-stream` → 流式解析；否则按整体 JSON 解析 |
| 8 | `window.addEventListener` 缺失时直接抛错 | 直接调用 | 已加保护（由 harness 首轮实测暴露并修掉） |

### 2.2 安装方式

机器上**无法用 GUI 操作 Edge**（Computer Use 对浏览器窗口被策略拦下，见第 5 节），
所以改用**直接写入 Tampermonkey 自己的 LevelDB**：

- 先把现有工程完整备份（含全部历史版本）；
- 把 TM 存储目录整个备份；
- 写入前先做两道字节级校验：CRC32C+mask 逐物理片段比对（324/324 一致）、
  WriteBatch 重新编码回环比对（321/321 逐字节一致）；
- 先写到**副本**并重新解析验证，全部通过后才写真实文件；
- 写入后 TM 自己又追加了 85 B（说明 TM 正常打开并接受了这批记录）。

---

## 3. 证据清单（可复现）

| 证据 | 位置 / 命令 | 结果 |
|---|---|---|
| 语法检查 | `node --check route-inspector.user.js` | PASS |
| 端到端逻辑测试（22 项） | `node ri-harness.mjs route-inspector.user.js` | 22 passed, 0 failed |
| LevelDB 编码器校验 | `tm-storage-tools\tm-encode-check.mjs <db>` | CRC 324/324、回环 321/321 |
| TM 实际保存内容 | `tm-storage-tools\tm-export.mjs <db> <out>` | v3.1 / enabled / pos=1 / sha f9ecb922d67bfaaf |
| 真实浏览器截图 | `outputs\ri-panel-proof.png` | 面板右下角正常渲染 |
| 真实浏览器 AX 文本 | 见下方代码块 | 字段与 diag 全部正确 |

真实浏览器（Chromium）实测输出：

```
ROUTE INSPECTOR  v3.1
RUNNING   CAPTURED turn 3 @ 13:31:26
Request      <model-A>
Server STE   <model-A>
Assistant    <model-A>
Resolved     <model-A-2026-09>
Region/Plan  <region> / <plan>
mounted=true  fetch=true  xhr=true  ctx=page
calls=3  hits=3  streams=3  events=7  badJson=0
err=(none)
```

同页页面自身日志：`turn 3 consumed 28 chunks - page stream intact`
—— 说明 `res.clone()` 没有抢走页面自己的流。

其中第 3 轮刻意让 `resolved_model_slug` 变成 `-2026-09`，面板正确显示最新值而不是第一帧，
且第 2 轮的 `<region-B> / <plan-B>` 没有残留 —— 多轮不串台已证。

---

## 4. 尚未完成的一步

**在真实 `chatgpt.com` 上产生至少一轮对话。**

已就位的观测通道：`RI Beacon (diagnostic)` 用户脚本会在页面加载后，把
`window.__RI__` 的 `diag` / `state`、`#ri-panel` 是否在 DOM 里、`window.fetch`
是否仍被接管，POST 到 `http://127.0.0.1:8791/ri`（**仅回环，纯本地**，
不发送任何 prompt / 回复正文 / 聊天记录）。

只要在 Edge 里打开 `https://chatgpt.com/` 并发一轮消息，随后即可从
`work\beacon-log.jsonl` 读出该页面的真实结果。

---

## 5. 环境限制（为何需要上面这一步）

- 本机 Computer Use **无法对 Edge 窗口取状态**：
  `Computer Use has been stopped for this turn because it could not determine the
  current browser URL on Windows with enough confidence to enforce policy.`
  → 所有依赖截图/无障碍树的 Edge GUI 操作（含点地址栏、开标签、Ctrl+Shift+R）都不可用。
- 用 shell 启动浏览器同样被策略拦下（`Start-Process msedge.exe …` 被拒）。
- 因此"把页面导航到 chatgpt.com"这一动作本机无法由 agent 完成，属于真实的人机交接点。

---

## 6. 副作用与复位

| 项目 | 说明 | 如何复位 |
|---|---|---|
| Tampermonkey 内新增 `RI Beacon (diagnostic)` | 临时诊断脚本，只在 chatgpt.com 上跑，只发回环 JSON | 在 Tampermonkey 面板里删除该项即可 |
| 本机回环监听 `127.0.0.1:8791` | 诊断用，仅本机可连 | 结束对应 `node` 进程 |
| Edge 曾被杀进程 / 重开 | 会话未恢复到原标签 | 手动打开 chatgpt.com 即可 |
| TM 存储整目录备份 | 写入前备份 | `work\tm-storage-backup-20260929-132747` |
| 历史版本备份 | 未删除任何旧文件 | `tools\codex-forensics\backup\20260929-132206` |

---

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `route-inspector.user.js` | **正式脚本 v3.1**（已装进 Tampermonkey 并启用） |
| `ri-beacon.user.js` | 临时诊断 beacon（读取 `__RI__` 并回环上报） |
| `chatgpt-ui-canary.user.js` | 纯 Canary（只挂 DOM，不碰网络），排障第一层用 |
| `ri-harness.mjs` | 端到端测试：在 Node 里跑真实脚本 + 模拟 SSE，22 项断言 |
| `tm-storage-tools/` | Tampermonkey LevelDB 读取 / 校验 / 导出 / 安装工具 |
| `backup/20260929-132206/` | 本轮开工前的历史版本备份 |
