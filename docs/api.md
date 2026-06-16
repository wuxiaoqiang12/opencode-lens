# opencode-lens HTTP API

This document is the single source of truth for the plugin HTTP API consumed by the MCP server and skill.

## OpenAPI

```yaml
openapi: 3.1.0
info:
  title: opencode-lens HTTP API
  version: 0.1.2
servers:
  - url: http://x
    description: HTTP over Unix Domain Socket
paths:
  /health:
    get:
      summary: Health and capability declaration
      responses:
        '200':
          description: Lens metadata and capabilities
  /sessions:
    get:
      summary: List session summaries for this opencode instance
      parameters:
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100 }
      responses:
        '200': { description: Session summary array }
  /session/{session_id}:
    get:
      summary: Read a session detail object
      parameters:
        - $ref: '#/components/parameters/SessionID'
      responses:
        '200': { description: Session detail }
        '404': { description: Session not found }
  /session/{session_id}/status:
    get:
      summary: Read lens-maintained session state
      parameters:
        - $ref: '#/components/parameters/SessionID'
      responses:
        '200': { description: Session status }
  /tui/status:
    get:
      summary: Read live TUI-oriented status for the current/recent session
      responses:
        '200': { description: TUI status including current session, state, and whether user input is needed }
  /models:
    get:
      summary: Read slim provider IDs and model IDs visible to the opencode runtime
      responses:
        '200': { description: Provider IDs with model ID arrays, without provider keys, capabilities, costs, limits, headers, or config metadata }
  /session/{session_id}/model:
    post:
      summary: Best-effort session model switch via session ACP/config methods when exposed; opencode 1.17.x exposes no plugin setter, so this usually returns model_switch_unavailable. To run on a specific model, send /prompt with providerID+modelID instead.
      parameters:
        - $ref: '#/components/parameters/SessionID'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [providerID, modelID]
              properties:
                providerID: { type: string }
                modelID: { type: string }
                variant: { type: string }
      responses:
        '200': { description: Model switch accepted by an exposed ACP/config method }
        '501': { description: model_switch_unavailable; response may include selector_opened when the TUI model selector was opened as a fallback }
  /tui/models:
    post:
      summary: Open the visible TUI model selector for this opencode instance
      responses:
        '202': { description: Model selector opened }
        '503': { description: model_selector_unavailable }
  /tui/overlay/close:
    post:
      summary: Close the currently open TUI dialog/overlay, including a mistakenly opened model selector, when api.ui.dialog.clear is exposed
      responses:
        '202': { description: Overlay/dialog close requested }
        '503': { description: tui_overlay_close_unavailable }
  /session/{session_id}/messages:
    get:
      summary: Read recent messages with tool outputs summarized; falls back to opencode persisted SQLite storage when live state is empty or has no text/tool parts
      parameters:
        - $ref: '#/components/parameters/SessionID'
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100 }
      responses:
        '200': { description: Message summary array; each message includes parts and an optional top-level text field aggregated from text parts }
  /session/{session_id}/diff:
    get:
      summary: Read session diff
      parameters:
        - $ref: '#/components/parameters/SessionID'
        - name: messageID
          in: query
          schema: { type: string }
      responses:
        '200': { description: Diff payload from opencode SDK }
  /session/{session_id}/todo:
    get:
      summary: Read session todos
      parameters:
        - $ref: '#/components/parameters/SessionID'
      responses:
        '200': { description: Todo payload from opencode SDK }
  /session/{session_id}/prompt:
    post:
      summary: Queue a prompt for a session (non-blocking; prefers promptAsync, never awaits a streaming prompt to completion)
      parameters:
        - $ref: '#/components/parameters/SessionID'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text: { type: string, minLength: 1 }
                no_reply: { type: boolean }
                switch_tui: { type: boolean }
                force: { type: boolean, description: Bypass the busy check (which is reconciled against live TUI status) }
                providerID: { type: string, description: Run this message on a specific provider (must be paired with modelID) }
                modelID: { type: string, description: Run this message on a specific model (must be paired with providerID) }
                variant: { type: string, description: Optional reasoning effort/variant for the chosen model }
      responses:
        '202': { description: Prompt accepted/queued }
        '409': { description: Session is genuinely running or waiting for permission (confirmed via live status) }
  /session:
    post:
      summary: Create a new session (optionally with an initial model) via client.session.create
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
                agent: { type: string }
                parentID: { type: string }
                providerID: { type: string }
                modelID: { type: string }
                variant: { type: string }
                switch_tui: { type: boolean, description: When true, also make the new session the visible session in this instance's TUI }
      responses:
        '201': { description: Session created; returns ok, session_id, switched_tui, and the session object }
  /tui/prompt:
    post:
      summary: Append and submit text in the visible TUI prompt
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text: { type: string, minLength: 1 }
      responses:
        '202': { description: Prompt accepted }
  /tui/session:
    post:
      summary: Switch the visible TUI to a session without sending prompt text
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [session]
              properties:
                session: { type: string, minLength: 1 }
      responses:
        '202': { description: Session switch accepted }
        '503': { description: TUI route navigation is unavailable }
  /session/{session_id}/abort:
    post:
      summary: High-risk operation: abort a running session
      parameters:
        - $ref: '#/components/parameters/SessionID'
      responses:
        '200': { description: Abort requested }
  /session/{session_id}/permissions/{permission_id}:
    post:
      summary: High-risk operation: allow or deny a permission request
      parameters:
        - $ref: '#/components/parameters/SessionID'
        - name: permission_id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [response]
              properties:
                response: { enum: [allow, deny] }
      responses:
        '200': { description: Permission response submitted }
  /events:
    get:
      summary: Server-Sent Events stream
      parameters:
        - name: Last-Event-ID
          in: header
          schema: { type: integer, minimum: 1 }
      responses:
        '200':
          description: SSE stream with heartbeat comments every 15 seconds
components:
  parameters:
    SessionID:
      name: session_id
      in: path
      required: true
      schema: { type: string }
```

High-risk endpoints are intentionally thin lens calls. MCP tools and skills must require explicit user intent before calling abort or permission response operations.
