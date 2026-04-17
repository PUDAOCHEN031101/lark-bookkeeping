[中文](README.zh-CN.md) | English

# lark-bookkeeping

> Natural-language bookkeeping inside Feishu chat (CN/EN)

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## What It Does

- Add entries from chat directly: `dinner 68 wechat`, `salary 8000 cmb`
- Query: `balance`, `recent 5`
- Delete: `delete last`, `delete recxxxx`
- Update: `update recxxxx amount=88 note=lunch category=food account=wechat`
- Supports two ingestion modes: 8s polling by default, or Feishu event Webhook for near real-time callbacks

## Data Model (Two Tables)

| Table | Env var | Purpose |
|---|---|---|
| Ledger | `LARK_LEDGER_TABLE` | Every income/expense/transfer/debt row |
| Account | `LARK_ACCOUNT_TABLE` | Account balances and metadata (`--balance`) |

## Recommended Template (First-Time Setup)

For first-time users, start from the author's FIRE template and adapt field names as needed:

- Template Base: <https://ks2ynpxs58.feishu.cn/base/EyQJblriPa1R46sJYNrcI1gQndd?table=tblsHPal0ZohtEF3&view=vewor4lDIV>
- Keep at least two tables: `ledger` and `account`

## Quick Start

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
cp .env.example .env
```

### Choose Your LLM Provider (Default SiliconFlow, Optional Others)

This project uses an OpenAI-compatible `/chat/completions` interface:

- Default (easiest): set `SILICONFLOW_API_KEY`
- OpenAI: set `OPENAI_BASE_URL=https://api.openai.com/v1` + `OPENAI_API_KEY`
- Any compatible gateway: set `BOOKKEEPING_LLM_CHAT_URL=.../chat/completions` + `LLM_API_KEY`

Priority (URL): `BOOKKEEPING_LLM_CHAT_URL` > `OPENAI_BASE_URL + /chat/completions` > SiliconFlow default  
Priority (key): `SILICONFLOW_API_KEY` > `OPENAI_API_KEY` > `LLM_API_KEY`

Then run:

```bash
node lark-bookkeeping-daemon.mjs
```

## CLI Examples

```bash
node lark-record.mjs "dinner 68 wechat"
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set amount=88,note=lunch
```

## License

MIT
