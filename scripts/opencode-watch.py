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
DIRECT_RELAY_LIMIT = 500
COMPLETION_SUMMARY_LIMIT = 500
DETAIL_LIMIT = 2000
RUNNING_NOTICE_AFTER_SEC = int(os.environ.get("OPENCODE_WATCH_RUNNING_NOTICE_AFTER_SEC", "600"))
RUNNING_NOTICE_INTERVAL_SEC = int(os.environ.get("OPENCODE_WATCH_RUNNING_NOTICE_INTERVAL_SEC", "900"))


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
            text = format_completion_text(text)
            t = msg.get("time", {})
            completed = t.get("completed", 0) or t.get("created", 0)
            return text or None, completed
    return None, 0


def format_completion_text(text):
    """Relay short completions verbatim; make long completions concise for chat notifications."""
    text = (text or "").strip()
    if len(text) <= DIRECT_RELAY_LIMIT:
        return text

    summary = summarize_long_text(text, COMPLETION_SUMMARY_LIMIT)
    return f"内容较长，自动摘取要点：\n{summary}\n   (回复较长，如需详情请问我)"


def summarize_long_text(text, limit):
    """Deterministic extractive summary for no-agent cron delivery."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    picked = []

    for line in lines:
        if is_summary_like_line(line):
            picked.append(line)
        if len(picked) >= 6:
            break

    if not picked:
        picked = split_sentences(text)[:5]

    if not picked:
        picked = [text]

    out = []
    used = 0
    for item in picked:
        item = item.strip()
        if not item:
            continue
        item = item[:limit]
        prefix = "- " if not item.startswith(("-", "*", "•")) else ""
        line = f"   {prefix}{item}"
        if used + len(line) + 1 > limit:
            remain = limit - used - 8
            if remain > 40:
                out.append(line[:remain] + "…")
            break
        out.append(line)
        used += len(line) + 1

    return "\n".join(out) if out else f"   {text[:limit]}…"


def is_summary_like_line(line):
    stripped = line.lstrip()
    if stripped.startswith(("- ", "* ", "• ", "1. ", "2. ", "3. ", "4. ", "5. ")):
        return True
    return any(marker in stripped[:16] for marker in ("结论", "原因", "建议", "风险", "问题", "完成", "修复", "结果"))


def split_sentences(text):
    sentences = []
    current = []
    for ch in text.replace("\r", ""):
        current.append(ch)
        if ch in "。！？!?\n":
            sentence = "".join(current).strip()
            if sentence:
                sentences.append(sentence)
            current = []
    tail = "".join(current).strip()
    if tail:
        sentences.append(tail)
    return sentences


def get_pending_question_desc(sock_path, session_id):
    """Fetch pending question details from messages."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=20")
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
                        label = clamp_detail(q.get("question", q.get("header", f"Question {i+1}")))
                        opts = [format_question_option(o) for o in q.get("options", [])]
                        parts_out.append(f"   Q: {label}\n   选项: {', '.join(opts)}")
                    summary = "\n".join(parts_out) if parts_out else "   (无法解析问题详情)"
                    return req_id or "unknown", summary
    return None, None


def get_pending_permission_desc(sock_path, session_id):
    """Fetch description of the tool call awaiting permission."""
    data = http_unix(sock_path, "GET", f"/session/{session_id}/messages?limit=20")
    if not data or not isinstance(data, list):
        return None
    for msg in reversed(data):
        if msg.get("role") != "assistant":
            continue
        for part in reversed(msg.get("parts", [])):
            desc = describe_permission_tool_part(part)
            if desc:
                return desc
    return None


def describe_permission_tool_part(part):
    if not isinstance(part, dict) or part.get("type") != "tool":
        return None

    state = part.get("state", {})
    if not isinstance(state, dict):
        state = {}

    # Different opencode versions report pending tool calls with either
    # status/type=running or status/type=pending while a permission dialog is open.
    state_kind = state.get("status") or state.get("type")
    if state_kind not in ("pending", "running", "waiting", "waiting-permission"):
        return None

    tool_name = part.get("tool") or part.get("name") or state.get("tool") or state.get("name") or "未知工具"
    inp = state.get("input") or part.get("input") or {}
    if not isinstance(inp, dict):
        inp = {}
    title = state.get("title") or part.get("title") or ""
    desc = inp.get("description") or state.get("description") or part.get("description") or ""

    if tool_name == "bash":
        cmd = inp.get("command") or state.get("command") or part.get("command") or ""
        if cmd:
            return f"执行命令: {clamp_detail(cmd)}"
        return "执行 bash 命令"

    if tool_name in ("write", "edit", "multi_edit"):
        fpath = inp.get("path") or inp.get("filePath") or state.get("path") or state.get("filePath") or ""
        action = {"write": "写入文件", "edit": "编辑文件", "multi_edit": "批量编辑文件"}.get(tool_name, "修改文件")
        return f"{action}: {clamp_detail(fpath)}" if fpath else action

    if tool_name in ("apply_patch", "patch"):
        patch_text = inp.get("patchText") or inp.get("patch") or state.get("patchText") or state.get("patch") or ""
        return f"应用补丁: {clamp_detail(patch_text, 500)}" if patch_text else "应用补丁"

    if tool_name == "read":
        fpath = inp.get("filePath") or inp.get("path") or state.get("filePath") or state.get("path") or ""
        return f"读取文件: {clamp_detail(fpath)}" if fpath else "读取文件"

    if tool_name == "grep":
        pattern = inp.get("pattern") or state.get("pattern") or ""
        path = inp.get("path") or state.get("path") or ""
        include = inp.get("include") or state.get("include") or ""
        target = ", ".join(str(item) for item in (path, include) if item)
        detail = f"搜索: {pattern}" if pattern else "搜索内容"
        return f"{detail}（{clamp_detail(target)}）" if target else detail

    if tool_name == "glob":
        pattern = inp.get("pattern") or state.get("pattern") or ""
        path = inp.get("path") or state.get("path") or ""
        if pattern and path:
            return f"查找文件: {clamp_detail(path)}/{clamp_detail(pattern)}"
        return f"查找文件: {clamp_detail(pattern or path)}" if pattern or path else "查找文件"

    label = desc or title or tool_name
    return f"使用 {tool_name}: {clamp_detail(label)}" if label else f"使用 {tool_name}"


