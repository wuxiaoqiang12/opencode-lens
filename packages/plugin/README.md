# opencode-lens

An [opencode](https://opencode.ai) plugin that lets you **observe and control your running opencode TUI sessions** from local automation (agents, scripts, MCP clients) over an HTTP API exposed on a per-instance Unix domain socket.

It can list sessions and their status, read messages/diffs/todos, send prompts (with per-message model selection), switch the visible TUI session, open the model selector, and respond to permission prompts — all without changing how you launch opencode.

## Install

```bash
npm install -g opencode-lens
```

Then register it as a TUI plugin in `~/.config/opencode/tui.json` and restart opencode:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-lens"]
}
```

> opencode's TUI plugin loader reads `tui.json`. Server plugins in `opencode.json` are a separate surface and will **not** load this plugin.

## How it works

On startup the plugin opens a Unix socket at `$XDG_RUNTIME_DIR/opencode-lens/<pid>.sock` and registers the instance so clients can discover it. The socket speaks plain HTTP — see the API contract in the [project repository](https://github.com/wuxiaoqiang12/opencode-lens).

## Notes

- In opencode 1.17.x the model is **per-message**. To run a prompt on a specific model, send it with `providerID` + `modelID`.
- A plugin cannot move the TUI's *visible* model indicator to a specific model by ID; use the interactive model selector for that.

## License

MIT
