# wow-harness × Cursor CLI / Agent

本目录与 `scripts/` 中的治理脚本来自 [NatureBlueee/wow-harness](https://github.com/NatureBlueee/wow-harness) 体系；**Cursor** 侧通过仓库根目录的：

- `.cursor/hooks.json` — 生命周期与上游 `.claude/settings.json` 对齐（事件名映射见 Cursor 文档 *Third Party Hooks*）
- `.cursor/cli.json` — 项目级 CLI 覆盖（与 `~/.cursor/cli-config.json` 合并）
- `scripts/cursor/wow_cursor_bridge.py` — 将 Claude Code 风格的 hook 输出（`decision` / `hookSpecificOutput` / stderr+exit 2）转换为 Cursor 要求的 stdout JSON
- `.wow-harness/state/` — Claude / Cursor 共用运行时真相源；旧 `.towow/` 仅作兼容镜像

## 使用前提

- 工作区需为**受信任**（项目 hooks 才会执行）
- Python 3.9+（与上游一致）
- 需在 Cursor 设置中启用对第三方 / 项目 hooks 的加载（若版本要求）

## 与上游的差异摘要

| Claude Code | Cursor |
|-------------|--------|
| `Bash` 工具名 | `Shell` |
| PostToolUse 注入 / 阻断 | `additional_context`、`permission` 等 JSON 字段 |
| `Stop` 的 stderr + exit 2 | `stop` 的 `followup_message` JSON |

## 验证

在仓库根目录：

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' \
  | python3 scripts/cursor/wow_cursor_bridge.py pre-sanitize
```

应输出一行 JSON 且退出码为 0（未命中阻断时）。
