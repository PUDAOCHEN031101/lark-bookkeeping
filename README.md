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
- 支持两种接入模式：默认 8 秒轮询，或配置事件订阅后走 Webhook 实时回调

### 2) 数据模型：双表（与生产环境一致）

本仓库与本地「财富 / FIRE」方案一致，需要 **两张多维表**，不是「一个表搞定一切」：

| 表 | 环境变量 | 作用 |
|----|-----------|------|
| **收支明细** | `LARK_LEDGER_TABLE` | 每一笔收入/支出/转账/借贷记录（脚本写入的主表） |
| **账户** | `LARK_ACCOUNT_TABLE` | 各账户余额或账户元数据；`--balance` / `查余额` 读此表 |

`lark-cli base +record-upsert` 写入的是 **明细表**；账户表用于汇总展示与对账（字段名需与你的表结构一致，如「账户名称」「当前余额」等）。

### 3) 飞书视图与仪表盘（建议多投入）

脚本只负责 **落库一行记录**；**怎么看钱**完全在飞书侧用视图解决，建议优先做：

- **按月份 / 账户 / 分类分组**的表格视图 + 分组汇总（或透视表视图）。
- **看板视图**：按「支出分类」或「交易类型」列拖拽，扫一眼大额与结构。
- **仪表盘**：对「金额」做求和、按「交易类型」切片；可与官方「个人记账」模板思路对照：[飞书个人记账模板](https://www.feishu.cn/template/personal-accounting)。
- **自动化**：表内数据变更 → 群通知 / 每日摘要（飞书自动化或自建 Cron + 机器人）。

开源仓库不强制内置视图 JSON；你在飞书 UI 里搭好视图后，同一 `app_token` 下所有客户端（聊天记账、CLI）写入的数据会立刻反映在视图里。

### 4) 快速开始

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

### 5) CLI 用法

```bash
node lark-record.mjs "晚餐68微信"
node lark-record.mjs --balance
node lark-record.mjs --monthly 2026-04
node lark-record.mjs --list 5
node lark-record.mjs --delete recxxxxxxxx
node lark-record.mjs --update recxxxxxxxx --set 金额=88,备注=午饭,分类=食
node lark-record.mjs --dry-run "晚餐68微信"
```

### 6) Webhook 模式

默认实现仍可直接跑轮询模式；如果你想把聊天响应从 `0~8s + AI 延迟` 降到接近实时，推荐打开飞书事件订阅。

1. 在 `.env` 中增加：

```env
LARK_WEBHOOK_PORT=9326
LARK_WEBHOOK_HOST=0.0.0.0
LARK_VERIFICATION_TOKEN=your-feishu-verification-token
```

2. 启动服务后，给飞书开放平台配置事件订阅地址：

```text
https://your-public-domain/
```

3. 在飞书后台订阅事件 `im.message.receive_v1`。

4. 验证成功后，脚本会自动切到 Webhook 模式；如果没有配置 `LARK_WEBHOOK_PORT`，则回退为轮询模式。

### 7) 架构

轮询模式：

`Feishu chat -> lark-cli messages list -> SiliconFlow parse -> lark-cli record upsert/update/delete/list -> IM confirm`

Webhook 模式：

`Feishu event callback -> local HTTP webhook -> SiliconFlow parse -> lark-cli record upsert/update/delete/list -> IM confirm`

---

## English Guide

### 1) What it does

- Add entries from chat directly: `dinner 68 wechat`, `salary 8000 cmb`
- Query: `balance`, `recent 5`
- Delete: `delete last`, `delete recxxxx`
- Update: `update recxxxx amount=88 note=lunch category=food account=wechat`
- Supports two ingestion modes: 8s polling by default, or Feishu event Webhook for near real-time callbacks

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
