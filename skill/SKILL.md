---
name: opencode-lens
description: Inspect/control live opencode instances via opencode-lens MCP. Use for "看看我的 opencode 都在干什么", "opencode 在忙什么", status tables only, monitoring, prompts, session switching, permissions, and per-message model selection. Do not output session statistics unless explicitly requested.
---

# opencode-lens

Use this skill when the user asks to inspect, continue, abort, or approve work running in local opencode instances, or when the user mentions "opencode" in any context that involves controlling or monitoring instances. ALWAYS load this skill via `skill_view` BEFORE calling any `mcp_opencode_lens_` tool — skipping the skill load and jumping to MCP tools directly is a known error that violates the user's workflow preference.

**Pitfall — never reverse-engineer the lens API via raw commands.** Do NOT use `curl --unix-socket`, `socat`, `nc`, or any other raw HTTP/shell tool to probe lens socket endpoints or discover available API routes. This was corrected explicitly by the user twice — ALL interaction with lens instances MUST go through the `mcp_opencode_lens_*` MCP tools. If you need to know what an endpoint returns, call the corresponding MCP tool. The watchdog script (`opencode-watch.py`) is the ONLY exception — it uses raw sockets internally, but you as the agent must never do so interactively. If the MCP tools are insufficient, tell the user; do not fall back to curl.

## MCP First

Hermes registers tools with the server prefix `mcp_opencode_lens_` when the config key is `opencode-lens`:

- `mcp_opencode_lens_instances_list` to discover active lens instances. It is compact by design and does not include historical `sessions` arrays.
- `mcp_opencode_lens_sessions_list` to list recent session summaries for one instance when the user explicitly asks for historical/session-list information.
- `mcp_opencode_lens_tui_status` to read live TUI-oriented status for one instance.
- `mcp_opencode_lens_messages_read` to read session messages.
- `mcp_opencode_lens_tui_session_switch` to switch the visible TUI session.
- `mcp_opencode_lens_session_create` to create a new session (optional `title`, `agent`, initial `providerID`+`modelID`+`variant`); returns `session_id`.
- `mcp_opencode_lens_prompt_send` to send prompts. Supports `providerID`+`modelID`+optional `variant` to run a prompt on a specific model (model is per-message in opencode 1.17.x), and `force: true` to override a busy check. Prompts are non-blocking: the tool returns `accepted` after queuing, not after the assistant finishes.
- `mcp_opencode_lens_models_list` to inspect provider/model IDs before sending a model-specific prompt.
- `mcp_opencode_lens_session_status`, `mcp_opencode_lens_diff_get`, and `mcp_opencode_lens_todo_get` to inspect state.
- `mcp_opencode_lens_events_wait` to wait for changes.

If the MCP tools are not present, stop and tell the user to reload or fix the Hermes MCP server configuration.

When configuring Hermes to run this MCP server via `npx`, include `--registry=https://registry.npmjs.org/`. Regional npm mirrors can lag behind fresh `opencode-lens-mcp` releases and cause false `not found` failures.

## Discovery

Use `mcp_opencode_lens_instances_list` first. It returns only compact instance metadata (PID/socket/directory/health), not historical session arrays. Internally keep the mapping from each instance's `pid`/`socket` to a stable display label (`实例 1`, `实例 2`, ...), and target instances by that mapping. When talking to the user, refer to instances by label only; do not surface the PID unless the user explicitly asks.

Only call `mcp_opencode_lens_sessions_list` when the user explicitly asks to list/browse historical sessions for a specific instance. Pass a small `limit` (default 20; lower if enough). Do not use it for normal status overview.

## Status Overview

When the user asks what opencode is doing (for example "看看我的 opencode 都在干什么", "看看 opencode 在忙什么", or similar), this is a status-overview request, not a statistics request. The response MUST be exactly the short table shape below plus at most one short sentence after it.

| 实例 | Session | 目录 | 状态 |
|---|---|---|---|
| 实例 1 | `<title or session id>` | `<directory from instances_list>` | `<状态>` |
| 实例 2 | `<title or session id>` | `<directory from instances_list>` | `<状态>` |

Rules:

