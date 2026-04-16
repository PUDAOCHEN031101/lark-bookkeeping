# lark-bookkeeping

> 用自然语言在飞书群聊里记账 — 发一条消息，8 秒自动写入飞书多维表格

[![lark-cli](https://img.shields.io/badge/powered%20by-lark--cli-blue)](https://github.com/larksuite/cli)
[![SiliconFlow](https://img.shields.io/badge/AI-SiliconFlow%20DeepSeek--V3-orange)](https://siliconflow.cn)
[![Node.js](https://img.shields.io/badge/runtime-Node.js%2018+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## 效果演示

在飞书群聊（或和机器人的单聊）发一条消息：

```
晚餐68微信
```

8 秒内收到回复：

```
✅ 已记账
类型: 支出  金额: ¥68  账户: 微信零钱  分类: 食
备注: 晚餐
```

同时，飞书多维表格（Bitable）中自动新增一条收支记录。

---

## 为什么做这个

传统记账软件的摩擦太大：打开 App → 选类型 → 填金额 → 选账户 → 选分类 → 保存，每次记一笔 5 步起步。

**这个项目让记账变成 1 步**：在你本来就在看的飞书聊天框里说一句话，AI 自动解析并写入多维表格。

---

## 架构

```
飞书群聊消息
    │
    ▼
lark-cli +chat-messages-list (轮询, 8s)
    │
    ▼
SiliconFlow API — DeepSeek-V3 (自然语言解析)
    │  解析出: 交易类型 / 金额 / 账户 / 分类 / 备注 / 日期
    ▼
lark-cli +record-upsert (写入飞书多维表格)
    │
    ▼
lark-cli +messages-send (发送确认消息)
```

---

## 功能

| 功能 | 说明 |
|------|------|
| 自然语言记账 | `晚餐68微信` / `工资8000招行` / `借给小明500` |
| 转账记录 | `微信转招行1000` |
| 查余额 | 发"查余额"返回所有账户余额 |
| 命令行直接记账 | `node lark-record.mjs "晚餐68微信"` |
| 账单批量导入 | 支持支付宝/微信 CSV 账单一键导入 |
| 开机自启 | systemd user service，24/7 后台运行 |
| Claude Code Skill | 作为 AI 助手工具调用 |

---

## 快速上手

### 前置条件

- [Node.js 18+](https://nodejs.org)
- [lark-cli](https://github.com/larksuite/cli) 已安装并完成 `lark-cli auth login`
- 飞书多维表格（收支明细表 + 账户表）已创建 → **[一键复制模板](https://ks2ynpxs58.feishu.cn/base/JSQybjj3jat40UsaEdvcpbJ1n6b)**
- [SiliconFlow](https://siliconflow.cn) API Key

### 1. 克隆仓库

```bash
git clone https://github.com/PUDAOCHEN031101/lark-bookkeeping.git
cd lark-bookkeeping
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入你自己的参数：

```env
# 飞书多维表格
LARK_APP_TOKEN=你的Bitable的app_token
LARK_LEDGER_TABLE=收支明细表的table_id
LARK_ACCOUNT_TABLE=账户表的table_id

# 飞书聊天 ID（守护进程监听的群/单聊）
LARK_CHAT_ID=oc_你的chat_id

# SiliconFlow API Key（https://siliconflow.cn）
SILICONFLOW_API_KEY=sk-your-key-here
```

### 3. 配置账户映射

编辑 `config/accounts.json`，将你的账户名映射到飞书账户表中的 record_id：

```json
{
  "微信零钱": "recXXXXXX",
  "招商金葵花": "recYYYYYY",
  "余额宝": "recZZZZZZ"
}
```

> **如何获取 record_id**：运行 `node lark-record.mjs --list-accounts` 自动列出

### 4. 命令行记账（立即可用）

```bash
# 记支出
node lark-record.mjs "晚餐68微信"

# 记收入
node lark-record.mjs "工资8000招行"

# 转账
node lark-record.mjs "微信转招行1000"

# 借出
node lark-record.mjs "借给小明500现金"

# 查余额
node lark-record.mjs --balance

# 月度汇总
node lark-record.mjs --monthly 2026-04

# 仅解析不写入（测试）
node lark-record.mjs --dry-run "晚餐68微信"
```

### 5. 启动飞书聊天守护进程

```bash
# 前台运行（测试）
node lark-bookkeeping-daemon.mjs

# 以 systemd 服务运行（推荐，开机自启）
cp lark-bookkeeping.service ~/.config/systemd/user/
# 编辑 service 文件中的路径和环境变量
systemctl --user daemon-reload
systemctl --user enable --now lark-bookkeeping
```

服务启动后，在飞书聊天框直接发消息即可记账。

---

## 账单批量导入

支持从支付宝/微信导出的 CSV 账单批量导入：

```bash
# 支付宝账单
node lark-bill-import.mjs --file ~/Downloads/alipay.csv --type alipay

# 微信账单
node lark-bill-import.mjs --file ~/Downloads/wechat.csv --type wxpay

# 仅导入指定月份
node lark-bill-import.mjs --file xxx.csv --type alipay --month 2026-04

# 预览（不写入）
node lark-bill-import.mjs --file xxx.csv --type alipay --dry-run
```

---

## Claude Code Skill 集成

将 `skills/bookkeeping.md` 放入 `.claude/agents/` 目录，即可在 Claude Code 中通过 `/bookkeeping` 触发记账。

---

## 飞书多维表格结构

**[一键复制模板](https://ks2ynpxs58.feishu.cn/base/JSQybjj3jat40UsaEdvcpbJ1n6b)** — 包含完整字段和公式，复制后填入账户数据即可使用。

### 收支明细表（`tblotHXtLkViKCtc`）

| 字段 | 类型 | 说明 |
|------|------|------|
| 日期 | 日期 | 交易日期 |
| 交易类型 | 单选 | 支出 / 收入 / 转账 / 负债 / 还款 |
| 金额 | 数字 | 元 |
| 支出分类 | 单选 | 衣/食/住/行/娱/学/持续黑洞/其他支出 |
| 收入分类 | 单选 | 工资/奖金补贴/报销返还/兼职劳务/投资利息/退款返现/他人转账/其他收入 |
| 账户 | 关联 | 关联到账户表（支出/收入） |
| 转出账户 | 关联 | 转账时用 |
| 转入账户 | 关联 | 转账时用 |
| 借贷方向 | 单选 | 借出 / 借入 |
| 借款人 | 单选 | 负债记录时填 |
| 备注 | 文本 | 消费描述 |
| 月份 | 公式 | 自动计算，用于月度筛选 |

### 账户表（`tblz82v6VseLDHuc`）

| 字段 | 类型 | 说明 |
|------|------|------|
| 账户名称 | 文本 | 账户显示名 |
| 账户类型 | 单选 | 银行卡/电子支付/现金/投资/其他 |
| 账户属性 | 单选 | 资产/负债 |
| 初始余额 | 数字 | 建账时余额 |
| 当前余额 | 公式 | 初始余额 + 收入合计 − 支出合计（自动计算） |
| 收入合计 | 查找引用 | 通过关联自动汇总 |
| 支出合计 | 查找引用 | 通过关联自动汇总 |
| 转入合计 | 查找引用 | 通过关联自动汇总 |
| 转出合计 | 查找引用 | 通过关联自动汇总 |
| 是否启用 | 复选框 | 不勾选则不参与记账 |

---

## 技术栈

- **[lark-cli](https://github.com/larksuite/cli)** — 飞书开放能力命令行工具（核心驱动）
- **SiliconFlow API** — DeepSeek-V3 自然语言解析
- **Node.js** — 运行时
- **systemd** — 守护进程管理

---

## 参与贡献

欢迎提 Issue 和 PR！特别欢迎：
- 新增支付平台的账单解析（京东、抖音等）
- 更多 AI 模型支持
- 账户自动同步功能

---

## License

MIT
