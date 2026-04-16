# lark-bookkeeping

> 在飞书聊天里自然语言记账（中文/English）  
> Natural-language bookkeeping inside Feishu chat (CN/EN)

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## 中文说明

### 1) 功能概览

- 群聊/单聊直接发消息记账：`晚餐68微信`、`工资8000招行`、`微信转招行1000`
- 查询：`查余额`、`查最近5笔`
- 删除：`删除上一笔`、`删除 recxxxx`
- 修改：`修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信`
- 守护进程 8 秒轮询，写入飞书多维表格并回执

### 2) 快速开始

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
cp .env.example .env
```

编辑 `.env`：

```env
LARK_APP_TOKEN=你的bitable_app_token
LARK_LEDGER_TABLE=收支明细表table_id
LARK_ACCOUNT_TABLE=账户表table_id
LARK_CHAT_ID=oc_你的chat_id
SILICONFLOW_API_KEY=sk-xxxx
```

配置账户映射 `config/accounts.json`（账户名 -> record_id）后，启动：

```bash
# 前台测试
node lark-bookkeeping-daemon.mjs

# systemd 用户服务（推荐）
cp lark-bookkeeping.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lark-bookkeeping
```

### 3) CLI 用法

```bash
node lark-record.mjs "晚餐68微信"
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set 金额=88,备注=午饭,分类=食
node lark-record.mjs --dry-run "晚餐68微信"
```

### 4) 架构

`Feishu chat -> lark-cli messages list -> SiliconFlow parse -> lark-cli record upsert/update/delete/list -> IM confirm`

---

## English Guide

### 1) What it does

- Add entries from chat directly: `dinner 68 wechat`, `salary 8000 cmb`
- Query: `balance`, `recent 5`
- Delete: `delete last`, `delete recxxxx`
- Update: `update recxxxx amount=88 note=lunch category=food account=wechat`
- A daemon polls every 8s, writes to Feishu Bitable, and sends confirmation

### 2) Quick start

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
cp .env.example .env
```

Set `.env` values:

```env
LARK_APP_TOKEN=your_bitable_app_token
LARK_LEDGER_TABLE=ledger_table_id
LARK_ACCOUNT_TABLE=account_table_id
LARK_CHAT_ID=oc_your_chat_id
SILICONFLOW_API_KEY=sk-xxxx
```

Then run:

```bash
node lark-bookkeeping-daemon.mjs
```

For auto start with systemd user service:

```bash
cp lark-bookkeeping.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lark-bookkeeping
```

### 3) CLI examples

```bash
node lark-record.mjs "dinner 68 wechat"
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set amount=88,note=lunch
```

---

## License

MIT