- The `实例` column MUST contain only a generic label: `实例 1`, `实例 2`, `实例 3`, in order. NEVER put the PID, project, or socket in that column or anywhere in the table (no `实例 1（777208）`, no `777208（IB_Robot）`). The `目录` column MUST contain the `directory` field from `mcp_opencode_lens_instances_list`. PID is only allowed if the user explicitly asks for it.
- Always call `mcp_opencode_lens_instances_list` fresh, then `mcp_opencode_lens_tui_status` for each active instance.
- Show only `tui_status.current_session`. If `current_session` is missing, write `当前 session 未知`; never fill the table from historical session lists. `instances_list` no longer returns `sessions` by design.
- Do not output session statistics, topic buckets, historical session lists, or "recently active" summaries unless the user explicitly asks for statistics.
- Do not mention PID, uptime, socket, registry path, OpenCode version, historical session counts, or implementation details unless the user explicitly asks. Directory may appear only in the `目录` column.
- If you must disambiguate two instances, do it with the session title, not the PID. Reveal the PID only when the user explicitly asks (e.g. "哪个 PID", "显示进程号").
- Do not use bullets or paragraphs for per-instance descriptions.
- Status names: `思考/输出中`, `等待权限确认`, `等待用户输入`, `已输出完`, `等待模型回复/可能待处理`, `错误`, or `状态不确定`.
- If the user asks for statistics, require that request explicitly before listing counts, categories, or recency summaries.

## Session Completion Tracking

When you send a prompt via `prompt_send` (assigning work to a session) or the user explicitly asks to track a session, add it to the watch list so the watchdog notifies on completion.

**Watch list file:** `~/.hermes/opencode-watch-list.json` (JSON array of `{pid, session_id, title, socket, added_at}`).

After every `prompt_send`, append the target session to the watch list using `write_file` (read current → add entry → write back). Match the entry to the instance PID and session ID from the `prompt_send` call. The cron watchdog polls every 1 minute; when the session transitions from `running` → `idle`, it outputs a `✅` completion alert with a brief summary of the last assistant message, delivered directly to the user's chat.

When the user explicitly says "跟踪 session X" / "track session X", add it the same way.

When the user says "stop tracking" / "取消跟踪", remove the matching entry from the watch list file.

## Read State

Use `mcp_opencode_lens_session_status`, `mcp_opencode_lens_messages_read`, `mcp_opencode_lens_diff_get`, and `mcp_opencode_lens_todo_get`.

When relaying opencode messages to the user: if the message is ≤500 characters (Chinese chars count as 1 each), return it verbatim. If it exceeds 500 characters, **proactively summarize** it — extract key points, conclusions, and actionable items in concise Chinese, rather than dumping the full text. The user can always ask for full details if needed. This applies to both manual relay (you fetch via messages_read) and watchdog notifications.

## Send Prompts

Choose one of three modes based on whether the user wants the TUI view to change.

Background session API mode: use `mcp_opencode_lens_prompt_send` with `mode: "api"`.

Session API mode with visible TUI switch: use `mcp_opencode_lens_prompt_send` with `mode: "api"` and `switch_tui: true`.

Switch the visible TUI without sending prompt text: use `mcp_opencode_lens_tui_session_switch`.

Visible TUI prompt mode: use `mcp_opencode_lens_prompt_send` with `mode: "tui"`.

If the lens returns `409 session_busy`, there are two distinct causes:

1. **Genuinely running** — the model is still generating. `tui_status.state` is `running` with `needs_user: false`. Report it and ask whether to wait or abort.
2. **Waiting for a question answer** — OpenCode's `question` tool has asked the user an interactive multiple-choice question. `tui_status` shows `needs_user: true` with `needs_user_kind: "question"` and a `status.question` object (`request_id` + `questions[]`). Do NOT use `prompt_send`/`force` to answer it — typing free text does not select an option and leaves the TUI stuck. Use `mcp_opencode_lens_question_respond`. See "Bridging Interactive Questions" below.

Note: lens no longer gets stuck on a stale busy state — if live status says idle with no pending question, the prompt goes through automatically.

**HTTP 500 from `prompt_send` / `session_abort` — verify, don't retry:** The lens plugin's Bun.serve HTTP server has a hard 10-second `idleTimeout`. When the opencode SDK takes >10s to process a prompt or abort (common with large session histories or slow model round-trips), the HTTP response times out and MCP returns `McpError: lens returned HTTP 500`. **The operation usually succeeded anyway** — the prompt was accepted or the abort went through behind the timeout. Recovery: call `mcp_opencode_lens_session_status` immediately. If `state` is `running`, the prompt was accepted (proceed to poll for completion). If `idle`, an abort worked. **Do NOT blindly retry the same `prompt_send`** — that can enqueue a duplicate prompt. The same 500-then-verify pattern applies to `session_abort` and other mutating calls. This is the single most common false-failure when driving opencode via MCP.

