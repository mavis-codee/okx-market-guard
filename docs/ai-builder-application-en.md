# OKX AI Builder — Application Draft (EN)

> **How to use this file.** Copy the fields below into the official OKX AI Builder form.
> Official entrances only: **OKX App → Menu → Builder** or **okx.com**.
> Do **not** submit from any mirror or "help" domain.
> This repository does not submit anything by itself. Submitting is a human action after the owner says go.

---

## 1. Project name

OKX Market Guard

## 2. Track / category

AI track — MCP integration with an AI product (agent tool server + CLI)

## 3. One-liner (≤ 140 chars)

Read-only OKX public market MCP server + CLI: ticker, candles, funding, open interest, stateless alerts. No keys, no orders, no account access.

## 4. The problem

AI agents (Claude, GPT-based copilots, in-house agents) are being asked to reason about crypto markets, but they usually get one of two bad options:

1. A full trading API with keys — over-privileged, easy to leak, easy for the model to do something irreversible.
2. Scraped web pages or stale CSVs — wrong, slow, and against OKX terms.

There is no small, auditable, **read-only** bridge that gives an agent exactly the public market facts it needs and nothing else.

## 5. The solution

**OKX Market Guard** is a Model Context Protocol server (and a matching CLI) that exposes five tools:

- `market_ticker` — last / bid / ask / 24h stats / change % / spread %
- `market_candles` — OHLCV, 1m to 3M, up to 300 bars
- `funding_rate` — perpetual funding (requires a `-SWAP` instrument)
- `oi_summary` — open interest by instrument or by product/currency
- `alert_check` — one-shot threshold (`gt/gte/lt/lte`) against the latest public data

The agent calls a tool; we call one public GET on `https://www.okx.com/api/v5/*` and return JSON. That is the whole loop.

## 6. How it uses OKX

- Official **OKX V5 public market REST** only: ticker, candles, funding-rate, open-interest, server time.
- No private endpoints. No WebSocket (yet). No login. No API key management.
- Instrument IDs follow OKX conventions (`BTC-USDT`, `BTC-USDT-SWAP`).
- OKX error codes are mapped to agent-friendly hints so the model can self-correct (wrong market type, rate limit, timeout).

## 7. Target users

- Agent / copilot developers who want live OKX market context without handing the model a trading key.
- Research and content workflows that need a reproducible snapshot (ticker, funding, OI) inside an LLM pipeline.
- Internal tools that must pass a "no withdrawal, no order, no key" security review.

## 8. Why it is different

| Usual integration | OKX Market Guard |
| --- | --- |
| Full API key in the agent's hands | **Zero credentials** — the process refuses key-like options |
| Model can trade if it "decides to" | **Cannot** — trade/account paths are not in the allowlist |
| Custom HTTP glue per agent | **Standard MCP** (stdio JSON-RPC 2.0, `2025-06-18`) |
| Silent rate-limit failures | Token bucket + friendly OKX error hints |
| "Alerts" that need a database and push channel | **Stateless** check; nothing stored, nothing pushed |

## 9. Safety and compliance (design, not marketing)

- Host lock: `https://www.okx.com` only. Mirrors are rejected in code.
- Path allowlist: 5 public market paths + time. Anything else throws `SafetyError` before a socket is opened.
- `redirect: 'error'` so a 302 cannot bounce us off-origin.
- MCP tool annotations: `readOnlyHint: true`, `destructiveHint: false`.
- Input validation (instId shape, bar enum, limit 1–300, extra-key reject).
- Rate limit: 8 req/s, burst 16 (inside OKX public ~20 req / 2 s / IP).
- Regression: node:test unit suite with mocked fetch, plus live smoke against real public endpoints.

## 10. Demo

- Repo-local demo transcript: `docs/demo-output.txt` (real REST responses for all five tools plus two rejection cases).
- CLI: `node src/cli.ts ticker BTC-USDT --pretty`
- MCP: any MCP client → `node src/cli.ts serve`

A 60-second walkthrough (for the form's "demo link" field, once a repo is published with the owner's approval):

1. MCP `initialize` → server name `okx-market-guard`, instructions say READ-ONLY.
2. `tools/list` → five tools, all `readOnlyHint`.
3. `tools/call market_ticker {instId:"BTC-USDT"}` → live last/bid/ask.
4. `tools/call alert_check {instId:"BTC-USDT", metric:"last", op:"gt", threshold:0}` → `triggered: true`.
5. Try `place_order` → unknown tool. Try `/api/v5/account/balance` → allowlist rejection.

## 11. Stack

- TypeScript (erasable syntax) on Node 22.6+ / 24, run directly (no build step).
- Zero runtime npm dependencies. `fetch` is Node's built-in.
- MCP implemented as newline-delimited JSON-RPC 2.0 over stdio (no SDK).
- Tests: `node:test`.

## 12. Roadmap (if we keep building)

1. **v0.2** — optional `instType` ticker sweep (`/api/v5/market/tickers`), history candles pagination helper.
2. **v0.3** — more public endpoints that stay read-only: instruments, mark-price, index-tickers, rubik-style aggregates if still public.
3. **v0.4** — optional local rate-limit config; structured logging.
4. **Not on the roadmap unless OKX and the owner both ask for it:** private endpoints, keys, orders, alerts-with-push. The product thesis is the opposite of that.

## 13. Team

Mavis — design and implementation of this MVP (MCP server, CLI, safety rails, tests, docs). Contact via the details on the official form.

## 14. What we are asking for

- Inclusion in the OKX AI Builder co-build program (AI track).
- Review of the read-only integration pattern; we want to stay aligned with OKX developer policy.
- If accepted: official docs link, and a nudge on which additional **public** endpoints OKX wants showcased.

We are **not** asking for trading permissions, market-maker flags, or key escrow.

## 15. Honest limitations

- Public REST only; no order-book depth beyond L1 ticker bid/ask in this MVP.
- `alert_check` is point-in-time; it does not watch. An agent can re-call it; we will not notify anyone.
- No i18n in tool output (English field names, OKX raw number strings).
- Demo and tests need outbound HTTPS to `www.okx.com` (or an HTTP proxy via `NODE_USE_ENV_PROXY`).

---

**Submission reminder.** Paste the above into the official form only. The owner of this repo has not approved a public git remote, a GitHub release, or an actual submission. `push` / new repo / 申报 = wait for a human yes.
