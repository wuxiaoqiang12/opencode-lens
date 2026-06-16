# opencode-lens Configuration

This document covers the runtime configuration points that usually matter when wiring opencode-lens into Hermes or another MCP client.

## TUI Plugin

Register the opencode TUI plugin in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-lens"]
}
```

Restart opencode after changing this file. Already-running TUI processes keep the old plugin code loaded.

## Hermes MCP

For npm installs, Hermes can run the MCP server through `npx`:

```yaml
mcp_servers:
  opencode-lens:
    command: npx
    args:
      - -y
      - --registry=https://registry.npmjs.org/
      - opencode-lens-mcp
    enabled: true
    timeout: 30
    connect_timeout: 30
```

If Hermes runs under systemd, prefer an explicit Node.js 20+ binary and a built MCP bundle. This avoids restricted service `PATH` values and avoids relying on `npx` cold starts:

```yaml
mcp_servers:
  opencode-lens:
    command: /home/you/.nvm/versions/node/v24.11.0/bin/node
    args:
      - /home/you/Research/opencode-lens/packages/mcp/dist/opencode-lens-mcp.js
    enabled: true
    timeout: 30
    connect_timeout: 30
```

Build the local MCP bundle before using the source-checkout form:

```bash
bun run --cwd packages/mcp build
```

Restart Hermes after changing the MCP config. MCP tools are discovered when the client starts.

## Doctor

Run the built MCP bundle with the `doctor` subcommand to check common setup issues:

```bash
node packages/mcp/dist/opencode-lens-mcp.js doctor
node packages/mcp/dist/opencode-lens-mcp.js doctor --json
```

The report checks the MCP version, Node.js version, `node`/`bun` on `PATH`, lens runtime directories, active instances, stale registry entries, opencode TUI plugin registration, and Hermes MCP config.

## Watchdog

`scripts/opencode-watch.py` is optional. It monitors running lens instances and relays pending permissions, interactive questions, completion summaries, and long-running status reminders.

Long-running reminder thresholds are configurable with environment variables:

```bash
OPENCODE_WATCH_RUNNING_NOTICE_AFTER_SEC=600
OPENCODE_WATCH_RUNNING_NOTICE_INTERVAL_SEC=900
```

Permission alerts include a coarse risk label:

- `低`: read-only operations such as reading files or searching.
- `中`: writes, edits, or ordinary command execution.
- `高`: destructive or externally visible operations such as `sudo`, `rm -rf`, `chmod`, `chown`, `git push`, or patch application.

Risk labels are hints only. The user still needs to choose an explicit permission response: `allow once`, `allow always`, or `deny`.