def classify_permission_risk(operation):
    text = str(operation or "").lower()
    high_markers = (
        "rm -rf",
        "sudo",
        "chmod",
        "chown",
        "mkfs",
        "dd ",
        "git push",
        "delete",
        "删除",
        "应用补丁",
    )
    medium_markers = ("写入文件", "编辑文件", "批量编辑文件", "执行命令")
    low_markers = ("读取文件", "搜索", "查找文件")
    if any(marker in text for marker in high_markers):
        return "高"
    if any(marker in text for marker in medium_markers):
        return "中"
    if any(marker in text for marker in low_markers):
        return "低"
    return "中"


def format_question_option(option):
    if not isinstance(option, dict):
        return clamp_detail(str(option))
    label = str(option.get("label") or option)
    description = option.get("description")
    if description:
        return clamp_detail(f"{label}（{description}）")
    return clamp_detail(label)


def clamp_detail(value, limit=DETAIL_LIMIT):
    text = str(value or "").strip()
    return text if len(text) <= limit else text[:limit] + "…"


def format_duration(seconds):
    seconds = max(0, int(seconds))
    minutes = seconds // 60
    if minutes < 1:
        return f"{seconds} 秒"
    hours = minutes // 60
    if hours < 1:
        return f"{minutes} 分钟"
    remain = minutes % 60
    return f"{hours} 小时 {remain} 分钟" if remain else f"{hours} 小时"


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
        running_notices = []
        now_ts = int(time.time())

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
                    operation = perm_desc or "权限详情暂未从消息中解析到，请查看 opencode TUI 中的权限弹窗"
                    desc_line = f"   操作: {operation}\n"
                    risk_line = f"   风险: {classify_permission_risk(operation)}\n"
                    alerts.append(
                        f"⚠️「{title}」请求权限确认\n"
                        f"{desc_line}"
                        f"{risk_line}"
                        f"   选项: allow once / allow always / deny"
                    )
                curr.setdefault(pid, {})["perm_id"] = perm_id

            elif needs_user and kind == "question":
                # Try to get question details from tui_status first, then from messages
                q_obj = status.get("question", {}) if isinstance(status.get("question"), dict) else {}
                req_id = q_obj.get("request_id", "")
                questions = q_obj.get("questions", [])
                if questions:
                    parts = []
                    for i, q in enumerate(questions):
                        label = clamp_detail(q.get("question", q.get("header", f"Question {i+1}")))
                        opts = [format_question_option(o) for o in q.get("options", [])]
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
                    e_sid = e.get("session_id") or e.get("session")
                    e_pid = e.get("pid") or e.get("instance")
                    if e_sid == sid_key and e_pid == pid:
                        watch_entry = e
                        break
                is_tracked = watch_entry is not None

                # Handle prev format (string for old, dict for new)
                prev_entry = prev_states.get(sid_key)
                if isinstance(prev_entry, dict):
                    prev_state = prev_entry.get("state")
                    prev_msg_ts = prev_entry.get("last_msg_completed", 0)
                    prev_working_notice = prev_entry.get("last_working_notice", 0)
                else:
                    prev_state = prev_entry
                    prev_msg_ts = 0
                    prev_working_notice = 0

                # For tracked sessions: check last assistant message completion time
                # This catches cases where running→idle happens between two cron polls
                last_msg_ts = 0
                summary_text = None
                if is_tracked:
                    summary_text, last_msg_ts = get_last_assistant_info(sock, sid_key)

                added_at = watch_entry.get("added_at", 0) if watch_entry else 0
                last_working_notice = prev_working_notice

                if (
                    is_tracked
                    and state == "running"
                    and added_at
                    and now_ts - added_at >= RUNNING_NOTICE_AFTER_SEC
                    and now_ts - prev_working_notice >= RUNNING_NOTICE_INTERVAL_SEC
                ):
                    last_working_notice = now_ts
                    running_notices.append({
                        "title": sinfo["title"],
                        "duration": format_duration(now_ts - added_at),
                    })

                curr_states[sid_key] = (
                    {
                        "state": state,
                        "last_msg_completed": last_msg_ts,
                        "last_working_notice": last_working_notice,
                    }
                    if is_tracked
                    else state
                )

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
        for notice in running_notices:
            alerts.append(
                f"⏳「{notice['title']}」仍在执行\n"
                f"   已运行: {notice['duration']}"
            )

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
                if (e.get("pid") or e.get("instance"),
                    e.get("session_id") or e.get("session")) not in completed_ids
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
