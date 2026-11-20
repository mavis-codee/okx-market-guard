# OKX Market Guard

只读的 OKX 公共行情接入层，给 AI agent 用。同时提供 **MCP server**（stdio / JSON-RPC 2.0）和 **CLI**。运行时零 npm 依赖。TypeScript 源码在 Node 22.6+ / Node 24 上直接跑（类型剥离）。

> **安全红线。** 本项目**只**访问 OKX 官方**公共**行情 REST（`https://www.okx.com`）。**没有 API key**，不能下单/撤单，不能划转，读不到账户和钱包。告警是无状态阈值比较——不存储、不推送。

## Tools

| 工具 | 作用 | OKX 公共 GET 端点 |
| --- | --- | --- |
| `market_ticker` | 最新 ticker + 24h 涨跌幅 + 点差 | `/api/v5/market/ticker` |
| `market_candles` | OHLCV K 线，新到旧，`bar` 1m–3M，limit 1–300 | `/api/v5/market/candles` |
| `funding_rate` | 永续资金费率（instId 必须以 `-SWAP` 结尾） | `/api/v5/public/funding-rate` |
| `oi_summary` | 持仓量，按 `instId` 或 `instType`/`ccy` | `/api/v5/public/open-interest` |
| `alert_check` | 一次性阈值判断（无状态） | 同上公共端点 |

`alert_check` 指标：`last`、`changePercent24h`、`high24h`、`low24h`、`bidAskSpreadPct`、`fundingRate`（仅 SWAP）、`openInterest`（SWAP/FUTURES）。操作符：`gt`、`gte`、`lt`、`lte`。

## 安全栏

- **主机 + 路径白名单。** 只允许 `https://www.okx.com` 和上面五个公共路径（外加 `/api/v5/public/time`）。私有/交易/账户路径在进程内直接拒绝，不发 HTTP。
- **永远不带凭据。** 传入 `apiKey` / `secret` / `passphrase` / `token` 选项会抛错。请求不带 `Authorization`。`redirect: 'error'` 挡掉重定向 SSRF。
- **MCP 只读标注。** 每个 tool 都声明 `readOnlyHint: true`、`destructiveHint: false`。
- **输入校验。** instId 形状、bar 枚举、limit 范围、多余参数拒绝、funding 必须是 SWAP。
- **限速。** 令牌桶，默认 8 次/秒，突发 16（OKX 公共限额约 20 次 / 2 秒 / IP）。
- **OKX 错误友好化。** 信封 `code !== '0'` 会变成带提示的消息（instId 类型错、限流、超时、DNS/代理）。
- **告警无状态。** `alert_check` 只比较一个数和一个阈值然后返回。没有监控列表、没有通知、没有写操作。

## 快速开始

Node.js **>= 22.6**（推荐 24）。不需要 `npm install`。

```bash
node src/cli.ts --help
node src/cli.ts ticker BTC-USDT --pretty
node src/cli.ts candles BTC-USDT --bar 1H --limit 24 --pretty
node src/cli.ts funding BTC-USDT-SWAP --pretty
node src/cli.ts oi BTC-USDT-SWAP --pretty
node src/cli.ts alert BTC-USDT --metric last --op gt --threshold 100000 --pretty
```

如果本机 DNS 解析不了 `www.okx.com`（防火墙环境常见），要在 **Node 进程启动前** 打开内置代理：

```powershell
# Windows PowerShell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"   # 换成你的代理
node src/cli.ts ticker BTC-USDT --pretty
```

```bash
# macOS / Linux
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node src/cli.ts ticker BTC-USDT --pretty
```

`NODE_USE_ENV_PROXY` 只在 Node 启动时读取；在脚本里再设置来不及。`--env-file=.env` 也**不会**生效。

## MCP 客户端配置

把 stdio server 挂到任意 MCP 客户端：

```json
{
  "mcpServers": {
    "okx-market-guard": {
      "command": "node",
      "args": ["<绝对路径>/src/cli.ts", "serve"],
      "env": {
        "NODE_USE_ENV_PROXY": "1",
        "HTTPS_PROXY": "http://127.0.0.1:7890"
      }
    }
  }
}
```

协议：stdio 上的换行分隔 JSON-RPC 2.0。默认 `2025-06-18`（也接受 `2025-03-26`、`2024-11-05`）。日志走 **stderr**；JSON-RPC 走 **stdout**。

## 测试

```bash
npm test          # 单测（mock fetch）+ live 测试（连不上 OKX 会自动 skip）
```

Live 测试打真实公共端点，用 `BTC-USDT` / `BTC-USDT-SWAP`。想跳过可设 `OKX_SKIP_LIVE=1`。

Demo（真实 REST，完整输出）：

```bash
node demo/demo.ts
# 最近一次实跑记录：docs/demo-output.txt
```

## 目录

```
src/
  okx-client.ts    白名单公共 REST 客户端
  tools/index.ts   五个 tool
  mcp/server.ts    JSON-RPC 2.0 stdio server
  cli.ts           CLI + serve
  validate.ts      输入校验
  ratelimit.ts     令牌桶 + 凭据拦截
  errors.ts        友好错误
test/              node:test 单测 + live
demo/demo.ts       实跑 demo
docs/              demo 记录、AI Builder 申请文案草稿
```

## 这不是什么

- 不是交易机器人，不是 key 管理器，不是 WebSocket 行情，也不是 okx.com 镜像。
- OKX AI Builder 的申报材料只是**草稿**（`docs/`）；提交是人肉走**官方** App（Menu → Builder）或 **okx.com**。不要用镜像/帮助页域名。

## License

MIT
