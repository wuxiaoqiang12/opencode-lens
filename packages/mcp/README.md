# opencode-lens-mcp

MCP server for [opencode-lens](https://github.com/wuxiaoqiang12/opencode-lens). It discovers running opencode TUI instances that have the opencode-lens plugin loaded and exposes tools for local agents such as Hermes.

## Install

```bash
npm install -g opencode-lens-mcp
```

## Hermes Configuration

```yaml
mcp_servers:
  opencode-lens:
    command: opencode-lens-mcp
    enabled: true
    timeout: 30
    connect_timeout: 10
```

Restart Hermes after installing or updating the MCP server so the tool list is reloaded.

## Tools

- `instances_list`
- `tui_status`
- `session_create`
- `prompt_send`
- `messages_read`
- `diff_get`
- `todo_get`
- `tui_session_switch`
- `question_respond`
- `question_reject`
- `permission_respond`
- `model_selector_close`

## Notes

- This package talks to local Unix sockets created by the `opencode-lens` TUI plugin.
- It does not start opencode and does not open network listeners.
- The distributed `dist/opencode-lens-mcp.js` bundle is self-contained except for Bun/Node built-ins.

## License

MIT
