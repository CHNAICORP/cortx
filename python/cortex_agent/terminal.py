"""
Cortex Agent 终端显示器 — Harness Agent Think → Guard → Act → Reflect 差异化输出

设计哲学：
  Think 阶段 — 深灰流式（可见、差异化）
  Act 阶段  — 青色工具标签 + 灰色结果
  Answer    — 亮色输出
  长思考   — 自动折叠为一行摘要，避免刷屏
"""

import sys
from typing import List


class Terminal:
    """终端流式显示：thinking deep-grey, answer bright, long-thinking fold"""

    DEEP  = "\033[38;5;239m"
    CYAN  = "\033[38;5;51m"
    GREEN = "\033[38;5;82m"
    YELLOW= "\033[38;5;220m"
    RED   = "\033[38;5;196m"
    GRAY  = "\033[38;5;240m"
    RESET = "\033[0m"

    # 折叠阈值：超过任一阈值即视为长思考
    FOLD_CHAR_THRESHOLD = 200
    FOLD_LINE_THRESHOLD = 3
    FOLD_PREVIEW_LEN    = 80

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._buf: List[str] = []          # reasoning token buffer
        self._shown_reasoning = False       # reasoning was ever emitted this round
        self._showing_answer = False        # first answer token emitted this round
        self._round = 0                     # current round (increment per _loop)

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
        self._end_reasoning()
        if self._buf:               # only emit spacing if there was reasoning
            self._w("\n\n")
            self._buf.clear()

    # ── Answer phase ──

    def answer_token(self, token: str):
        """Stream answer in bright. First call transitions from thinking:
        - Short thinking: smooth colour reset + newline
        - Long thinking: collapsed one-line grey summary then newline"""
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
                self._w(f"\n  {self.GRAY}● {preview}{self.RESET}\n\n")
            else:
                # Short or no reasoning → smooth transition
                self._w("\n\n")
            self._buf.clear()
            self._showing_answer = True
        self._w(token)

    # ── Round lifecycle ──

    def next_round(self):
        """Reset per-round state — called at start of each _loop iteration."""
        self._round += 1
        self._buf.clear()
        self._shown_reasoning = False
        self._showing_answer = False

    # ── Act phase (tools) ──

    def tool_start(self, name: str, args: dict):
        self._w(f"\n  {self.CYAN}▸ {name}{self.RESET}")

    def tool_inline(self, name: str, args: dict):
        pass

    def tool_done(self, success: bool, latency_ms: float, preview: str):
        icon = f"{self.GREEN}OK{self.RESET}" if success else f"{self.RED}FAIL{self.RESET}"
        short = preview.replace("\n", " ")[:60]
        self._w(f" {icon} {self.GRAY}[{latency_ms:.0f}ms]{self.RESET} {self.GRAY}{short}{self.RESET}\n")

    # ── Banner ──

    def banner(self, model: str, tools: int, work_dir: str, session_id: str = "", mode: str = "standard"):
        mode_color = {"standard": self.GREEN, "auto-edit": self.YELLOW, "yolo": self.RED}.get(mode, self.GRAY)
        mode_icon = {"standard": "🛡️", "auto-edit": "✏️", "yolo": "⚠️"}.get(mode, "?")
        self._w(f"\n{self.CYAN}{'='*48}{self.RESET}\n")
        self._w(f"  Cortex Agent  {self.GREEN}{model}{self.RESET}  {self.GRAY}{tools} tools{self.RESET}\n")
        self._w(f"  权限: {mode_color}{mode_icon} {mode}{self.RESET}  {self.GRAY}(Shift+Tab 切换){self.RESET}\n")
        if session_id:
            self._w(f"  Session: {self.GRAY}{session_id}{self.RESET}\n")
        self._w(f"  {self.GRAY}{work_dir}{self.RESET}\n")
        self._w(f"{self.CYAN}{'='*48}{self.RESET}\n")

    def error(self, msg: str):
        self._w(f"\n  {self.RED}{msg}{self.RESET}\n")


def _fmt_args(args: dict) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 40:
            s = s[:37] + "..."
        parts.append(s)
    return ", ".join(parts)
