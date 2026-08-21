# -*- coding: utf-8 -*-
"""
AskUserPanel — Agent 询问面板（ask_user 工具的交互实现）
与 TS src/cli/ask_panel.ts 完全对应

支持一次最多 4 个问题；每个问题可带 1-6 个选项（单选 ●○ / 多选 [x][ ]，
数字键快捷选择），或省略选项转为自由文本输入。ESC/Ctrl+C 取消整个面板。
交互按键走 msvcrt（Win32）/ termios+tty（Unix）单键读取，与 main.py
_select_list / _ask_esc 同款模式；非交互环境（非 TTY / 子代理 / 管道 CI）
不阻塞，直接返回标记文本。
"""
import sys
import json

CY = "\x1b[36m"
GR = "\x1b[90m"
GN = "\x1b[38;5;82m"
YL = "\x1b[38;5;220m"
R = "\x1b[0m"
REV = "\x1b[7m"

MAX_QUESTIONS = 4
MAX_OPTIONS = 6
MAX_LINE = 64  # 显示截断长度：防止长行折行破坏重绘锚点（光标上移行数假设每行不换行）

ASK_CANCELLED = (
    "用户取消了询问面板（ESC/Ctrl+C），未回答任何问题。"
    "请基于已有上下文自行决策并继续，不要重复调用 ask_user 弹出面板。"
)

_active = False


# ══════════════════════════════════════════════════════════════
# payload 解析与校验（与 TS parseAskPayload 对应）
# ══════════════════════════════════════════════════════════════

def parse_ask_payload(questions_json):
    """返回 (questions, None) 或 (None, error)。"""
    s = str(questions_json or "").strip()
    if not s:
        return None, ('questions_json 不能为空，需要 JSON 数组字符串，'
                      '如 [{"question":"...","options":[{"label":"..."}]}]')
    try:
        arr = json.loads(s)
    except (json.JSONDecodeError, ValueError) as e:
        return None, f"questions_json 解析失败: {e}"
    if not isinstance(arr, list) or not arr:
        return None, "questions_json 必须是非空 JSON 数组"
    if len(arr) > MAX_QUESTIONS:
        return None, f"一次最多 {MAX_QUESTIONS} 个问题（收到 {len(arr)} 个）"
    questions = []
    for i, raw in enumerate(arr):
        if not isinstance(raw, dict):
            return None, f"第 {i + 1} 个问题必须是对象"
        question = str(raw.get("question") or "").strip()
        if not question:
            return None, f"第 {i + 1} 个问题缺少 question 字段"
        q = {
            "question": question,
            "header": str(raw.get("header") or "").strip()[:12] or None,
            "multiSelect": raw.get("multiSelect") is True,
        }
        opts_raw = raw.get("options")
        if opts_raw is not None:
            if not isinstance(opts_raw, list):
                return None, f"第 {i + 1} 个问题的 options 必须是数组"
            if not opts_raw:
                return None, f"第 {i + 1} 个问题的 options 为空（省略 options 则为自由文本输入）"
            if len(opts_raw) > MAX_OPTIONS:
                return None, f"每个问题最多 {MAX_OPTIONS} 个选项（第 {i + 1} 题给了 {len(opts_raw)} 个）"
            opts = []
            for od in opts_raw:
                if not isinstance(od, dict):
                    return None, f"第 {i + 1} 个问题的选项必须是对象"
                label = str(od.get("label") or "").strip()
                if not label:
                    return None, f"第 {i + 1} 个问题存在缺少 label 的选项"
                opts.append({"label": label,
                             "description": str(od.get("description") or "").strip() or None})
            q["options"] = opts
        questions.append(q)
    return questions, None


def non_interactive_result(questions_json):
    """非交互模式结果（子代理 / 管道 CI / 非 TTY）。"""
    questions, _err = parse_ask_payload(questions_json)
    if questions is not None:
        listing = " ".join(f"{i + 1}) {q['question']}" for i, q in enumerate(questions))
    else:
        listing = str(questions_json)[:200]
    return (f"[非交互模式] 无法向用户提问。问题: {listing} — "
            "请根据已有上下文自行决策并继续，不要再次调用 ask_user。")


# ══════════════════════════════════════════════════════════════
# 渲染辅助
# ══════════════════════════════════════════════════════════════

def _disp(s, max_len):
    """显示截断（不影响返回给 LLM 的完整文本）。"""
    return s[:max_len - 1] + "…" if len(s) > max_len else s