**Create a new session:** use `mcp_opencode_lens_session_create` (optional `title`, and initial `providerID`+`modelID`+`variant`, plus `switch_tui`). It returns `session_id`; then target it with `mcp_opencode_lens_prompt_send`. Do not reuse an unrelated existing session when the user asks for a new one.

**Default to an independent session — never a subagent — unless the user explicitly asks for one.** When the user says "create a session" (or "新建/创建 session"), create a standalone top-level session: call `mcp_opencode_lens_session_create` **without** `parentID` and **without** `agent`. Passing `parentID` makes the new session a child of another session, and passing `agent` (e.g. `"general"`, `"explore"`) turns it into a subagent — both are the *wrong* default. Only pass `parentID`/`agent` when the user explicitly requests a subagent (e.g. "用 subagent 发送", "create a subagent/child session", "delegate to the explore agent"). If in doubt, omit both.

**Default to visibility when the user creates a session in a specific instance and sends a prompt.** If the user asks you to create a new session in a named instance (e.g. "in 实例 1 create a new session and send …"), they almost always want to *see* it there. In that case default to making it visible:
- Pass `switch_tui: true` to `mcp_opencode_lens_session_create`, OR
- Pass `switch_tui: true` to the `mcp_opencode_lens_prompt_send` call that targets the new session.

Only omit the switch when the user explicitly says to keep it in the background (e.g. "don't change my TUI", "background only"). API mode without `switch_tui` does NOT change the visible TUI, so the user will not see the new session appear — never report that a session is visible/created "在实例 X" unless you actually switched the TUI or the user asked for background mode.

**Per-message model:** in opencode 1.17.x the model is per-message. To run a prompt on a specific model, pass `providerID`+`modelID` (and optional `variant`) to `prompt_send` or set them at `session_create` time.

