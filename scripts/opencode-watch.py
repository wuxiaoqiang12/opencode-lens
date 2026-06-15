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


def get_last_assistant_info(sock_path, session_id):
    """Fetch last assistant message text + completion time."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=1")
    if not data or not isinstance(data, list):
        return None, 0
    for msg in reversed(data):
        if msg.get("role") == "assistant":
            text = msg.get("text", "").strip()
            if len(text) > 300:
                text = text[:300] + "…\n   (回复较长，如需详情请问我)"
            t = msg.get("time", {})
            completed = t.get("completed", 0) or t.get("created", 0)
            return text or None, completed
    return None, 0


def get_pending_question_desc(sock_path, session_id):
    """Fetch pending question details from messages."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=2")
    if not data or not isinstance(data, list):
        return None, None
    for msg in reversed(data):
        if msg.get("role") != "assistant":
            continue
        for part in msg.get("parts", []):
            if part.get("type") == "tool" and part.get("tool") == "question":
                state = part.get("state", {})
                if state.get("status") == "pending" or state.get("status") == "running":
                    inp = state.get("input", {})
                    req_id = inp.get("id", inp.get("request_id", "")) if isinstance(inp, dict) else ""
                    questions = inp.get("questions", []) if isinstance(inp, dict) else []
                    if not questions:
                        # Try alternative structure
                        questions = inp if isinstance(inp, list) else []
                    parts_out = []
                    for i, q in enumerate(questions):
                        if not isinstance(q, dict):
                            continue
                        label = q.get("question", q.get("header", f"Question {i+1}"))
                        opts = [o.get("label", str(o)) if isinstance(o, dict) else str(o) for o in q.get("options", [])]
                        parts_out.append(f"   Q: {label}\n   选项: {', '.join(opts)}")
                    summary = "\n".join(parts_out) if parts_out else "   (无法解析问题详情)"
                    return req_id or "unknown", summary
    return None, None


def get_pending_permission_desc(sock_path, session_id):
    """Fetch description of the tool call awaiting permission."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=2")
    if not data or not isinstance(data, list):
        return None
    for msg in reversed(data):
        if msg.get("role") != "assistant":
            continue
        for part in msg.get("parts", []):
            if part.get("type") == "tool" and part.get("state", {}).get("status") == "pending":
                tool_name = part.get("tool", "未知工具")
                inp = part.get("state", {}).get("input", {})
                title = part.get("state", {}).get("title", "")
                desc = inp.get("description", "") if isinstance(inp, dict) else ""
                # Build a human-readable description
                if tool_name == "bash":
                    cmd = inp.get("command", "") if isinstance(inp, dict) else ""
                    if cmd:
                        cmd_short = cmd[:120] + "…" if len(cmd) > 120 else cmd
                        return f"执行命令: {cmd_short}"
                    return f"执行 bash 命令"
                if tool_name in ("write", "edit"):
                    fpath = inp.get("path", "") if isinstance(inp, dict) else ""
                    return f"{tool_name} 文件: {fpath}" if fpath else f"{tool_name} 文件"
                label = desc or title or tool_name
                return f"使用 {tool_name}: {label}" if label else f"使用 {tool_name}"
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
                    # Try to get what the permission is about
                    perm_desc = get_pending_permission_desc(sock, sid) if sid else None
                    desc_line = f"   操作: {perm_desc}\n" if perm_desc else ""
                    alerts.append(
                        f"⚠️「{title}」请求权限确认\n"
                        f"{desc_line}"
                        f"   选项: allow once / allow always / deny"
                    )
                curr.setdefault(pid, {})["perm_id"] = perm_id

            elif needs_user and kind == "question":
                # Try to get question details from tui_status first, then from messages
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
                    # Fallback: fetch from messages API
                    msg_req_id, msg_summary = get_pending_question_desc(sock, sid) if sid else (None, None)
                    if msg_req_id:
                        req_id = msg_req_id
                    q_summary = msg_summary or "   (无法获取问题详情)"
                if p.get("q_req_id") != req_id:
                    alerts.append(
                        f"❓「{title}」有交互问题等待回答\n{q_summary}"
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

                # Find watch entry for this session
                watch_entry = None
                for e in watch.get("entries", []):
                    if e["session_id"] == sid_key and e.get("pid") == pid:
                        watch_entry = e
                        break
                is_tracked = watch_entry is not None

                # Handle prev format (string for old, dict for new)
                prev_entry = prev_states.get(sid_key)
                if isinstance(prev_entry, dict):
                    prev_state = prev_entry.get("state")
                    prev_msg_ts = prev_entry.get("last_msg_completed", 0)
                else:
                    prev_state = prev_entry
                    prev_msg_ts = 0

                # For tracked sessions: check last assistant message completion time
                # This catches cases where running→idle happens between two cron polls
                last_msg_ts = 0
                summary_text = None
                if is_tracked:
                    summary_text, last_msg_ts = get_last_assistant_info(sock, sid_key)

                curr_states[sid_key] = (
                    {"state": state, "last_msg_completed": last_msg_ts}
                    if is_tracked
                    else state
                )

                added_at = watch_entry.get("added_at", 0) if watch_entry else 0

                # Completion detection:
                # Path 1: observed running → idle (standard)
                # Path 2: idle + last_msg_completed > added_at + new since last poll
                #         (missed running window — model finished between two polls)
                if is_tracked and state == "idle":
                    should_complete = False
                    if prev_state == "running":
                        should_complete = True
                    elif (
                        last_msg_ts > added_at
                        and last_msg_ts != prev_msg_ts
                    ):
                        should_complete = True

                    if should_complete:
                        # Reuse summary_text if already fetched, otherwise fetch now
                        if summary_text is None:
                            summary_text, _ = get_last_assistant_info(sock, sid_key)
                        completed.append({
                            "pid": pid,
                            "session_id": sid_key,
                            "title": sinfo["title"],
                            "summary": summary_text or "(无法获取结果摘要)",
                        })

            curr.setdefault(pid, {})["session_states"] = curr_states

        # Build completion alerts
        for c in completed:
            alerts.append(
                f"✅「{c['title']}」已完成\n"
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
