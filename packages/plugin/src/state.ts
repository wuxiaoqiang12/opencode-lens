import type { SessionState, SessionStatus } from "@opencode-lens/shared";

interface LensEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export class SessionStateMachine {
  private readonly statuses = new Map<string, SessionStatus>();
  private currentSessionID: string | undefined;

  handleEvent(event: LensEvent) {
    const sessionID = getSessionID(event.properties);
    if (!sessionID) return;
    this.currentSessionID = sessionID;

    if (event.type === "message.updated" && getMessageRole(event.properties) === "user") {
      return this.setState(sessionID, "running");
    }

    if (event.type === "session.status") {
      const status = getStatusType(event.properties);
      if (status === "idle") return this.setState(sessionID, "idle");
      if (status === "busy") return this.setState(sessionID, "running");
      return undefined;
    }

    if (event.type === "session.idle") {
      return this.setState(sessionID, "idle");
    }

    if (event.type === "permission.asked") {
      return this.setState(sessionID, "waiting-permission", { permission_id: getPermissionID(event.properties) });
    }

    if (event.type === "question.asked") {
      return this.setState(sessionID, "waiting-input");
    }

    if (event.type === "permission.replied") {
      return this.setState(sessionID, "running");
    }

    if (event.type === "session.error") {
      return this.setState(sessionID, "error", { error: getErrorMessage(event.properties) });
    }

    return undefined;
  }

  get(sessionID: string): SessionStatus {
    return (
      this.statuses.get(sessionID) ?? {
        session_id: sessionID,
        state: "idle",
        updated_at: Date.now(),
        rebuilt: true,
      }
    );
  }

  entries() {
    return Array.from(this.statuses.values());
  }

  current() {
    return this.currentSessionID;
  }

  markCurrent(sessionID: string) {
    this.currentSessionID = sessionID;
  }

  markRunning(sessionID: string) {
    this.currentSessionID = sessionID;
    return this.setState(sessionID, "running");
  }

  markIdle(sessionID: string) {
    this.currentSessionID = sessionID;
    return this.setState(sessionID, "idle");
  }

  private setState(sessionID: string, state: SessionState, extra: Partial<SessionStatus> = {}) {
    const status = {
      session_id: sessionID,
      state,
      updated_at: Date.now(),
      ...extra,
    };
    this.statuses.set(sessionID, status);
    return status;
  }
}

export function attachSessionStateEvents(
  api: unknown,
  state: SessionStateMachine,
  publish?: (type: string, data: unknown) => void,
) {
  const event = getEventApi(api);
  if (!event) return [];

  return [
    "message.updated",
    "tui.session.select",
    "session.status",
    "session.idle",
    "permission.asked",
    "question.asked",
    "permission.replied",
    "session.error",
  ].map((type) =>
    event.on(type, (lensEvent) => {
      publish?.(lensEvent.type, lensEvent.properties ?? {});
      const status = state.handleEvent(lensEvent);
      if (status) publish?.("session.state", status);
    }),
  );
}

function getEventApi(input: unknown): { on(type: string, handler: (event: LensEvent) => void): () => void } | undefined {
  if (typeof input !== "object" || input === null || !("event" in input)) return undefined;
  const event = input.event;
  if (typeof event !== "object" || event === null || !("on" in event) || typeof event.on !== "function") return undefined;
  return event as { on(type: string, handler: (event: LensEvent) => void): () => void };
}

function getSessionID(properties: Record<string, unknown> | undefined) {
  if (!properties) return undefined;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = getRecord(properties.info);
  if (typeof info?.sessionID === "string") return info.sessionID;
  const session = getRecord(properties.session);
  if (typeof session?.id === "string") return session.id;
  return undefined;
}

function getMessageRole(properties: Record<string, unknown> | undefined) {
  return getRecord(properties?.info)?.role;
}

function getStatusType(properties: Record<string, unknown> | undefined) {
  return getRecord(properties?.status)?.type;
}

function getPermissionID(properties: Record<string, unknown> | undefined) {
  if (!properties) return undefined;
  if (typeof properties.requestID === "string") return properties.requestID;
  if (typeof properties.permissionID === "string") return properties.permissionID;
  if (typeof properties.id === "string") return properties.id;
  return undefined;
}

function getErrorMessage(properties: Record<string, unknown> | undefined) {
  if (!properties) return undefined;
  if (typeof properties.error === "string") return properties.error;
  const error = getRecord(properties.error);
  if (typeof error?.message === "string") return error.message;
  return undefined;
}

function getRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}