**prompt_send without model params uses the last-used model, not the creation model.** Empirically confirmed: a session created with `glm-5.1` had its first two prompts explicitly sent with `glm-5.2`; a third `prompt_send` call with NO model params also ran on `glm-5.2` (confirmed by the model self-reporting its ID). So omitting model params follows the most recently used model (or the TUI's current selection), not the session's initial model. If you need a specific model, always pass `providerID`+`modelID` explicitly — do not rely on inheritance from session creation.

**Prompts return immediately:** `prompt_send` queues the message (non-blocking) and returns `accepted`; it does not wait for the assistant to finish. Poll `mcp_opencode_lens_session_status` (watch `state` transition `running` → `idle`) to observe completion, then read the result with `messages_read`. Do not treat a fast `accepted` response as the model having already answered.

**`session_status` can lag behind actual completion:** After 2–3 `session_status` polls that still show `running`, do NOT keep polling indefinitely. Call `mcp_opencode_lens_messages_read` and check whether the latest assistant message already has a `time.completed` timestamp — if it does, the response is done regardless of what `session_status.state` says. This avoids wasting turns on a state cache that hasn't refreshed.

**`session` is required for prompt_send:** Even though the schema marks only `instance` and `text` as required, omitting `session` returns `"session is required"`. Always pass a valid session ID (create one with `session_create` if needed).

Never send `/session <id>` as prompt text. It is not an opencode slash command; use `mcp_opencode_lens_tui_session_switch` instead.

## Bridging Interactive Questions

When OpenCode uses its `question` tool to ask interactive multiple-choice questions, `mcp_opencode_lens_tui_status` reports `needs_user: true`, `needs_user_kind: "question"`, and a `status.question` object containing `request_id` and `questions[]` (each with `question`, `header`, `options[].label` + `.description`, and optional `multiple`/`custom`). The model has finished — it's waiting for a human answer.

To bridge these questions to the Hermes user:

1. Read the pending question from `tui_status` → `status.question` (preferred), or from the assistant message's `tool` part of type `question` via `messages_read`. Note the `request_id` and each question's exact option `label`s.
2. Present them to the user via the Hermes `clarify` tool (one `clarify` call per question if there are several). Use the option labels as `choices`.
3. Submit the user's choice with `mcp_opencode_lens_question_respond`, passing `request_id` and:
   - a single-choice answer: `answer: "<exact option label>"`
   - a multi-select answer: `answer: ["<label1>", "<label2>"]`
   - multiple questions at once: `answers: [["<q1 label>"], ["<q2 label>"]]` (one entry per question, in order)
   Use the exact option label text from the question. If the user wants to dismiss the question instead, use `mcp_opencode_lens_question_reject`.

IMPORTANT: `question_respond` is the ONLY correct way to answer these. `prompt_send` (even with `force: true`) just types text into the prompt box and does NOT select an option — the TUI will stay stuck on the question. This `clarify` → `question_respond` pattern fully mediates OpenCode's interactive questions through Hermes without the user touching the TUI.

**`question_respond` requires a Hermes restart after lens plugin update to take effect.** The MCP tool is registered when Hermes starts; if the lens plugin is updated while Hermes is running, `question_respond` (and possibly `permission_respond`) may not appear in the MCP tool list until the gateway restarts. After restart, the full `clarify` → `question_respond` bridge works correctly — confirmed: `answers: [["很好"], ["休息"]]` resolved a two-question prompt and the TUI transitioned from `waiting-input/question` to `idle/assistant-done`.

## High-Risk Operations

Only run abort or permission response commands when the user explicitly asks for that exact operation. Use `mcp_opencode_lens_session_abort` and `mcp_opencode_lens_permission_respond`.

**`permission_respond` accepts `allow`, `always`, or `deny`.** Under the hood the lens plugin translates these to the opencode SDK's `permission.reply` values: `allow` → `once` (approve this request), `always` → `always` (approve and remember for the session), `deny` → `reject`. This now correctly resolves the TUI permission prompt (the earlier bug — where the dialog stayed stuck on `waiting-permission` despite `ok: true` — was caused by sending the wrong values `allow`/`deny` straight to the SDK, which only understands `once`/`always`/`reject`). After approving/denying, the TUI should leave `waiting-permission`. `mcp_opencode_lens_question_reject` (dismissing an interactive question) is likewise high-risk — only use it when the user explicitly wants to decline the question.

**When bridging a permission prompt to the Hermes user, always present exactly three choices:** `allow once`, `allow always`, and `deny`. Explain the requested operation briefly, then ask the user to choose one of those three. Map `allow once` to `permission_respond` `response: "allow"`, `allow always` to `response: "always"`, and `deny` to `response: "deny"`. Do not collapse the question into a yes/no prompt, because users need to distinguish one-time approval from remembered approval.

**Triggering permission prompts for testing:** To exercise `permission_respond`, the target instance must have its opencode `permission` rules configured to `"ask"` (not `"allow"`) for the operation you're triggering. Auto-allow instances (common for test/scratch instances rooted at `~` or `/tmp`) never raise a permission dialog — the tool just runs and returns. Two things that are NOT opencode permission dialogs: (1) a bash command failing with OS-level "permission denied" (e.g. writing to `/opt` without sudo) is a normal tool error, not a permission prompt; (2) the `write`/`edit` tools writing outside the project directory may still be auto-allowed depending on config. Only `tui_status` showing `needs_user: true` with `needs_user_kind: "permission"` (or a `waiting-permission` state) indicates a real dialog you can respond to with `permission_respond`. If no instance has `"ask"` rules, tell the user — you cannot fabricate a permission prompt from an auto-allow config.

**Beware dangerous cleanup commands from opencode agents:** when you delegate a plugin-testing or instance-spawning task to an opencode agent via `prompt_send`, the agent may run broad process kills like `pkill -f "opencode"` to clean up temporary instances — this can destroy the user's running instances. If the task involves spawning/cleaning up test instances, include an explicit warning in the prompt: "Do NOT use pkill or killall on opencode processes; only kill specific PIDs you spawned." The agent's `bash` tool is not sandboxed.

## Events

`mcp_opencode_lens_events_wait` has a **hard 30-second timeout at the MCP transport layer** regardless of the `timeout_ms` argument you pass (a `timeout_ms: 60000` still times out at 30s). When it times out, **do not retry it with the same arguments** — that is a loop trap. Fall back to polling `mcp_opencode_lens_session_status` (state `running` → `idle`) instead, which returns instantly and is reliable. Reserve `events_wait` for short waits (≤25s) where you genuinely expect a near-term event.

## Proactive Monitoring (Watchdog)

When the user starts or switches a session that will run autonomously (e.g. a long PR review, a code change), they may ask you to "track it" or proactively notify them when a permission prompt or interactive question appears. This is a monitoring request — set up a background poller that watches all lens instances and delivers alerts to the user.

**CRON-ONLY approach (no background process):**

Create a `no_agent=True` cron job with `script="scripts/opencode-watch.py"` and `schedule="* * * * *"` (every minute), `deliver="origin"`. The script uses `fcntl.flock` to prevent overlapping runs. When it detects a permission prompt, question, or session completion, it prints an alert to stdout, which the cron mechanism delivers directly to the user's chat.

**Do NOT use a background process loop** — it competes with the cron job for the same state file and watch list, causing race conditions where the background process removes watch list entries but its output (via `watch_patterns`) can only notify the agent during active turns, not autonomously deliver to the user. The cron `no_agent=True` + `deliver="origin"` path is the only mechanism that can autonomously push notifications to the user.

**Dedup:** The script uses a state file (`~/.hermes/opencode-watch-state.json`) keyed by PID. The same `permission_id` or question `request_id` triggers only once until it clears.

**Completion detection has two paths** (as of 2026-06-15 fix): (1) the standard `running → idle` state transition observed across two cron polls; (2) a fallback that checks the last assistant message's `time.completed` timestamp against the watch list entry's `added_at` — if the message completed after tracking started and is newer than what was seen in the previous poll, the session is reported as complete. Path 2 catches the common case where the model finishes between two 1-minute cron polls (the running state is never observed). The state file stores `{state, last_msg_completed}` per tracked session (dict format); old string-format entries are handled with backward-compatible `isinstance` checks.

**How the script works:** It reads the lens HTTP API directly via unix sockets (`/tui/status` on each `*.sock` in `$XDG_RUNTIME_DIR/opencode-lens/`), checks `needs_user` + `needs_user_kind`, and detects `running` → `idle` transitions for tracked sessions. For permission alerts, it also fetches the pending tool call from `/session/<id>/messages?limit=2` to describe what operation needs approval (e.g. "执行命令: git push"). It prints alert lines starting with `⚠️` (permission), `❓` (question), or `✅` (completion). Empty stdout = silent.

**Alert format — human-readable, NO technical IDs:** The watchdog alert text is what the user sees directly. NEVER include `permission_id`, `session_id`, `request_id`, or PID in the alert output. The format must be:
- Permission: `⚠️「<session title>」请求权限确认\n   操作: <human-readable description>\n   选项: allow once / allow always / deny`
- Question: `❓「<session title>」有交互问题等待回答\n   Q: <question>\n   选项: A, B, C`
- Completion: `✅「<session title>」已完成\n   摘要: <brief summary>`
The script fetches the pending tool call's description from messages (e.g. "执行命令: git push origin main", "write 文件: /path/to/file") to populate the `操作` line.

**When you receive a watchdog alert:** Follow the permission bridging or question bridging sections above — read the details from `tui_status`, present choices to the user via `clarify`, and submit via `permission_respond` or `question_respond`. The user typically responds with a brief instruction like "allow always" or "给他 allow always" — map this to `permission_respond` with `response: "always"` and act immediately without further clarification.

## Future Architecture: GUI Support & ACP

For analysis of extending opencode-lens to support opencode's GUI app, and a comparison of MCP+TUI plugin vs ACP (Agent Communication Protocol), see `references/gui-and-acp-roadmap.md`. Key takeaway: ACP and MCP+TUI are complementary — ACP suits headless agent backend scenarios; MCP+TUI suits controlling user's running instances. The recommended evolution is a host adapter architecture with a capability matrix.

## Per-Message Model Selection

In opencode 1.17.x the model is chosen **per message**. Do not try to switch a session's model before sending work. When the user asks to use a specific model, send that prompt with `providerID`+`modelID` (and optional `variant`) on `mcp_opencode_lens_prompt_send`.

Steps when the user wants to run a prompt on a specific model:

1. Read `mcp_opencode_lens_tui_status` to identify the affected current session.
2. Always read `mcp_opencode_lens_models_list` before choosing a model. It returns only provider IDs and model IDs (slim — do not claim it is too large or grep temp files). Never invent or guess `providerID`, `modelID`, or `variant`.
3. Match the user's requested model against `models_list`; if missing or ambiguous, present the closest available models and ask one concise clarification question.
4. Send the prompt via `mcp_opencode_lens_prompt_send` with the matched `providerID`+`modelID` (add `switch_tui: true` if the user wants to see that session in the TUI). This runs just that message on the requested model.
5. Do not call any model switching or model selector tool as part of this workflow. The entire "switch to model X and run Y" request is a single `prompt_send` call with per-message model parameters.