def _title_line(idx, total, header):
    h = f" ─ {header}" if header else ""
    return f"{CY}  ╭─ 💬 Agent 询问 ({idx}/{total}){h} ─────────{R}"


def _can_interact():
    try:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return False
    except Exception:
        return False
    if sys.platform == "win32":
        try:
            import msvcrt  # noqa: F401
        except ImportError:
            return False
    else:
        try:
            import termios  # noqa: F401
            import tty  # noqa: F401
        except ImportError:
            return False
    return True


# ══════════════════════════════════════════════════════════════
# 选项题（单选/多选）。返回选中索引列表；ESC/Ctrl+C 返回 None
# ══════════════════════════════════════════════════════════════

def _ask_option_question(q, idx, total):
    opts = q["options"]
    n = len(opts)
    multi = q.get("multiSelect") is True and n > 1
    sel = 0
    checked = [False] * n
    state = {"warn": False}

    def build():
        L = [
            _title_line(idx, total, q.get("header")),
            f"{CY}  │{R} {_disp(q['question'], 60)}",
            f"{CY}  │{R}",
        ]
        for j in range(n):
            marker = (f"[{'x' if checked[j] else ' '}]" if multi
                      else ("●" if j == sel else "○"))
            desc = f" — {opts[j]['description']}" if opts[j].get("description") else ""
            if j == sel:
                # 反色整行；行内不再嵌 ANSI（reset 会提前终止反色）
                L.append(REV + _disp(f"  │ {marker} {j + 1}. {opts[j]['label']}{desc}", MAX_LINE) + R)
            else:
                L.append(f"{CY}  │{R} {GR}{marker}{R} {j + 1}. {opts[j]['label']}"
                         f"{GR}{_disp(desc, 40)}{R}")
        L.append(f"{CY}  │{R}")
        if state["warn"]:
            hint = f"{YL}⚠ 多选题至少勾选一项后再按 Enter{R}"
        elif multi:
            hint = f"{GR}↑↓ 移动 · 空格 勾选 · Enter 确认 · ESC 取消{R}"
        else:
            hint = f"{GR}↑↓ 选择 · Enter 确认 · ESC 取消{R}"
        L.append(f"{CY}  ╰─ {hint}{R}")
        return L

    # 渲染纪律（同 _select_list）：初始渲染与 redraw 都以末行（提示行）结尾、无换行，
    # 光标停在提示行尾；redraw 上移 len-1 行、逐行 \r\x1b[2K 重写，净位移 0 无漂移
    def render():
        sys.stdout.write("\n".join(build()))
        sys.stdout.flush()

    def redraw():
        L = build()
        sys.stdout.write(f"\x1b[{len(L) - 1}A")
        sys.stdout.write("\n".join("\r\x1b[2K" + l for l in L))
        sys.stdout.flush()

    def confirm():
        if multi:
            return [j for j in range(n) if checked[j]]
        return [sel]

    render()
    if sys.platform == "win32":
        import msvcrt
        while True:
            ch = msvcrt.getwch()
            if ch in ("\x1b", "\x03"):
                print()
                return None
            if ch in ("\r", "\n"):
                if multi and not any(checked):
                    state["warn"] = True
                    redraw()
                    continue
                print()
                return confirm()
            if ch in ("\x00", "\xe0"):  # 方向键前缀
                k = msvcrt.getwch()
                if k == "H":  # up
                    sel = (sel - 1 + n) % n
                elif k == "P":  # down
                    sel = (sel + 1) % n
                else:
                    continue
                state["warn"] = False
                redraw()
                continue
            if ch == " " and multi:
                checked[sel] = not checked[sel]
                state["warn"] = False
                redraw()
                continue
            if ch.isdigit() and ch != "0":
                j = int(ch) - 1
                if j >= n:
                    continue
                if multi:
                    checked[j] = not checked[j]
                    sel = j
                    state["warn"] = False
                    redraw()
                    continue
                sel = j
                print()
                return [sel]
    else:
        import termios, tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            while True:
                ch = sys.stdin.read(1)
                if ch == "\x1b":
                    # 可能是方向键序列 \x1b[A/B
                    nxt = sys.stdin.read(2) if sys.stdin.readable() else ""
                    if nxt == "[A":
                        sel = (sel - 1 + n) % n
                        state["warn"] = False
                        redraw()
                        continue
                    if nxt == "[B":
                        sel = (sel + 1) % n
                        state["warn"] = False
                        redraw()
                        continue
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return None
                if ch in ("\r", "\n"):
                    if multi and not any(checked):
                        state["warn"] = True
                        redraw()
                        continue
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return confirm()
                if ch == " " and multi:
                    checked[sel] = not checked[sel]
                    state["warn"] = False
                    redraw()
                    continue
                if ch == "\x03":  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return None
                if ch.isdigit() and ch != "0":
                    j = int(ch) - 1
                    if j >= n:
                        continue
                    if multi:
                        checked[j] = not checked[j]
                        sel = j
                        state["warn"] = False
                        redraw()
                        continue
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return [j]
        finally:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════
