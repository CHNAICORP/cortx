"""
Cortex Agent 终端显示器 — Harness Agent Think → Guard → Act → Reflect 差异化输出

设计哲学：
  Think 阶段 — 深灰流式（可见、差异化），长思考自动折叠为一行摘要
  Act 阶段  — 青色工具标签 + 参数摘要 + 灰色结果
  Answer    — 亮色输出，与思考阶段有清晰视觉分隔
  多轮对话  — 每轮之间有分隔线 + 步骤编号
"""

import sys
from typing import List


class Terminal:
    """终端流式显示：thinking deep-grey, answer bright, long-thinking fold, code typewriter"""

    DEEP  = "\033[38;5;239m"
    CYAN  = "\033[38;5;51m"
    GREEN = "\033[38;5;82m"
    YELLOW= "\033[38;5;220m"
    RED   = "\033[38;5;196m"
    GRAY  = "\033[38;5;240m"
    DIM   = "\033[38;5;245m"
    BOLD  = "\033[1m"
    RESET = "\033[0m"

    # 折叠阈值：超过任一阈值即视为长思考
    FOLD_CHAR_THRESHOLD = 200
    FOLD_LINE_THRESHOLD = 3
    FOLD_PREVIEW_LEN    = 80

    # ── 代码写入流式显示配置 ──
    CODE_SMALL_LINE_DELAY = 0.005   # 小文件 (≤50行): 每行 5ms
    CODE_SMALL_THRESHOLD  = 50
    CODE_MEDIUM_LINE_DELAY = 0.002  # 中文件 (≤200行): 每行 2ms
    CODE_MEDIUM_THRESHOLD  = 200
    CODE_LARGE_LINE_DELAY  = 0.001  # 大文件 (>200行): 每行 1ms
    CODE_LARGE_HEAD_LINES  = 30
    CODE_LARGE_TAIL_LINES  = 10
    CODE_MIN_LENGTH        = 30     # 极短内容不流式

    # 代码颜色映射
    _CODE_COLORS = {
        "ts": "\033[38;5;75m", "tsx": "\033[38;5;75m",
        "js": "\033[38;5;221m", "jsx": "\033[38;5;221m",
        "py": "\033[38;5;114m",
        "html": "\033[38;5;209m", "css": "\033[38;5;141m",
        "json": "\033[38;5;215m", "md": "\033[38;5;250m",
        "yml": "\033[38;5;215m", "yaml": "\033[38;5;215m",
        "sql": "\033[38;5;117m", "sh": "\033[38;5;114m",
        "go": "\033[38;5;81m", "rs": "\033[38;5;173m",
        "vue": "\033[38;5;114m",
    }

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._buf: List[str] = []          # reasoning token buffer
        self._shown_reasoning = False       # reasoning was ever emitted this round
        self._showing_answer = False        # first answer token emitted this round
        self._round = 0                     # current round (increment per _loop)
        self._step = 0                      # current step within round (increment per _think)
        self._code_stream_enabled = True    # 代码写入打字机效果开关

    def _w(self, s: str):
        if self.enabled:
            sys.stdout.write(s)
            sys.stdout.flush()

    # ── Think phase ──

    def think_token(self, token: str):
        """Stream reasoning in deep grey — visible, differentiated."""
        if not self.enabled:
            return
        if not self._shown_reasoning:
            self._shown_reasoning = True
            self._w(f"\n{self.DEEP}")
        self._buf.append(token)
        self._w(token)

    # ── Transition helpers ──

    def _end_reasoning(self) -> str:
        """Close deep-grey colour. Returns full buffered reasoning text.
        Idempotent — safe to call multiple times."""
        if not self._shown_reasoning:
            return ""
        self._shown_reasoning = False
        self._w(self.RESET)
        return "".join(self._buf)

    def _is_short(self, text: str) -> bool:
        """Short reasoning → smooth transition; long → fold summary."""
        lines = text.count("\n") + 1
        return len(text) <= self.FOLD_CHAR_THRESHOLD and lines < self.FOLD_LINE_THRESHOLD

    def close_thinking(self):
        """Tool transition — close reasoning colour before tool labels appear."""
        reasoning = self._end_reasoning()
        if reasoning:
            # Long reasoning → fold to one-line summary before tools
            if not self._is_short(reasoning):
                flat = reasoning.replace("\n", " ").strip()
                preview = flat[:self.FOLD_PREVIEW_LEN]
                if len(flat) > self.FOLD_PREVIEW_LEN:
                    preview = preview[:self.FOLD_PREVIEW_LEN - 3] + "..."
                self._w(f"\n  {self.DIM}💭 {preview}{self.RESET}\n")
            else:
                self._w(self.RESET)
            self._w("\n")
            self._buf.clear()

    # ── Answer phase ──

    def answer_token(self, token: str):
        """Stream answer in default bright. First call transitions from thinking:
        - Short thinking: smooth colour reset + newline
        - Long thinking: collapsed one-line dim summary then newline"""
        if not self.enabled:
            return
        if not self._showing_answer:
            reasoning = self._end_reasoning()
            if reasoning and not self._is_short(reasoning):
                # Long reasoning → fold to one-line summary
                flat = reasoning.replace("\n", " ").strip()
                preview = flat[:self.FOLD_PREVIEW_LEN]
                if len(flat) > self.FOLD_PREVIEW_LEN:
                    preview = preview[:self.FOLD_PREVIEW_LEN - 3] + "..."
                self._w(f"\n  {self.DIM}💭 {preview}{self.RESET}\n\n")
            else:
                # Short or no reasoning → smooth transition
                self._w("\n")
            self._buf.clear()
            self._showing_answer = True
        self._w(token)

    # ── Round lifecycle ──

    def next_round(self):
        """Reset per-round state — called at start of each _loop iteration."""
        self._round += 1
        self._step = 0
        self._buf.clear()
        self._shown_reasoning = False
        self._showing_answer = False
        # Multi-round separator (skip first round)
        if self._round > 1:
            self._w(f"\n  {self.GRAY}{'─'*44}{self.RESET}\n")

    # ── Act phase (tools) ──

    def tool_start(self, name: str, args: dict):
        self._step += 1
        # Show step number + tool name + key params
        args_str = _fmt_args(args)
        if args_str:
            self._w(f"\n  {self.GRAY}[{self._step}]{self.RESET} {self.CYAN}▸ {name}{self.RESET} {self.DIM}({args_str}){self.RESET}")
        else:
            self._w(f"\n  {self.GRAY}[{self._step}]{self.RESET} {self.CYAN}▸ {name}{self.RESET}")

    def tool_inline(self, name: str, args: dict):
        pass

    def tool_done(self, success: bool, latency_ms: float, preview: str):
        icon = f"{self.GREEN}✓{self.RESET}" if success else f"{self.RED}✗{self.RESET}"
        short = preview.replace("\n", " ").strip()[:80]
        if short:
            self._w(f" {icon} {self.GRAY}[{latency_ms:.0f}ms]{self.RESET} {self.DIM}{short}{self.RESET}\n")
        else:
            self._w(f" {icon} {self.GRAY}[{latency_ms:.0f}ms]{self.RESET}\n")

    def tool_heartbeat(self, elapsed_seconds: int):
        """显示工具执行心跳（每 5 秒更新一次）"""
        self._w(f"  {self.GRAY}⏳ {elapsed_seconds}s...{self.RESET}\n")

    def tool_interrupted(self):
        """显示工具被用户中断"""
        self._w(f"  {self.YELLOW}⚠ 用户中断 (Ctrl+C){self.RESET}\n")

    # ── Banner ──

    # 权限模式元数据
    _MODE_META = {
        "standard": {"color": "\033[38;5;82m", "icon": "🛡", "label": "Standard", "desc": "安全模式"},
        "auto":     {"color": "\033[38;5;220m", "icon": "✎", "label": "Auto",     "desc": "自动模式"},
        "yolo":     {"color": "\033[38;5;196m", "icon": "⚠", "label": "YOLO",    "desc": "无限制"},
    }

    def banner(self, model: str, tools: int, work_dir: str, session_id: str = "", mode: str = "standard", context_limit: int = 0, is_resume: bool = False):
        meta = self._MODE_META.get(mode, {"color": self.GRAY, "icon": "?", "label": mode, "desc": ""})
        mc = meta["color"]
        mi = meta["icon"]
        ml = meta["label"]
        md = meta["desc"]
        # 格式化上下文容量
        ctx_str = ""
        if context_limit > 0:
            if context_limit >= 1_000_000:
                ctx_str = f"{context_limit // 1_000_000}M ctx"
            else:
                ctx_str = f"{context_limit // 1000}K ctx"
        # 顶边
        self._w(f"\n{self.CYAN}╔{'═'*52}╗{self.RESET}\n")
        # 模型行
        model_line = f"  {self.BOLD}Cortex Agent{self.RESET}  {self.GREEN}{model}{self.RESET}"
        if ctx_str:
            model_line += f"  {self.GRAY}{ctx_str}{self.RESET}"
        model_line += f"  {self.GRAY}{tools} tools  🐍{self.RESET}"
        self._w(model_line + "\n")
        # 权限行
        perm_line = f"  {mc}{mi} {ml}{self.RESET}  {self.DIM}{md}{self.RESET}  {self.GRAY}(/mode 切换){self.RESET}"
        self._w(perm_line + "\n")
        # Session
        if session_id:
            resume_tag = " (已恢复)" if is_resume else " (新会话)"
            self._w(f"  {self.GRAY}Session: {session_id}{resume_tag}{self.RESET}\n")
        # 工作目录
        self._w(f"  {self.GRAY}{work_dir}{self.RESET}\n")
        # 底边
        self._w(f"{self.CYAN}╚{'═'*52}╝{self.RESET}\n")

    def error(self, msg: str):
        self._w(f"\n  {self.RED}✗ {msg}{self.RESET}\n")

    # ── 代码写入打字机效果 ──

    def set_code_stream(self, enabled: bool):
        """启用/禁用代码流式显示"""
        self._code_stream_enabled = enabled

    def code_stream(self, file_path: str, content: str):
        """流式显示代码写入过程 — 打字机效果。
        
        策略:
          - 小文件 (≤50行): 全部显示，每行 5ms 延迟
          - 中文件 (≤200行): 全部显示，每行 2ms 延迟
          - 大文件 (>200行): 首尾显示 + 中间省略，每行 1ms 延迟
          - 极短内容 (<30字符): 不流式，直接跳过
        """
        import time, os
        if not self._code_stream_enabled or not content or len(content) < self.CODE_MIN_LENGTH:
            return

        file_name = os.path.basename(file_path) or file_path
        ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
        lines = content.split("\n")
        total_lines = len(lines)
        total_chars = len(content)
        code_color = self._CODE_COLORS.get(ext, self.DIM)

        # 头部
        border_len = min(len(file_name) + 20, 60)
        self._w(f"\n  {self.DIM}✎ {self.RESET}{self.CYAN}{file_name}{self.RESET} {self.GRAY}({total_lines} 行, {total_chars:,} 字符){self.RESET}\n")
        self._w(f"  {self.GRAY}┌{'─' * border_len}┐{self.RESET}\n")

        # 决定显示策略
        if total_lines <= self.CODE_SMALL_THRESHOLD:
            display_lines = lines
            line_delay = self.CODE_SMALL_LINE_DELAY
        elif total_lines <= self.CODE_MEDIUM_THRESHOLD:
            display_lines = lines
            line_delay = self.CODE_MEDIUM_LINE_DELAY
        else:
            head = lines[:self.CODE_LARGE_HEAD_LINES]
            tail = lines[-self.CODE_LARGE_TAIL_LINES:]
            omitted = total_lines - self.CODE_LARGE_HEAD_LINES - self.CODE_LARGE_TAIL_LINES
            display_lines = head + [f"__OMITTED__{omitted}__"] + tail
            line_delay = self.CODE_LARGE_LINE_DELAY

        # 流式输出
        for line in display_lines:
            if line.startswith("__OMITTED__"):
                count = int(line.replace("__OMITTED__", "").replace("__", ""))
                self._w(f"  {self.GRAY}│  ... 省略 {count} 行 ...{self.RESET}\n")
            else:
                display_line = line[:117] + "..." if len(line) > 120 else line
                self._w(f"  {self.GRAY}│{self.RESET} {code_color}{display_line}{self.RESET}\n")
            if line_delay > 0:
                time.sleep(line_delay)

        # 底部
        self._w(f"  {self.GRAY}└{'─' * border_len}┘{self.RESET}\n")


def _fmt_args(args: dict) -> str:
    """Format tool args for display — show key params concisely."""
    parts = []
    for k, v in args.items():
        if k in ("work_dir", "workDir"):
            continue
        s = str(v)
        if len(s) > 50:
            s = s[:47] + "..."
        # Quote string values
        if isinstance(v, str) and " " not in s and len(s) < 50:
            parts.append(f"{k}={s}")
        else:
            parts.append(f"{k}={s}")
    return ", ".join(parts[:4])  # max 4 params shown
