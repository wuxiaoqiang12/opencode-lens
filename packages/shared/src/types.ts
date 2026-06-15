export const LENS_VERSION = "0.1.1";

export type LensTransport = "unix";

export type LensCapabilityStatus = "stable" | "experimental" | "degraded" | "unavailable";

export interface LensCapability {
  name: string;
  status: LensCapabilityStatus;
  reason?: string;
}

export interface LensHealth {
  lens_version: string;
  opencode_version: string;
  uptime_ms: number;
  directory: string;
  capabilities: LensCapability[];
}

export type SessionState = "idle" | "running" | "error" | "waiting-permission" | "waiting-input";

export type UserInterventionKind = "permission" | "question" | "error" | "assistant-done";

export interface SessionStatus {
  session_id: string;
  state: SessionState;
  updated_at: number;
  rebuilt?: boolean;
  error?: string;
  permission_id?: string;
}

export interface SessionSummary {
  id: string;
  title?: string;
  status: SessionStatus;
  last_active?: number;
  message_count?: number;
}

export interface PendingQuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestionItem {
  question: string;
  header?: string;
  options: PendingQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface PendingQuestion {
  request_id: string;
  questions: PendingQuestionItem[];
}

export interface TuiStatus {
  current_session?: SessionSummary;
  sessions: SessionSummary[];
  state: SessionState | "unknown";
  needs_user: boolean;
  needs_user_kind?: UserInterventionKind;
  permission_id?: string;
  question?: PendingQuestion;
  error?: string;
  updated_at: number;
  source: "tui-route" | "lens-events" | "unknown";
}

export interface RegisteredInstance {
  pid: number;
  socket: string;
  transport: LensTransport;
  directory: string;
  worktree: string;
  project_id: string;
  opencode_version: string;
  lens_version: string;
  started_at: number;
}

export interface InstanceRecord extends RegisteredInstance {
  id: string;
  registry_path: string;
}

export interface ActiveInstance extends InstanceRecord {
  health: LensHealth;
}
