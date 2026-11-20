# OKX AI Builder — 申请表文案草稿（中文）

> **使用方式。** 把下面的字段复制进 OKX 官方 AI Builder 申请表。
> 只走官方入口：**OKX App 内 Menu → Builder** 或 **okx.com**。
> 不要用任何镜像站或"帮助页"域名。
> 本仓库不会自己提交申请；提交是用户点头之后的人工动作。

---

## 1. 项目名

OKX Market Guard（OKX 行情守卫）

## 2. 赛道 / 分类

AI 赛道 — 官方 CLI 集成（`@okx_ai/okx-trade-cli`，带 aiBuilderCode 归因）+ 只读行情 MCP

## 3. 一句话介绍（≤ 140 字）

demo 优先，下单走官方 CLI 并在支持的命令上带 `--aiBuilderCode`；另提供只读行情 MCP。key 不进 agent 进程。

## 4. 问题

现在让 AI agent 接 OKX，通常只有两条烂路：

1. 发一把带交易权限的 API key 塞进 agent——权限过大，容易泄露，模型也可能做出不可逆操作。
2. 去爬网页或用过期 CSV——不准、慢，也不符合 OKX 规则。

交易这边，AI Builder 计划要求在支持的下单命令上带可核验的 `aiBuilderCode`。很多 agent 包装要么把 code 丢了，要么塞进 raw `tag`，要么自己重写签名，OKX 没法归因。

缺一个**小、可审计**的桥：(a) 只读给 agent 公共行情；(b) 下单**只**走官方 CLI，**默认 demo**，`--aiBuilderCode` 只加在官方 `--help` 写了的地方。

## 5. 方案

**OKX Market Guard** 是一个 Model Context Protocol server（配套 CLI），两层：

**行情层 — 五个只读工具**（`https://www.okx.com/api/v5/*` 公共 REST，不带 key）：

- `market_ticker` — 最新价 / 买卖一档 / 24h 统计 / 涨跌幅 / 点差
- `market_candles` — OHLCV，1m 到 3M，最多 300 根
- `funding_rate` — 永续资金费率（instId 必须是 `-SWAP`）
- `oi_summary` — 持仓量，按合约或按品种/币种
- `alert_check` — 对最新公共数据做一次 `gt/gte/lt/lte` 阈值判断

**交易层 — 九个工具，spawn 官方 `@okx_ai/okx-trade-cli@1.5.1`：**

- `trade_spot_place` → `okx spot place`
- `trade_spot_batch_place` → `okx spot batch --action place`
- `trade_swap_place` → `okx swap place`
- `trade_swap_close` → `okx swap close`
- `trade_swap_batch_place` → `okx swap batch --action place`
- `trade_futures_place` → `okx futures place`
- `trade_futures_close` → `okx futures close`
- `trade_futures_batch_place` → `okx futures batch --action place`
- `trade_option_place` → `okx option place`

**不包** `cancel` / `amend` / 查询类命令（官方 `--help` 不暴露 `--aiBuilderCode`）。raw `tag` 永远不传。

## 6. 怎么用 OKX

- 行情层只用官方 **OKX V5 公共行情 REST**（ticker、candles、funding-rate、open-interest、服务器时间）。我们自己的 HTTP 客户端不碰私有端点。
- 每一笔单都走官方 **`@okx_ai/okx-trade-cli`**。签名、profile、请求信封都在官方包里。我们是 spawn，不是重写交易 API。
- **AI Builder 归因：** `OKX_AI_BUILDER_CODE`（1–16 位字母数字）设置了以后，bridge 只在官方 `--help`（1.5.1 实测）列出该 flag 的命令上追加 `--aiBuilderCode <code>`：`spot place`、`spot batch (place)`、`swap place`、`swap close`、`swap batch (place)`、`futures place`、`futures close`、`futures batch (place)`、`option place`。
- **默认 demo：** 每次 trade spawn 默认带 `--demo`，除非运维用 `--trade-live` 启动 server。空 code + live = 拒绝。live 是 **server 启动开关**，不是 tool 参数——agent 不能自己升级到真实资金。
- 凭据放用户本机 `~/.okx/config.toml`。agent 进程不读、不存、不打印 `api_key` / `secret_key` / `passphrase`。子进程 CLI 自己读那个文件。

## 7. 目标用户

- 想给 agent/co-pilot 接实时 OKX 行情、又不想把交易 key 塞给模型的开发者；真要下单时也要 demo 先行。
- OKX AI Builder 里需要一个**官方 CLI 组合 + aiBuilderCode 正确归因**参考实现的 builder。
- 过不了"agent 进程无 key、默认不碰真实资金"安全审查的内部工具——这个项目就是为那种审查设计的。

## 8. 差异化

| 常见接法 | OKX Market Guard |
| --- | --- |
| 完整 API key 交到 agent 手里 | **本进程零凭据**——key 形状的参数会抛错；子进程 env 是白名单 |
| 手写交易 API + 自定义签名 | **官方 CLI 子进程**——下单逻辑是 OKX 的，不是我们的 |
| `aiBuilderCode` 丢掉，或塞进 raw `tag` | **help 实测白名单**——只在官方 `--help` 暴露该 flag 的命令上加 |
| live 是模型能翻的 tool 参数 | **live 是 server 启动开关**；默认 `--demo`；空 code + live = 拒 |
| 限流失败静默 | 行情令牌桶 + 交易 spawn 单独限速 + 友好 OKX 错误提示 |
| "告警"要数据库和推送 | **无状态**行情判断；不存、不推 |

