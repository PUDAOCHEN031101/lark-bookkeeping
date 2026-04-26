[English](README.md) | 中文

# lark-bookkeeping

> 在飞书聊天里自然语言记账（中文/English）

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## 功能概览

- 群聊/单聊直接发消息记账：`晚餐68微信`、`工资8000招行`、`微信转招行1000`
- 常用快捷格式本地解析、无需等待 AI：`晚餐，68，微信`、`余额宝转招行500`
- 查询：`查余额`、`查最近5笔`
- 删除：`删除上一笔`、`删除 recxxxx`
- 修改：`修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信`
- 支持三种接入模式：默认机器人自动响应（无需群 ID）、8 秒轮询，或 Webhook 实时回调

## 数据模型：双表

| 表 | 环境变量 | 作用 |
|---|---|---|
| 收支明细 | `LARK_LEDGER_TABLE` | 每一笔收入/支出/转账/借贷记录（主表） |
| 账户 | `LARK_ACCOUNT_TABLE` | 各账户余额或账户元数据（`--balance` 读取） |

## 首次使用推荐模板

建议先复用作者长期在用的 FIRE 账本模板，再按需改字段：

- 模板入口：<https://ks2ynpxs58.feishu.cn/base/JSQybjj3jat40UsaEdvcpbJ1n6b>
- 最少保证两张表：`收支明细` + `账户`

## 快速开始

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
npm install -g @larksuite/cli@latest
npm run setup
npm start
```

`npm run setup` 会引导你登录飞书、粘贴多维表格 URL、可选填写 LLM Key，并生成 `.env`。默认使用机器人自动响应模式：把机器人拉进群或直接私聊机器人，不需要手动查群 ID。

### 选择你的 LLM 提供商（默认硅基，可自选）

本项目走 OpenAI-compatible `/chat/completions` 协议，用户可自行选择。LLM Key 用于 `晚餐68微信` 这类自由自然语言；`晚餐，68，微信` 和 `余额宝转招行500` 这类快捷格式可本地解析。

- 默认（最省事）：只填 `SILICONFLOW_API_KEY`
- OpenAI 官方：设置 `OPENAI_BASE_URL=https://api.openai.com/v1` + `OPENAI_API_KEY`
- 其他兼容网关：设置 `BOOKKEEPING_LLM_CHAT_URL=.../chat/completions` + `LLM_API_KEY`

优先级（地址）：`BOOKKEEPING_LLM_CHAT_URL` > `OPENAI_BASE_URL + /chat/completions` > 硅基默认地址  
优先级（密钥）：`SILICONFLOW_API_KEY` > `OPENAI_API_KEY` > `LLM_API_KEY`

启动：

```bash
npm start
```

## Windows 部署提示

- 先升级到最新版 lark-cli：`npm install -g @larksuite/cli@latest`，再用 `lark-cli --version` 确认。
- 默认 `LARK_EVENT_MODE=long`，机器人收到消息后回复原会话，不需要 `LARK_CHAT_ID`。
- 如果无法配置机器人事件订阅，可改用 `LARK_EVENT_MODE=poll`，此时才需要 `LARK_CHAT_ID`。
- 如果报 `spawn lark-cli ENOENT`，设置 `LARK_CLI_BIN` 为 `lark-cli.exe` 绝对路径，尽量不要指向 `.cmd`。
- 项目写入多维表时会自动把 JSON 参数落到 UTF-8 无 BOM 临时文件，并通过最新版 lark-cli 的 `--json @file` / `--fields @file` 读取，避免 Windows shell 转码。
- 回复身份可用 `LARK_REPLY_AS=auto|bot|user`，默认 `auto` 会先尝试 bot，失败后回退 user。
- `.env` 支持 CRLF；手写 `lark-cli --json @file` 时请使用 UTF-8 无 BOM，PowerShell 可用 `Set-Content -Encoding utf8NoBOM`。
- 长期运行可把状态目录固定到 `LARK_BOOKKEEPING_DATA_DIR=C:\lark-bookkeeping-data`。

日志落盘示例：

```powershell
New-Item -ItemType Directory logs -Force
node .\lark-bookkeeping-daemon.mjs 1>> .\logs\daemon.out.log 2>> .\logs\daemon.err.log
```

计划任务示例：

```powershell
schtasks /Create /TN LarkBookkeeping /SC ONLOGON /TR "powershell -NoProfile -ExecutionPolicy Bypass -Command ""Set-Location 'C:\path\lark-bookkeeping'; node .\lark-bookkeeping-daemon.mjs 1>> .\logs\daemon.out.log 2>> .\logs\daemon.err.log"""
```

## CLI 用法

```bash
node lark-record.mjs "晚餐68微信"
node lark-record.mjs "晚餐，68，微信"      # 本地快捷解析，不走 LLM
node lark-record.mjs "余额宝转招行500"    # 本地解析转账
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set 金额=88,备注=午饭,分类=食
```

## License

MIT