# 自由文本题。返回输入文本（可为空串）；ESC/Ctrl+C 返回 None
# ══════════════════════════════════════════════════════════════

def _ask_text_question(q, idx, total):
    lines = [
        _title_line(idx, total, q.get("header")),
        f"{CY}  │{R} {_disp(q['question'], 60)}",
        f"{CY}  │{R} {GR}(输入回答 · Enter 确认 · ESC 取消){R}",
        f"{CY}  │{R}",
    ]
    print("\n".join(lines))
    print(f"{CY}  │{R} {GN}>{R} ", end="", flush=True)
    buf = ""
    if sys.platform == "win32":
        import msvcrt
        while True:
            ch = msvcrt.getwch()
            if ch in ("\x1b", "\x03"):
                print()
                return None
            if ch in ("\r", "\n"):
                print()
                return buf.strip()
            if ch in ("\x00", "\xe0"):  # 方向键等前缀（行内无光标移动，吞掉）
                msvcrt.getwch()
                continue
            if ch == "\x08":  # backspace
                if buf:
                    buf = buf[:-1]
                    print("\b \b", end="", flush=True)
                continue
            buf += ch
            print(ch, end="", flush=True)
    else:
        import termios, tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            while True:
                ch = sys.stdin.read(1)
                if ch == "\x1b":
                    nxt = sys.stdin.read(2) if sys.stdin.readable() else ""
                    if nxt in ("[A", "[B", "[C", "[D"):
                        continue
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return None
                if ch in ("\r", "\n"):
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return buf.strip()
                if ch in ("\x08", "\x7f"):  # backspace / DEL
                    if buf:
                        buf = buf[:-1]
                        print("\b \b", end="", flush=True)
                    continue
                if ch == "\x03":  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old)
                    print()
                    return None
                buf += ch
                print(ch, end="", flush=True)
        finally:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════
# 面板主入口（ask_user 工具调用；返回给 LLM 的结果字符串）
# ══════════════════════════════════════════════════════════════

def run_ask_user_panel(questions_json):
    global _active
    questions, err = parse_ask_payload(questions_json)
    if err:
        return f"(x) {err}"
    if _active:
        return "[询问面板正忙] 已有另一个问题正在等待用户回答，请稍后重试或自行决策。"
    # 非 TTY（管道/CI/假终端）不阻塞等待按键，直接走非交互结果
    if not _can_interact():
        return non_interactive_result(questions_json)
    _active = True
    try:
        total = len(questions)
        answers = []
        print()
        for i, q in enumerate(questions):
            if q.get("options"):
                picked = _ask_option_question(q, i + 1, total)
                if picked is None:
                    print(f"  {CY}│{R}\n  {CY}╰─{R} {YL}✗ 已取消{R}\n")
                    return ASK_CANCELLED
                answer = ", ".join(q["options"][j]["label"] for j in picked)
            else:
                text = _ask_text_question(q, i + 1, total)
                if text is None:
                    print(f"  {CY}│{R}\n  {CY}╰─{R} {YL}✗ 已取消{R}\n")
                    return ASK_CANCELLED
                answer = text
            answers.append((q, answer))
            print(f"  {GN}✓{R} 已记录" + ("\n" if i < total - 1 else ""))
        # 收尾摘要
        print(f"\n  {GN}✓{R} 已收到全部回答:")
        for q, a in answers:
            h = f"[{q['header']}] " if q.get("header") else ""
            print(f"    {GR}{h}{R}{_disp(a or '(未输入)', 70)}")
        print()
        lines = [f"[{q.get('header') or '问题'}] {q['question']} → {a or '(用户未输入)'}"
                 for q, a in answers]
        return f"用户已回答 {total} 个问题:\n" + "\n".join(lines)
    finally:
        _active = False
