# Route Inspector

一个用户脚本，在 `chatgpt.com` 右下角实时显示**服务器向客户端暴露的模型路由元数据**。

> **关于本项目**：由 AI 协作生成（人负责需求、验收与决策）。MIT 许可，不要求署名，不提供任何担保。觉得有用就拿去用，不必提谁做的。

## 它显示什么

| 行 | 来源字段 | 含义 |
|---|---|---|
| 请求模型 | 请求体的 `model` | 客户端实际提交的模型 |
| 路由模型 | `server_ste_metadata.metadata.model_slug` | 服务端调度指派的内部模型 |
| 回答模型 | `message.metadata.model_slug` | 生成这条回复的模型 |
| 区域套餐 | `cluster_region` / `plan_type` | 例如 `japaneast / plus` |

灰色「等待中...」= 这一轮服务器**没有暴露**该字段（不猜、不推断）。

## 它不显示什么

- 不读取、不记录、不上传任何 prompt、回复正文或聊天记录
- 不发起任何自己的网络请求
- 不修改任何请求

它只从 `/backend-api/f/conversation` 这一条真实对话流里提取上面四个字段。

## 重要边界

**这是"服务器向客户端暴露的路由 metadata 的忠实副本"，不是"某个型号的 GPU 上加载了哪套权重"的证明。**

如果服务器在下发的 metadata 上写错了，本工具会忠实显示这个错误。它证明的是"服务端自称如此"，仅此而已。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Edge / Chrome 均可）
2. 打开 `route-inspector.user.js`，Tampermonkey 会提示安装
3. 打开 `https://chatgpt.com/`，发一条消息

面板默认隐藏，**发消息后才弹出**，不会挡住界面。标题栏可拖动，右上角 `—` 临时隐藏（下次提问重现），`×` 本次关闭（刷新页面恢复）。

> 如果脚本不执行：先检查 Tampermonkey 的**全局开关**（右键工具栏图标，`Enabled` 不能是灰的）。这是最常见的"脚本没反应"原因。

## 准确度（基于 339 条实测快照）

| 维度 | 结果 |
|---|---|
| 解析正确性 | 339 条快照中 `parseErrors = 0`；SSE 分片、`[DONE]`、双重转义 JSON 均已覆盖 |
| 字段召回 | 在 v3.4+ 上，所有被测页面均为 **5/5**（四项齐全）；旧版本偏低是脚本 bug 所致，非服务端不下发 |
| 归属正确性 | v3.8 起，面板**只显示本轮自己响应流里的值**（`src` 可溯源）；v3.7 及以前旁路端点可能填充，已移除 |

## 已知限制

1. 依赖**未公开接口**（`/backend-api/f/conversation`）。OpenAI 若改动端点或载荷形状，需要更新。
2. 失败时是**安全失败**：显示「等待中...」，不影响 ChatGPT 本身使用。
3. 只覆盖 `chatgpt.com` 网页端。**桌面客户端 / CLI 走的是另一套传输（WebSocket）**，不在本工具范围内。

## 自测

```bash
node --check route-inspector.user.js
node test/ri-harness.mjs route-inspector.user.js   # 43 项断言，全部应 PASS
```

测试台在 Node 里构造迷你 DOM + 假流式 `Response`，直接运行**未经修改的正式脚本**，覆盖：面板契约、fetch/XHR 钩子、`res.clone()`、分片 SSE、多轮不串、旁路端点不污染、窗口控制。

## 许可

MIT
