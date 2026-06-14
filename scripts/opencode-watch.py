#!/usr/bin/env python3
"""
opencode-lens watchdog: polls all lens instances for:
1. Permission/question prompts (real-time alert)
2. Tracked session completion (running → idle transition)

- stdout non-empty → delivered to user as notification via cron
- stdout empty → silent (nothing to report)
CRON-ONLY: no background process (avoids race condition on shared state file).
"""
import json, glob, os, sys, socket, http.client, fcntl, time

DEFAULT_RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
SOCK_DIR = os.environ.get("OPENCODE_LENS_SOCKET_DIR", os.path.join(DEFAULT_RUNTIME_DIR, "opencode-lens"))
STATE_FILE = os.path.expanduser(os.environ.get("OPENCODE_WATCH_STATE_FILE", "~/.hermes/opencode-watch-state.json"))
WATCH_FILE = os.path.expanduser(os.environ.get("OPENCODE_WATCH_LIST_FILE", "~/.hermes/opencode-watch-list.json"))
LOCK_FILE = os.path.expanduser(os.environ.get("OPENCODE_WATCH_LOCK_FILE", "~/.hermes/opencode-watch.lock"))


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path, timeout=5):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.socket_path)
        self.sock.settimeout(self.timeout)


def http_unix(sock_path, method, path):
    try:
        conn = UnixHTTPConnection(sock_path)
        conn.request(method, path)
        resp = conn.getresponse()
        data = resp.read().decode()
        conn.close()
        return json.loads(data)
    except Exception:
        return None


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False)


def get_last_assistant_summary(sock_path, session_id):
    """Try to fetch last assistant message text, truncated."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=1")
    if not data or not isinstance(data, list):
        return None
    for msg in reversed(data):
        if msg.get("role") == "assistant" and msg.get("text"):
            text = msg["text"].strip()
            if len(text) > 500:
                return text[:500] + "…"
            return text
    return None


def main():
    # File lock to prevent concurrent runs (cron overlap)
    lock_fd = os.open(LOCK_FILE, os.O_CREAT | os.O_WRONLY)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        # Another instance is running, skip
        os.close(lock_fd)
        return

    try:
        prev = load_json(STATE_FILE, {})
        watch = load_json(WATCH_FILE, {"entries": []})
        alerts = []
        curr = {}
        completed = []

        for sock in sorted(glob.glob(os.path.join(SOCK_DIR, "*.sock"))):
            pid = os.path.basename(sock).replace(".sock", "")
            status = http_unix(sock, "GET", "/tui/status")
            if not status:
                continue

            # --- Permission / Question alerts ---
            needs_user = status.get("needs_user", False)
            kind = status.get("needs_user_kind", "")
            perm_id = status.get("permission_id", "")
            session_obj = status.get("current_session", {})
            title = session_obj.get("title", "unknown")
            sid = session_obj.get("id", "")

            p = prev.get(pid, {})

            if needs_user and kind == "permission":
                if p.get("perm_id") != perm_id:
                    alerts.append(
                        f"⚠️ 实例(PID {pid})「{title}」请求权限确认\n"
                        f"   permission_id: {perm_id}\n"
                        f"   session: {sid}"
                    )
                curr.setdefault(pid, {})["perm_id"] = perm_id

            elif needs_user and kind == "question":
                q_obj = status.get("status", {}).get("question", {}) if isinstance(status.get("status"), dict) else {}
                req_id = q_obj.get("request_id", "")
                questions = q_obj.get("questions", [])
                if questions:
                    parts = []
                    for i, q in enumerate(questions):
                        label = q.get("question", q.get("header", f"Question {i+1}"))
                        opts = [o.get("label", "") for o in q.get("options", [])]
                        parts.append(f"   Q: {label}\n   选项: {', '.join(opts)}")
                    q_summary = "\n".join(parts)
                else:
                    q_summary = "   (详情未知，请检查 TUI)"
                if p.get("q_req_id") != req_id:
                    alerts.append(
                        f"❓ 实例(PID {pid})「{title}」有交互问题等待回答\n"
                        f"   request_id: {req_id}\n{q_summary}"
                    )
                curr.setdefault(pid, {})["q_req_id"] = req_id

            # --- Session completion tracking ---
            sessions_map = {}
            for s in status.get("sessions", []):
                sessions_map[s.get("id")] = {
                    "state": s.get("status", {}).get("state", "unknown"),
                    "title": s.get("title", s.get("id")),
                }

            prev_states = prev.get(pid, {}).get("session_states", {})
            curr_states = {}

            for sid_key, sinfo in sessions_map.items():
                state = sinfo["state"]
                curr_states[sid_key] = state
                prev_state = prev_states.get(sid_key)

                is_tracked = any(
                    e["session_id"] == sid_key and e.get("pid") == pid
                    for e in watch.get("entries", [])
                )
                if is_tracked and prev_state == "running" and state == "idle":
                    summary = get_last_assistant_summary(sock, sid_key)
                    completed.append({
                        "pid": pid,
                        "session_id": sid_key,
                        "title": sinfo["title"],
                        "summary": summary or "(无法获取结果摘要)",
                    })

            curr.setdefault(pid, {})["session_states"] = curr_states

        # Build completion alerts
        for c in completed:
            alerts.append(
                f"✅ 跟踪的 session 已完成\n"
                f"   实例: PID {c['pid']}\n"
                f"   session: {c['session_id']}\n"
                f"   标题: {c['title']}\n"
                f"   摘要: {c['summary']}"
            )

        # Remove completed sessions from watch list
        if completed:
            completed_ids = {(c["pid"], c["session_id"]) for c in completed}
            watch["entries"] = [
                e for e in watch.get("entries", [])
                if (e.get("pid"), e.get("session_id")) not in completed_ids
            ]
            save_json(WATCH_FILE, watch)

        save_json(STATE_FILE, curr)

        if alerts:
            print("\n".join(alerts), flush=True)

    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


if __name__ == "__main__":
    main()
