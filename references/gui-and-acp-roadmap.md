# GUI Support & ACP Roadmap

This note captures the current architecture direction for extending opencode-lens beyond the TUI plugin host and for positioning it alongside ACP.

## Current Position

opencode-lens is optimized for controlling a user's already-running opencode TUI instances through a TUI plugin plus MCP server.

The current bridge is intentionally instance-oriented:

- The opencode TUI loads the lens plugin.
- The plugin exposes a local Unix-socket HTTP API.
- The MCP server discovers those sockets and exposes tools to external agents.
- The agent can inspect status, send prompts, switch visible sessions, answer permissions, and bridge interactive questions.

This is different from a headless agent backend. The visible TUI remains the source of truth for what the user is running.

## GUI Support Direction

If opencode's GUI app exposes a plugin API with capabilities comparable to the TUI plugin API, opencode-lens should not fork into separate products. Instead, introduce a host adapter layer:

- `TuiHostAdapter` for the existing TUI plugin runtime.
- `GuiHostAdapter` for a future GUI plugin runtime.
- Shared session, prompt, permission, question, event, and model-selection contracts above the adapter.

The MCP tool surface should stay stable where capabilities overlap. Host-specific limitations should be represented as explicit capability flags rather than hidden behavior changes.

Suggested capability matrix:

| Capability | TUI Host | GUI Host |
|---|---|---|
| Discover current session | Supported | Depends on GUI API |
| Send prompt via API | Supported | Depends on GUI API |
| Switch visible session | Supported | Depends on GUI API |
| Bridge permissions | Supported | Depends on GUI API |
| Bridge questions | Supported | Depends on GUI API |
| Close overlay/dialog | Supported via `api.ui.dialog.clear()` | Depends on GUI API |
| Per-message model selection | Supported through prompt payload | Depends on OpenCode API |

## ACP Relationship

ACP and opencode-lens solve adjacent but different problems.

ACP is best suited when an external client wants to treat opencode as a headless agent backend with a standard agent communication protocol.

opencode-lens is best suited when an external agent wants to control and monitor the user's live opencode instances without replacing their TUI workflow.

They are complementary:

- Use ACP for headless, backend-style agent sessions.
- Use MCP + opencode-lens for controlling live user instances and bridging TUI interactions.

## Recommendation

Do not replace opencode-lens with ACP. Keep the MCP + plugin architecture for live-instance control, and consider ACP integration as a separate adapter or backend mode if there is a concrete workflow that needs headless agent sessions.

For GUI support, wait for concrete GUI plugin APIs before implementing. When those APIs exist, add a host adapter rather than duplicating the MCP server or changing the existing TUI contract.
