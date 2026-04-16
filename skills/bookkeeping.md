---
name: bookkeeping
description: "飞书自然语言记账。用户说记账、花了多少钱、收入、转账等时触发。调用 lark-record.mjs 写入飞书多维表格。"
tools:
  - Bash
  - Read
---

# 记账 Skill

将用户的自然语言记账请求通过 lark-record.mjs 写入飞书多维表格。

## 触发示例

- "帮我记一笔，晚饭68块微信支付"
- "刚收到工资8000，招行卡"
- "查一下余额"
- "借给小明500现金"

## 执行方式

```bash
node /path/to/lark-bookkeeping/lark-record.mjs "用户输入内容"
```

## 查余额

```bash
node /path/to/lark-bookkeeping/lark-record.mjs --balance
```

## 注意事项

- 脚本读取同目录 `.env` 文件中的配置
- 账户映射在 `config/accounts.json` 中维护
- 记账成功后会在飞书聊天中发送确认消息
