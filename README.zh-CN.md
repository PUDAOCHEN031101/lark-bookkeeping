[English](README.md) | 中文

# lark-bookkeeping

> 在飞书聊天里自然语言记账（中文/English）

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## 功能概览

- 群聊/单聊直接发消息记账：`晚餐68微信`、`工资8000招行`、`微信转招行1000`
- 查询：`查余额`、`查最近5笔`
- 删除：`删除上一笔`、`删除 recxxxx`
- 修改：`修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信`
- 支持两种接入模式：默认 8 秒轮询，或配置事件订阅后走 Webhook 实时回调

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
cp .env.example .env
```

### 选择你的 LLM 提供商（默认硅基，可自选）

本项目走 OpenAI-compatible `/chat/completions` 协议，用户可自行选择：

- 默认（最省事）：只填 `SILICONFLOW_API_KEY`
- OpenAI 官方：设置 `OPENAI_BASE_URL=https://api.openai.com/v1` + `OPENAI_API_KEY`
- 其他兼容网关：设置 `BOOKKEEPING_LLM_CHAT_URL=.../chat/completions` + `LLM_API_KEY`

优先级（地址）：`BOOKKEEPING_LLM_CHAT_URL` > `OPENAI_BASE_URL + /chat/completions` > 硅基默认地址  
优先级（密钥）：`SILICONFLOW_API_KEY` > `OPENAI_API_KEY` > `LLM_API_KEY`

启动：

```bash
node lark-bookkeeping-daemon.mjs
```

## CLI 用法

```bash
node lark-record.mjs "晚餐68微信"
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set 金额=88,备注=午饭,分类=食
```

## License

MIT