## 9. 安全与合规（设计，不是口号）

行情层：

- 域名锁死：只许 `https://www.okx.com`，镜像在代码里拒绝。
- 路径白名单：5 条公共行情路径 + time。其它一律 `SafetyError`，socket 都不开。
- `redirect: 'error'`，302 带不走。
- MCP 标注：行情工具 `readOnlyHint: true`、`destructiveHint: false`。

交易层：

- 只做组合：`src/trade-cli-bridge.ts` 校验、限速、拼 argv、spawn、错误脱敏。不签名。
- `--demo` 是默认。`--live` 不从 tool 参数推断。
- `OKX_AI_BUILDER_CODE`：空 → 拒 live；不是 1–16 位字母数字 → 拒。
- 子进程 env 白名单（`PATH`、代理、site/timeout），剥掉 `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`。
- raw `tag` 作为未知参数被拒。
- 交易工具标注 `readOnlyHint: false`、`destructiveHint: true`。
- 测试 mock `execFile`；`npm test` 不下真实单（demo 也不下）。

## 10. Demo

- 仓库内行情实跑记录：`docs/demo-output.txt`（五个工具的真实 REST 返回 + 两个拒绝案例）。
- 官方 CLI 1.5.1 的 help 证据（`--aiBuilderCode` 在哪些命令出现、哪些不出现）也在 `docs/demo-output.txt`。
- CLI 计划模式（不 spawn、不下单）：

```bash
node src/cli.ts trade-tools --pretty
node src/cli.ts trade-plan trade_spot_place --instId BTC-USDT --side buy --ordType limit --sz 0.001 --px 50000 --pretty
```

- MCP：任意 MCP 客户端 → `node src/cli.ts serve`（带 trade 工具，demo）。`--no-trade` 回到行情-only。

60 秒演示脚本：

1. MCP `initialize` → server 名 `okx-market-guard`，instructions 写明行情只读 + 官方 CLI demo 优先交易。
2. `tools/list` → 5 个行情工具（`readOnlyHint`）+ 9 个 `trade_*` 工具（`destructiveHint: true`）。
3. `tools/call market_ticker {instId:"BTC-USDT"}` → 实时 last/bid/ask。
4. 默认模式 `tools/call trade_spot_place {...}` → 子进程 argv 含 `--demo`；设了 `OKX_AI_BUILDER_CODE` 还会含 `--aiBuilderCode`。
5. 试图从 tool call 翻 live → 不可能；live 是启动时 `--trade-live`，空 code 直接拒。

## 11. 技术栈

- TypeScript（可剥离语法）跑在 Node 22.6+ / 24，直接运行，无构建步骤。
- 行情层运行时零 npm 依赖，`fetch` 用 Node 内置。
- 交易层：官方 `@okx_ai/okx-trade-cli`（实测 1.5.1），按 `OKX_TRADE_CLI` → 本地 `node_modules` → `npx -y` 解析。
- MCP 是 stdio 上的换行分隔 JSON-RPC 2.0，没用 SDK。
- 测试：`node:test`（81 例；live 公共端点冒烟连不上 OKX 会 skip）。

## 12. 路线图（如果继续做）

1. **v0.2** — 可选 `instType` 批量 ticker（`/api/v5/market/tickers`）、历史 K 线翻页助手。
2. **v0.3** — 更多仍然是只读的公共端点：instruments、mark-price、index-tickers 等。
3. **v0.4** — 跟随官方 CLI 版本：如果后续版本在更多命令（或新品类）暴露 `--aiBuilderCode`，按 help 实测扩白名单；绝不抢跑官方 help。
4. **不做：** key 托管、第二套签名实现、默认 live、raw `tag` 归因。

## 13. 团队

Mavis — 本 MVP 的设计与实现（MCP server、CLI、官方 CLI 交易桥、安全栏、测试、文档）。联系方式走官方表单。

## 14. 想要什么

- 加入 OKX AI Builder 共建计划（AI 赛道）。
- 请官方看一看**官方 CLI 组合 + `aiBuilderCode` help 白名单**这套接法，确认和 OKX 希望的 builder 归因方式对齐。
- 如入选：官方文档位；以及 OKX 希望重点展示哪些**公共**端点或官方 CLI 面。

**不**申请做市商标记或 key 托管。交易权限是用户自己的，走用户自己的 `~/.okx/config.toml` 和官方 CLI。

## 15. 诚实边界

- 行情只有公共 REST；盘口深度只有 ticker 的 L1 bid/ask。
- `alert_check` 是当下一次判断，不会盯盘。agent 可以再调；我们不会通知任何人。
- 交易工具要求用户自己装好官方 CLI 并配 profile。本仓库不打包 key。
- `cancel` / `amend` 没有暴露成工具（那里的 help 不暴露 `--aiBuilderCode`）。要撤单可以直接用官方 CLI。
- 工具输出是英文字段名 + OKX 原始数字字符串，没做 i18n。
- Demo 和测试需要能出网到 `www.okx.com`（或用 `NODE_USE_ENV_PROXY` 走 HTTP 代理）。

---

**提交提醒。** 以上内容只往官方表单里贴。仓库主人尚未同意建公开远端、发 GitHub release 或真的提交申报。`push` / 建 repo / 申报 = 等人点头。
