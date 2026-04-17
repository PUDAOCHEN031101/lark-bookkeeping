# wow-harness × Cursor CLI / Agent

本目录与 `scripts/` 中的治理脚本来自 [NatureBlueee/wow-harness](https://github.com/NatureBlueee/wow-harness) 体系；**Cursor** 侧通过仓库根目录的：

- `.cursor/hooks.json` — 生命周期与上游 `.claude/settings.json` 对齐（事件名映射见 Cursor 文档 *Third Party Hooks*）
- `.cursor/cli.json` — 项目级 CLI 覆盖（与 `~/.cursor/cli-config.json` 合并）
- `scripts/cursor/wow_cursor_bridge.py` — 将 Claude Code 风格的 hook 输出（`decision` / `hookSpecificOutput` / stderr+exit 2）转换为 Cursor 要求的 stdout JSON
- `.wow-harness/state/` — Claude / Cursor 共用运行时真相源；旧 `.towow/` 仅作兼容镜像

## 本仓库现状

- **未安装**完整 wow-harness `scripts/hooks/` bundle（Claude 侧使用 **Entire** 自有 hooks）。
- 根目录 `.cursor/hooks.json` 为**空 hooks 占位**：若你启用了**全局** `~/.wow-agent-hooks` 分发器，可避免其在本目录下去调用**不存在**的 `scripts/cursor/wow_cursor_bridge.py`。若需完整 Cursor×harness，请从 [wow-harness](https://github.com/NatureBlueee/wow-harness) 对仓库执行 `phase2_auto` 安装 bundle。

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
