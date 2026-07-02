"""
Harness Agent 持久化记忆 & 会话存储 — 极简版
═════════════════════════════════════════════════════════════

MemoryStore: 单文件 .cortex/memory.md
SessionStore: 每会话单文件 .cortex/sessions/{id}.jsonl

设计哲学:
  - 单文件 = 零碎片、零索引、零解析开销
  - JSONL = 追加写入、流式读取、无全量序列化
  - 人类可直接编辑 memory.md
"""

import os, re, json, datetime, secrets
from typing import List, Dict, Optional, Tuple


# ══════════════════════════════════════════════════════════════
# MemoryStore — 单文件 memory.md
# ══════════════════════════════════════════════════════════════

class MemoryStore:
    """单文件持久化记忆。每行一条 markdown 列表项。"""

    HEADER = "# Memory\n"

    def __init__(self, path: str):
        self.fpath = path
        self._ensure()

    def _ensure(self):
        os.makedirs(os.path.dirname(self.fpath), exist_ok=True)
        if not os.path.isfile(self.fpath):
            with open(self.fpath, "w", encoding="utf-8") as f:
                f.write(self.HEADER)

    def _read_lines(self) -> List[str]:
        """读取记忆行（跳过 # Memory 标题行）。"""
        if not os.path.isfile(self.fpath):
            return []
        with open(self.fpath, "r", encoding="utf-8") as f:
            return [line.rstrip("\n") for line in f if line.startswith("- ")]

    def append(self, fact: str) -> None:
        """追加一条记忆。fact 格式: \"[type] description\"。"""
        self._ensure()
        # 去重：已有同内容跳过
        existing = self._read_lines()
        line = f"- {fact.strip()}"
        if any(e.strip() == line.strip() for e in existing):
            return
        with open(self.fpath, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def remove(self, fact: str) -> bool:
        """删除包含 fact 子串的第一条记忆。"""
        existing = self._read_lines()
        new_lines = []
        removed = False
        for e in existing:
            if not removed and fact.strip() in e:
                removed = True
                continue
            new_lines.append(e)
        if removed:
            with open(self.fpath, "w", encoding="utf-8") as f:
                f.write(self.HEADER + "\n".join(new_lines) + "\n")
        return removed

    def list_all(self) -> List[str]:
        """列出所有记忆行。"""
        return self._read_lines()

    def to_system_context(self) -> str:
        """格式化为 system prompt 注入文本。"""
        lines = self._read_lines()
        if not lines:
            return ""
        return "[记忆事实]\n" + "\n".join(lines)


# ══════════════════════════════════════════════════════════════
# SessionStore — 每会话单 .jsonl 文件
# ══════════════════════════════════════════════════════════════

class SessionStore:
    """会话检查点。每会话一个 .jsonl 文件，追加写入。"""

    def __init__(self, path: str):
        self.dir = path
        self._last_path = os.path.join(self.dir, "last_session.txt")
        self._ensure()

    def _ensure(self):
        os.makedirs(self.dir, exist_ok=True)

    def _session_path(self, session_id: str) -> str:
        # 消毒：取 basename 防止路径穿越
        safe_id = os.path.basename(session_id)
        return os.path.join(self.dir, f"{safe_id}.jsonl")

    # ── Public API ──

    def save(self, session_id: str, ctx: List[Dict],
             metadata: dict = None) -> None:
        """全量写入会话 JSONL。"""
        self._ensure()
        fpath = self._session_path(session_id)
        with open(fpath, "w", encoding="utf-8") as f:
            # 首行：meta
            meta = dict(metadata or {})
            meta.setdefault("session_id", session_id)
            meta.setdefault("created_at", datetime.datetime.now().isoformat())
            meta["last_active"] = datetime.datetime.now().isoformat()
            f.write(json.dumps({"type": "meta", **meta}, ensure_ascii=False, default=str) + "\n")
            # 后续行：消息
            for msg in ctx[1:]:  # 跳过 system message
                try:
                    f.write(json.dumps({"type": "msg", **msg}, ensure_ascii=False, default=str) + "\n")
                except TypeError:
                    pass
        self.set_last_session(session_id)

    def load(self, session_id: str) -> Tuple[List[Dict], dict]:
        """加载会话 JSONL。返回 (ctx, metadata)。"""
        fpath = self._session_path(session_id)
        if not os.path.isfile(fpath):
            raise FileNotFoundError(f"会话不存在: {session_id}")
        ctx = []
        meta = {}
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "meta":
                    meta = {k: v for k, v in obj.items() if k != "type"}
                else:
                    del obj["type"]
                    ctx.append(obj)
        return ctx, meta

    def list_sessions(self) -> List[dict]:
        """列出所有会话元数据。"""
        self._ensure()
        result = []
        for fn in os.listdir(self.dir):
            if not fn.endswith(".jsonl"):
                continue
            fpath = os.path.join(self.dir, fn)
            meta = {"session_id": fn[:-6]}
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    first = f.readline().strip()
                    if first:
                        obj = json.loads(first)
                        if obj.get("type") == "meta":
                            meta = {k: v for k, v in obj.items() if k != "type"}
                        else:
                            meta = {"session_id": fn[:-6]}
            except Exception:
                pass
            result.append(meta)
        result.sort(key=lambda m: m.get("last_active", ""), reverse=True)
        return result

    def delete(self, session_id: str) -> bool:
        """删除会话 JSONL 文件。"""
        fpath = self._session_path(session_id)
        if not os.path.isfile(fpath):
            return False
        os.remove(fpath)
        last = self.get_last_session()
        if last == session_id:
            sessions = self.list_sessions()
            if sessions:
                self.set_last_session(sessions[0]["session_id"])
            else:
                os.remove(self._last_path) if os.path.isfile(self._last_path) else None
        return True

    def generate_id(self) -> str:
        """生成会话 ID: YYYYMMDD-HHMMSS-XXXX"""
        now = datetime.datetime.now()
        return f"{now.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"

    def get_last_session(self) -> Optional[str]:
        """读取上次活跃的 session_id。"""
        if not os.path.isfile(self._last_path):
            return None
        with open(self._last_path, "r", encoding="utf-8") as f:
            return f.read().strip() or None

    def set_last_session(self, session_id: str):
        self._ensure()
        with open(self._last_path, "w", encoding="utf-8") as f:
            f.write(session_id)

    def get_history_summary(self, session_id: str,
                            n_exchanges: int = 5) -> str:
        """从 JSONL 生成压缩中文摘要。"""
        fpath = self._session_path(session_id)
        if not os.path.isfile(fpath):
            return ""
        exchanges = []
        user_msg = None
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("type") != "msg":
                        continue
                    role = obj.get("role", "")
                    if role == "user":
                        user_msg = obj.get("content", "")[:80]
                    elif role == "assistant" and user_msg and obj.get("content"):
                        asst = obj["content"][:100].replace("\n", " ").strip()
                        if asst:
                            exchanges.append(f"- 用户: {user_msg[:60]}... → Agent: {asst}...")
                        user_msg = None
        except Exception:
            pass
        if not exchanges:
            return ""
        recent = exchanges[-n_exchanges:]
        return "此前对话摘要:\n" + "\n".join(recent)
