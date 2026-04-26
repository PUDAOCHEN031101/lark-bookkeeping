[中文](README.zh-CN.md) | English

# lark-bookkeeping

> Natural-language bookkeeping inside Feishu chat (CN/EN)

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## What It Does

- Add entries from chat directly: `dinner 68 wechat`, `salary 8000 cmb`
- Common Chinese shortcut formats are parsed locally without waiting for AI: `晚餐，68，微信`, `余额宝转招行500`
- Query: `balance`, `recent 5`
- Period queries in Chinese: `今天花了多少`, `本周收支明细`, `本月花了多少`, then `展开明细`
- Delete: `delete last`, `delete recxxxx`
- Update: `update recxxxx amount=88 note=lunch category=food account=wechat`
- Supports three ingestion modes: bot auto-reply by default (no chat ID), 8s polling, or Feishu event Webhook callbacks
- Long/webhook mode includes reconnect, `--force` subscribe, per-chat watermarks, and periodic catch-up; with no chat ID it skips catch-up until a chat allowlist or observed chat exists

## Data Model (Two Tables)

| Table | Env var | Purpose |
|---|---|---|
| Ledger | `LARK_LEDGER_TABLE` | Every income/expense/transfer/debt row |
| Account | `LARK_ACCOUNT_TABLE` | Account balances and metadata (`--balance`) |

## Recommended Template (First-Time Setup)

For first-time users, start from the author's FIRE template and adapt field names as needed:

- Template Base: <https://ks2ynpxs58.feishu.cn/base/JSQybjj3jat40UsaEdvcpbJ1n6b>
- Keep at least two tables: `ledger` and `account`

## Quick Start

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
npm install -g @larksuite/cli@latest
npm run setup
npm start
```

`npm run setup` logs you into Feishu, asks for the copied Base URL, optionally asks for an LLM key, and writes `.env`. The default mode is bot auto-reply: add the bot to a chat or DM it directly; no chat ID lookup is required.

The core product path is: copy the Feishu Base template, run setup/doctor, then start the bot. Bill import, monthly diagnosis, Obsidian companion flows, and long-running deployment are advanced layers and are not required for the first successful run.

### Choose Your LLM Provider (Default SiliconFlow, Optional Others)

This project uses an OpenAI-compatible `/chat/completions` interface. The LLM key is used for free-form natural language; shortcut formats such as `晚餐，68，微信` and `余额宝转招行500` are parsed locally.

- Default (easiest): set `SILICONFLOW_API_KEY`
- OpenAI: set `OPENAI_BASE_URL=https://api.openai.com/v1` + `OPENAI_API_KEY`
- Any compatible gateway: set `BOOKKEEPING_LLM_CHAT_URL=.../chat/completions` + `LLM_API_KEY`

Priority (URL): `BOOKKEEPING_LLM_CHAT_URL` > `OPENAI_BASE_URL + /chat/completions` > SiliconFlow default  
Priority (key): `SILICONFLOW_API_KEY` > `OPENAI_API_KEY` > `LLM_API_KEY`

Then run:

```bash
npm start
```

## Windows Notes

- First update lark-cli: `npm install -g @larksuite/cli@latest`, then verify with `lark-cli --version`.
- `LARK_EVENT_MODE=long` is the default; the bot replies to the source chat and does not need `LARK_CHAT_ID`.
- Use `LARK_EVENT_MODE=poll` only as a compatibility/troubleshooting mode; poll mode requires `LARK_CHAT_ID`.
- If you see `spawn lark-cli ENOENT`, set `LARK_CLI_BIN` to the absolute `lark-cli.exe` path. Prefer `.exe` over `.cmd` to avoid shell JSON encoding issues.
- Record writes materialize JSON arguments as UTF-8-without-BOM temp files and pass them through latest lark-cli's `--json @file` / `--fields @file`, avoiding Windows shell transcoding.
- Reply identity is configurable with `LARK_REPLY_AS=auto|bot|user`; `auto` tries bot first and falls back to user.
- `.env` CRLF line endings are supported. For manual `lark-cli --json @file` usage, save JSON as UTF-8 without BOM; in PowerShell use `Set-Content -Encoding utf8NoBOM`.
- For long-running Windows installs, pin local state with `LARK_BOOKKEEPING_DATA_DIR=C:\lark-bookkeeping-data`.

Log redirection:

```powershell
New-Item -ItemType Directory logs -Force
node .\lark-bookkeeping-daemon.mjs 1>> .\logs\daemon.out.log 2>> .\logs\daemon.err.log
```

Scheduled task:

```powershell
schtasks /Create /TN LarkBookkeeping /SC ONLOGON /TR "powershell -NoProfile -ExecutionPolicy Bypass -Command ""Set-Location 'C:\path\lark-bookkeeping'; node .\lark-bookkeeping-daemon.mjs 1>> .\logs\daemon.out.log 2>> .\logs\daemon.err.log"""
```

## CLI Examples

```bash
node lark-record.mjs "dinner 68 wechat"
node lark-record.mjs "晚餐，68，微信"      # local fast parser, no LLM call
node lark-record.mjs "余额宝转招行500"    # local transfer parser
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set amount=88,note=lunch
```

## Admin Tools

Fix linked account fields in old ledger rows:

```bash
npm run admin:replace-account -- --ids recxxx,recyyy --field 账户 --to-name 零钱通 --dry-run
npm run admin:replace-account -- --from-name 微信零钱 --to-name 零钱通 --field 账户 --dry-run
```

## License

MIT
