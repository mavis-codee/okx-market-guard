# OKX AI Builder — 申请表文案草稿（中文）

> **使用方式。** 把下面的字段复制进 OKX 官方 AI Builder 申请表。
> 只走官方入口：**OKX App 内 Menu → Builder** 或 **okx.com**。
> 不要用任何镜像站或"帮助页"域名。
> 本仓库不会自己提交申请；提交是用户点头之后的人工动作。

---

## 1. 项目名

OKX Market Guard（OKX 行情守卫）

## 2. 赛道 / 分类

AI 赛道 — MCP 集成自有 AI 产品（agent 工具服务 + CLI）

## 3. 一句话介绍（≤ 140 字）

只读 OKX 公共行情的 MCP server + CLI：ticker / K线 / 资金费率 / 持仓量 / 无状态告警。不带 key，不能下单，不碰账户。

## 4. 问题

现在让 AI agent 聊行情，通常只有两条烂路：

1. 发一把带交易权限的 API key——权限过大，容易泄露，模型也可能做出不可逆操作。
2. 去爬网页或用过期 CSV——不准、慢，也不符合 OKX 规则。

缺一个**小、可审计、只读**的桥：agent 要什么公共行情就给什么，多一点都不给。

## 5. 方案

**OKX Market Guard** 是一个 Model Context Protocol server（配套 CLI），只暴露五个工具：

- `market_ticker` — 最新价 / 买卖一档 / 24h 统计 / 涨跌幅 / 点差
- `market_candles` — OHLCV，1m 到 3M，最多 300 根
- `funding_rate` — 永续资金费率（instId 必须是 `-SWAP`）
- `oi_summary` — 持仓量，按合约或按品种/币种
- `alert_check` — 对最新公共数据做一次 `gt/gte/lt/lte` 阈值判断

agent 调工具，我们调一次 `https://www.okx.com/api/v5/*` 的公共 GET，返回 JSON。整个闭环就这一下。

## 6. 怎么用 OKX

- 只用官方 **OKX V5 公共行情 REST**：ticker、candles、funding-rate、open-interest、服务器时间。
- 不碰私有端点，不用 WebSocket（本期），不登录，不做 key 管理。
- instId 遵守 OKX 习惯（`BTC-USDT`、`BTC-USDT-SWAP`）。
- OKX 错误码映射成 agent 能看懂的提示，模型可以自己改参数重试（现货/永续搞反、限流、超时）。

## 7. 目标用户

- 想给 agent/co-pilot 接实时 OKX 行情、又不想把交易 key 塞给模型的开发者。
- 需要可复现快照（ticker、funding、OI）的研究/内容流水线。
- 过不了"无提现、无下单、无 key"安全审查的内部工具——这个项目就是为那种审查设计的。

## 8. 差异化

| 常见接法 | OKX Market Guard |
| --- | --- |
| 完整 API key 交到 agent 手里 | **零凭据**——进程会拒绝 key 形状的参数 |
| 模型"想交易就交易" | **不能**——交易/账户路径不在白名单 |
| 每个 agent 自己糊 HTTP | **标准 MCP**（stdio JSON-RPC 2.0，`2025-06-18`） |
| 限流失败静默 | 令牌桶 + 友好 OKX 错误提示 |
| "告警"要数据库和推送 | **无状态**判断；不存、不推 |

## 9. 安全与合规（设计，不是口号）

- 域名锁死：只许 `https://www.okx.com`，镜像在代码里拒绝。
- 路径白名单：5 条公共行情路径 + time。其它一律 `SafetyError`，socket 都不开。
- `redirect: 'error'`，302 带不走。
- MCP 工具标注：`readOnlyHint: true`、`destructiveHint: false`。
- 输入校验（instId 形状、bar 枚举、limit 1–300、多余参数拒绝）。
- 限速：8 次/秒、突发 16（低于 OKX 公共约 20 次 / 2 秒 / IP）。
- 回归：node:test 单测（mock fetch）+ 真实公共端点 live 冒烟。

## 10. Demo

- 仓库内实跑记录：`docs/demo-output.txt`（五个工具的真实 REST 返回 + 两个拒绝案例）。
- CLI：`node src/cli.ts ticker BTC-USDT --pretty`
- MCP：任意 MCP 客户端 → `node src/cli.ts serve`

60 秒演示脚本（等用户同意建公开 repo 后，可把这段当"demo 链接"的说明）：

1. MCP `initialize` → server 名 `okx-market-guard`，instructions 写明 READ-ONLY。
2. `tools/list` → 五个工具，全部 `readOnlyHint`。
3. `tools/call market_ticker {instId:"BTC-USDT"}` → 实时 last/bid/ask。
4. `tools/call alert_check {instId:"BTC-USDT", metric:"last", op:"gt", threshold:0}` → `triggered: true`。
5. 试 `place_order` → 未知工具。试 `/api/v5/account/balance` → 白名单拒绝。

## 11. 技术栈

- TypeScript（可剥离语法）跑在 Node 22.6+ / 24，直接运行，无构建步骤。
- 运行时零 npm 依赖，`fetch` 用 Node 内置。
- MCP 是 stdio 上的换行分隔 JSON-RPC 2.0，没用 SDK。
- 测试：`node:test`。

## 12. 路线图（如果继续做）

1. **v0.2** — 可选 `instType` 批量 ticker（`/api/v5/market/tickers`）、历史 K 线翻页助手。
2. **v0.3** — 更多仍然是只读的公共端点：instruments、mark-price、index-tickers 等。
3. **v0.4** — 本地限速可配置；结构化日志。
4. **除非 OKX 和仓库主人都要求，否则不做：** 私有端点、key、下单、带推送的告警。产品论点就是反着来的。

## 13. 团队

Mavis — 本 MVP 的设计与实现（MCP server、CLI、安全栏、测试、文档）。联系方式走官方表单。

## 14. 想要什么

- 加入 OKX AI Builder 共建计划（AI 赛道）。
- 请官方看一看这套只读接法，确认和 OKX 开发者政策对齐。
- 如入选：官方文档位；以及 OKX 希望重点展示哪些**公共**端点。

**不**申请交易权限、做市商标记或 key 托管。

## 15. 诚实边界

- 本期只有公共 REST；盘口深度只有 ticker 的 L1 bid/ask。
- `alert_check` 是当下一次判断，不会盯盘。agent 可以再调；我们不会通知任何人。
- 工具输出是英文字段名 + OKX 原始数字字符串，没做 i18n。
- Demo 和测试需要能出网到 `www.okx.com`（或用 `NODE_USE_ENV_PROXY` 走 HTTP 代理）。

---

**提交提醒。** 以上内容只往官方表单里贴。仓库主人尚未同意建公开远端、发 GitHub release 或真的提交申报。`push` / 建 repo / 申报 = 等人点头。
