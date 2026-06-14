import { describe, expect, test } from "bun:test";

import { SessionStateMachine } from "./state";

describe("SessionStateMachine", () => {
  test("transitions from message, idle, permission, and error events", () => {
    const state = new SessionStateMachine();

    state.handleEvent({
      type: "message.updated",
      properties: { info: { sessionID: "ses_1", role: "user" } },
    });
    expect(state.get("ses_1").state).toBe("running");

    state.handleEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
    expect(state.get("ses_1").state).toBe("idle");

    state.handleEvent({ type: "permission.asked", properties: { sessionID: "ses_1", requestID: "perm_1" } });
    expect(state.get("ses_1")).toMatchObject({ state: "waiting-permission", permission_id: "perm_1" });

    state.handleEvent({ type: "question.asked", properties: { sessionID: "ses_1" } });
    expect(state.get("ses_1").state).toBe("waiting-input");

    state.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_1" } });
    expect(state.get("ses_1").state).toBe("running");

    state.handleEvent({ type: "session.error", properties: { sessionID: "ses_1", error: "boom" } });
    expect(state.get("ses_1")).toMatchObject({ state: "error", error: "boom" });
  });

  test("returns rebuilt idle state for unknown sessions", () => {
    expect(new SessionStateMachine().get("ses_missing")).toMatchObject({
      session_id: "ses_missing",
      state: "idle",
      rebuilt: true,
    });
  });
});
