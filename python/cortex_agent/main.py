"""
Cortex Agent CLI — 入口 + 工厂函数
用法:
  python main.py                          # 交互 REPL（默认恢复上次会话）
  python main.py --model pro              # 指定模型
  python main.py --work-dir ./ws          # 工作目录
  python main.py -q "search for Python"   # 单次查询
  python main.py --no-stream              # 关闭流式输出
  python main.py -r                       # 恢复会话（弹出选择器）
  python main.py -r <SESSION_ID>          # 恢复到指定会话的完整上下文
  python main.py --resume <SESSION_ID>    # 同 -r，恢复指定会话
  python main.py --list-sessions          # 列出已保存会话
  python main.py --init-config            # 创建默认 .cortex/settings.json
"""

import os, sys, sqlite3, glob as _glob, json
from .cortex_agent import CortexAgent, AgentConfig, LLMProvider, registry
from .terminal import Terminal
from .config import load_settings, apply_to_config, create_default_settings

# 导入所有工具模块以触发工具注册
from . import tools as _
from . import tools_mcp as _
from . import tools_browser as _
from . import tools_computer as _
from . import tools_network as _
from . import tools_rag as _
from . import tools_office as _
del _


def check_mcp_runtimes(verbose: bool = False) -> list:
    """检测 MCP 运行时依赖（npx/uvx/python），返回缺失项列表。
    
    verbose=True 时同时打印提示信息。
    """
    import shutil as _sh
    missing = []
    has_npx = _sh.which("npx") is not None
    has_uvx = _sh.which("uvx") is not None
    has_python = _sh.which("python") is not None or sys.executable
    if not has_npx:
        missing.append("Node.js (npx) — 必需，11 个 MCP 依赖它（playwright/filesystem/memory/puppeteer/chrome-devtools 等）")
    if not has_uvx:
        missing.append("uv (uvx) — 必需，3 个 MCP 依赖它（sqlite/fetch/blender-mcp）")
    if not has_python:
        missing.append("Python — 必需，fetch MCP 依赖它")
    if verbose and missing:
        print(f"\n  ⚠️  MCP 运行时缺失:")
        for m in missing:
            print(f"      • {m}")
        print(f"      安装后 {18 - len(missing)} 个 MCP 可用，详见 mcp_registry()")
        print(f"      安装命令: Node.js → https://nodejs.org | uv → pip install uv\n")
    return missing


def create_agent(model: str = None, work_dir: str = None, api_key: str = None,
                 system_prompt: str = None, max_steps: int = None,
                 term: Terminal = None) -> CortexAgent:
    """工厂函数：创建 Cortex Agent 实例。所有参数可选，优先从 settings.json。"""
    settings = load_settings()
    config = AgentConfig()
    apply_to_config(config, settings)
    # CLI 覆盖（仅传入的非 None 值）
    if model: config.model = LLMProvider.resolve(model)
    if work_dir: config.work_dir = os.path.abspath(work_dir)
    if api_key: config.api_key = api_key
    if system_prompt: config.system_prompt = system_prompt
    if max_steps is not None: config.max_steps = max_steps
    agent = CortexAgent(config)
    if term and term.enabled:
        agent.set_term(term)
    # init default database
    db = sqlite3.connect(os.path.join(agent.work_dir, "agent.db"))
    db.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")
    db.execute("INSERT OR IGNORE INTO users VALUES (1,'Alice',28),(2,'Bob',32),(3,'Carol',25)")
    db.commit(); db.close()
    return agent


def setup_wizard(config: 'AgentConfig', settings: dict) -> 'AgentConfig':
    """首次运行配置向导 — 美化版交互式引导。"""
    t = Terminal(enabled=True)
    # ── 欢迎横幅 ──
    t._w(f"\n{t.CYAN}╔{'═'*52}╗{t.RESET}\n")
    t._w(f"{t.CYAN}║{t.RESET}  🎉 欢迎使用 Cortex Agent                                {t.CYAN}║{t.RESET}\n")
    t._w(f"{t.CYAN}║{t.RESET}  首次运行，需要配置 AI 模型才能开始。                {t.CYAN}║{t.RESET}\n")
    t._w(f"{t.CYAN}╚{'═'*52}╝{t.RESET}\n\n")

    # 1. Provider 选择
    providers = {
        "1": ("deepseek",  "DeepSeek",   "V4 系列，国内可用",   "1M 上下文 / 384K 输出"),
        "2": ("anthropic", "Anthropic",  "Claude 模型",        "最高 1M 上下文"),
        "3": ("openai",    "OpenAI",     "GPT-5.x 系列",       "最高 1M 上下文"),
        "4": ("glm",       "GLM 智谱",   "GLM-5.2 国产旗舰",   "1M 上下文"),
    }
    t._w(f"  {t.YELLOW}📋 选择模型提供商:{t.RESET}\n")
    for k, (pid, name, desc, ctx) in providers.items():
        marker = "★" if k == "1" else " "
        t._w(f"    {t.GREEN}{marker} [{k}]{t.RESET} {t.BOLD}{name:<14}{t.RESET} {t.DIM}{desc}{t.RESET}  {t.GRAY}{ctx}{t.RESET}\n")
    choice = input(f"  {t.GREEN}请选择 (1/2/3/4):{t.RESET} ").strip() or "1"
    provider, prov_name, _, _ = providers.get(choice, ("deepseek", "DeepSeek", "", ""))

    # 2. API Key
    t._w(f"\n  {t.YELLOW}🔑 输入 API Key:{t.RESET}\n")
    key_urls = {
        "deepseek":  "https://platform.deepseek.com/api_keys",
        "anthropic": "https://console.anthropic.com/settings/keys",
        "openai":    "https://platform.openai.com/api-keys",
        "glm":       "https://open.bigmodel.cn/console/apikeys",
    }
    t._w(f"  {t.GRAY}获取 Key: {key_urls.get(provider, '')}{t.RESET}\n")
    api_key = input(f"  {t.GREEN}API Key:{t.RESET} ").strip()
    while not api_key:
        t._w(f"  {t.RED}✗ API Key 不能为空{t.RESET}\n")
        api_key = input(f"  {t.GREEN}API Key:{t.RESET} ").strip()

    # 3. 模型选择
    models = {
        "deepseek": {
            "1": ("pro",   "deepseek-v4-pro",   "V4-Pro 旗舰",  "1M ctx / 384K out"),
            "2": ("flash", "deepseek-v4-flash", "V4-Flash 快速", "1M ctx / 384K out"),
        },
        "anthropic": {
            "1": ("fable",    "claude-fable-5",    "Fable 5 — 最强旗舰",       "1M 上下文"),
            "2": ("sonnet",   "claude-sonnet-5",   "Sonnet 5 — 均衡高效",      "1M 上下文"),
            "3": ("opus",     "claude-opus-4-8",   "Opus 4.8 — 顶级编码",      "200K 上下文"),
            "4": ("haiku",    "claude-haiku-4-5",  "Haiku 4.5 — 快速轻量",     "200K 上下文"),
            "5": ("mythos",   "claude-mythos-5",   "Mythos 5 — 新一代推理",    "1M 上下文"),
        },
        "openai": {
            "1": ("5.4",       "gpt-5.4",       "GPT-5.4 旗舰",      "1M 上下文"),
            "2": ("5.4-mini",  "gpt-5.4-mini",  "GPT-5.4 Mini",     "1M 上下文"),
            "3": ("5.2",       "gpt-5.2",       "GPT-5.2",           "1M 上下文"),
            "4": ("4.1",       "gpt-4.1",       "GPT-4.1",           "1M 上下文"),
            "5": ("4.1-mini",  "gpt-4.1-mini",  "GPT-4.1 Mini",     "1M 上下文"),
            "6": ("4o",        "gpt-4o",        "GPT-4o",            "128K 上下文"),
        },
        "glm": {
            "1": ("5.2",       "glm-5.2",       "GLM-5.2 旗舰",     "1M 上下文"),
            "2": ("5.1",       "glm-5.1",       "GLM-5.1",          "128K 上下文"),
            "3": ("turbo",     "glm-5-turbo",   "GLM-5-Turbo",      "128K 上下文"),
            "4": ("4.7",       "glm-4.7",       "GLM-4.7",          "200K 上下文"),
            "5": ("4.7-flash", "glm-4.7-flash", "GLM-4.7 Flash",   "200K 上下文 / 免费"),
            "6": ("4-long",    "glm-4-long",    "GLM-4-Long",       "1M 上下文"),
        },
    }
    t._w(f"\n  {t.YELLOW}🤖 选择模型:{t.RESET}\n")
    prov_models = models.get(provider, {})
    for k, (alias, name, desc, ctx) in prov_models.items():
        t._w(f"    {t.GREEN}[{k}]{t.RESET} {t.BOLD}{alias:<16}{t.RESET} {t.DIM}{desc}{t.RESET}  {t.GRAY}{ctx}{t.RESET}\n")
    default_key = "1"
    m_choice = input(f"  {t.GREEN}请选择 ({'/'.join(prov_models.keys())}):{t.RESET} ").strip() or default_key
    model_alias, model_name, _, _ = prov_models.get(m_choice, prov_models.get(default_key, ("pro", "deepseek-v4-pro", "", "")))

    # 4. 保存配置
    _base_urls = {
        "deepseek":  "https://api.deepseek.com/v1",
        "anthropic": "https://api.anthropic.com",
        "openai":    "https://api.openai.com/v1",
        "glm":       "https://open.bigmodel.cn/api/paas/v4",
    }
    user_path = os.path.join(os.path.expanduser("~"), ".cortx", "settings.json")
    new_settings = {
        "model": model_alias,
        "provider": provider,
        "providers": {provider: {"api_key": api_key, "base_url": _base_urls[provider],
                                  "models": {model_alias: model_name}}},
        "max_steps": 0, "context_limit": 0, "max_tokens": 0, "permission_mode": "standard",
        "auto_extract_memory": True, "memory_enabled": True, "sessions_enabled": True,
    }
    os.makedirs(os.path.dirname(user_path), exist_ok=True)
    with open(user_path, "w", encoding="utf-8") as f:
        json.dump(new_settings, f, ensure_ascii=False, indent=2)

    # ── 成功提示 ──
    t._w(f"\n  {t.GREEN}✅ 配置已保存{t.RESET}  {t.GRAY}{user_path}{t.RESET}\n")
    t._w(f"  {t.CYAN}▸ 提供商:{t.RESET} {prov_name}  ")
    t._w(f"{t.CYAN}▸ 模型:{t.RESET} {model_alias} ({model_name})\n")
    t._w(f"  {t.CYAN}启动 Cortex Agent...{t.RESET}\n\n")

    config.api_key = api_key
    config.model = model_name
    LLMProvider.setup(new_settings["providers"], provider)
    return config


def _session_preview(sessions_dir: str, session_id: str) -> str:
    """从会话 .jsonl 提取首条 user 消息作为预览（与 SessionStore.get_history_summary 同款读取）。"""
    try:
        fpath = os.path.join(sessions_dir, f"{os.path.basename(session_id)}.jsonl")
        if not os.path.isfile(fpath):
            return ""
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "msg" and obj.get("role") == "user":
                    return " ".join(str(obj.get("content", "")).split())[:50]
    except Exception:
        pass
    return ""


def _fmt_time(iso: str) -> str:
    """ISO 时间 -> MM-DD HH:MM"""
    try:
        from datetime import datetime
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.strftime("%m-%d %H:%M")
    except Exception:
        return str(iso)[:16]


# ══════════════════════════════════════════════════════════════
# / 和 @ 自动补全输入（实时下拉提示）
# ══════════════════════════════════════════════════════════════

_SLASH_CMDS = [
    ("/help", "显示帮助"), ("/tools", "列出工具"), ("/skills", "列出技能"),
    ("/skill", "调用技能 <name>"), ("/model", "切换模型"), ("/mode", "切换权限"),
    ("/context", "上下文容量+缓存"), ("/memory", "查看记忆"), ("/forget", "删除记忆"),
    ("/save", "保存会话"), ("/sessions", "列出会话"), ("/resume", "恢复会话"),
    ("/reset", "重置上下文"), ("/trace", "最后轨迹"), ("/audit", "审计轨迹"),
    ("/kb", "查看知识库"), ("/init", "初始化项目"), ("/goal", "设置目标"),
    ("/plan", "规划模式"), ("/hooks", "钩子管理"),
    ("/subagents", "查看子代理结果"), ("/subagent", "查看子代理详情 <id>"),
    ("/exit", "退出"),
]


def _read_input_hints(prompt: str, work_dir: str, term) -> str:
    """读取用户输入，输入 / 或 @ 时实时显示补全提示。回退到 input() 如果 raw 模式不可用。"""
    # 检测 raw 模式可用性
    try:
        import msvcrt  # noqa
        _plat = "win"
    except ImportError:
        try:
            import termios  # noqa
            _plat = "unix"
        except ImportError:
            _plat = "none"

    if _plat == "none":
        return input(prompt)

    buf = ""
    _hint_n = [0]  # nonlocal workaround

    def _clear_hint():
        if _hint_n[0] > 0:
            for _ in range(_hint_n[0]):
                sys.stdout.write("\x1b[B\x1b[2K")
            for _ in range(_hint_n[0]):
                sys.stdout.write("\x1b[A")
            sys.stdout.flush()
            _hint_n[0] = 0

    def _render_hint():
        _clear_hint()
        hints = []
        if buf.startswith("/"):
            for cmd, desc in _SLASH_CMDS:
                if cmd.startswith(buf.rstrip()) or (len(buf) > 1 and cmd.startswith(buf)):
                    hints.append(f"  {term.CYAN}{cmd}{term.RESET} {term.GRAY}{desc}{term.RESET}")
        elif "@" in buf:
            at_idx = buf.rfind("@")
            prefix = buf[at_idx + 1:]
            try:
                files = [f for f in os.listdir(work_dir)
                         if f.startswith(prefix) and not f.startswith(".")]
                hints = [f"  {term.YELLOW}@{f}{term.RESET}" for f in files[:7]]
            except Exception:
                pass
        if hints:
            sys.stdout.write("\x1b[s\n" + "\n".join(hints[:7]) + "\x1b[u")
            sys.stdout.flush()
            _hint_n[0] = min(len(hints), 7) + 1

    def _read_one():
        """读取一个按键，返回 (char, key_name)。"""
        if _plat == "win":
            import msvcrt
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):
                ch2 = msvcrt.getwch()
                kn = {"H": "up", "P": "down"}.get(ch2, "")
                return "", kn
            return ch, {"\r": "return", "\n": "return", "\x03": "cancel"}.get(ch, "")
        else:
            import termios, tty
            fd = sys.stdin.fileno()
            old = termios.tcgetattr(fd)
            try:
                tty.setcbreak(fd)
                ch = sys.stdin.read(1)
                if ch == "\x1b":
                    rest = sys.stdin.read(2)
                    kn = {"[A": "up", "[B": "down"}.get(rest, "")
                    return "", kn
                return ch, {"\r": "return", "\n": "return", "\x03": "cancel"}.get(ch, "")
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)

    sys.stdout.write(prompt)
    sys.stdout.flush()

    while True:
        ch, key = _read_one()

        if key == "return":
            _clear_hint()
            sys.stdout.write("\n")
            sys.stdout.flush()
            return buf
        elif key == "cancel":
            _clear_hint()
            sys.stdout.write("\n")
            raise KeyboardInterrupt
        elif ch in ("\x08", "\x7f"):  # Backspace
            if buf:
                buf = buf[:-1]
                sys.stdout.write("\b \b")
                sys.stdout.flush()
                _render_hint()
        elif ch == "\t":  # Tab: 补全第一个匹配
            if buf.startswith("/"):
                matches = [c for c, _ in _SLASH_CMDS if c.startswith(buf)]
                if matches:
                    old_len = len(buf)
                    buf = matches[0] + " "
                    sys.stdout.write("\b" * old_len + " " * old_len + "\b" * old_len + buf)
                    sys.stdout.flush()
                    _render_hint()
            elif "@" in buf:
                at_idx = buf.rfind("@")
                prefix = buf[at_idx + 1:]
                try:
                    files = [f for f in os.listdir(work_dir) if f.startswith(prefix)]
                    if files:
                        old_len = len(buf)
                        buf = buf[:at_idx + 1] + files[0]
                        sys.stdout.write("\b" * old_len + " " * old_len + "\b" * old_len + buf)
                        sys.stdout.flush()
                        _render_hint()
                except Exception:
                    pass
        elif ch and ch.isprintable():
            buf += ch
            sys.stdout.write(ch)
            sys.stdout.flush()
            _render_hint()


def _read_key() -> str:
    """
    跨平台读取单按键，返回 key name。
    - 方向键: "up" / "down" / "left" / "right"
    - 回车: "return"
    - Ctrl+C / ESC: "cancel"
    - 数字/字符: 原样返回
    - 读取失败: 返回 "" (调用方据此回退到文本输入)
    win32: msvcrt.getwch (方向键为 0x00/0xe0 前缀 + 第二字节)
    unix:  termios + tty.setcbreak (方向键为 ESC[A/B/C/D)
    """
    try:
        if sys.platform == "win32":
            import msvcrt
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):
                ch2 = msvcrt.getwch()
                return {"H": "up", "P": "down", "K": "left", "M": "right"}.get(ch2, "")
            return {"\r": "return", "\n": "return", "\x03": "cancel", "\x1b": "cancel"}.get(ch, ch)
        else:
            import termios, tty
            fd = sys.stdin.fileno()
            old = termios.tcgetattr(fd)
            try:
                tty.setcbreak(fd)
                ch = sys.stdin.read(1)
                if ch == "\x1b":
                    seq = sys.stdin.read(2)
                    return {"[A": "up", "[B": "down", "[C": "right", "[D": "left"}.get(seq, "cancel")
                return {"\r": "return", "\n": "return", "\x03": "cancel"}.get(ch, ch)
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
    except Exception:
        return ""


def _render_session_row(s: dict, idx: int, sessions_dir: str, selected: bool, t) -> str:
    """渲染单行会话。selected=True 时高亮（绿底/反色）。返回不含换行的行。"""
    sid = str(s.get("session_id", ""))[:20]
    la = _fmt_time(str(s.get("last_active", "")))
    q = str(s.get("query_count", 0)).ljust(2)
    prev = _session_preview(sessions_dir, str(s.get("session_id", ""))) or "(空)"
    num = str(idx + 1).rjust(2)
    CY, GR, DM, G = t.CYAN, t.GRAY, t.DIM, t.RESET
    GN = t.GREEN
    if selected:
        HL = "\033[32m\033[1m"   # 绿色加粗
        BG = "\033[48;5;238m"    # 深灰底
        return f"{CY}│{G} {BG}▸{HL}{num} {sid:<20} {la:<11} {q} {prev[:24]:<24}{G}   {CY}│{G}"
    marker = f"{GN}★{G}" if idx == 0 else f"{GR} {G}"
    return f"{CY}│{G} {marker}{GR}{num}{G} {sid:<20} {la:<11} {q} {DM}{prev[:24]}{G}"


def prompt_session_resume(agent: 'CortexAgent', max_show: int = 15):
    """
    弹出会话选择器，返回选中的 session_id。
    - 返回 str: 选中的 session_id
    - 返回 None: 用户选择"新建会话"
    - 返回 "": 非 TTY 环境，由调用方走默认逻辑（get_last_session）
    """
    if not agent.sessions:
        print("(会话系统不可用)")
        return ""
    sessions = agent.sessions.list_sessions()
    if not sessions:
        print(f"{Terminal.GRAY if hasattr(Terminal,'GRAY') else ''}(无已保存的会话，将创建新会话)")
        return None
    # 非 TTY 直接用最近会话
    if not sys.stdin.isatty():
        print(f"[resume] 非交互环境，恢复最近会话: {sessions[0].get('session_id', '')}", file=sys.stderr)
        return sessions[0].get("session_id", "")
    top = sessions[:max_show]
    sessions_dir = os.path.join(agent.work_dir, "sessions")
    t = Terminal(enabled=False)  # 仅用颜色常量
    CY, GR, DM, G = t.CYAN, t.GRAY, t.DIM, t.RESET
    GN, YL, RD = t.GREEN, t.YELLOW, t.RED
    n = len(top)

    # ── 渲染表头 + 列表 ──
    def _print_header():
        print(f"\n{CY}╭{'─'*58}╮{G}")
        print(f"{CY}│{G}  📂 历史会话 (最近 {len(top)}/{len(sessions)} 条){' ' * max(0, 58 - 22 - len(str(len(top))) - len(str(len(sessions))) - 8)}{CY}│{G}")
        print(f"{CY}├{'─'*58}┤{G}")
        print(f"{CY}│{G} {GR}#{G}  {GR}{'SESSION_ID':<20}{G} {GR}{'时间':<11}{G} {GR}Q{G}  {GR}预览{G}")

    def _render_list(selected):
        for i, s in enumerate(top):
            sys.stdout.write(_render_session_row(s, i, sessions_dir, i == selected, t) + "\n")

    def _redraw_list(selected):
        # 光标上移 n 行，逐行重写（清行）
        sys.stdout.write(f"\x1b[{n}A")
        for i, s in enumerate(top):
            sys.stdout.write("\r\x1b[2K" + _render_session_row(s, i, sessions_dir, i == selected, t) + "\n")
        sys.stdout.flush()

    footer_hint = f"  {DM}↑↓ 移动 · 回车=确认 · 0/new=新建 · 数字快捷 · 或粘贴 session_id{G}"

    # ── 文本输入回退（_read_key 不可用时）──
    def _text_input_loop():
        _print_header()
        _render_list(0)
        print(f"{CY}╰{'─'*58}╯{G}")
        print(footer_hint)
        while True:
            try:
                inp = input(f"  {GN}选择:{G} ").strip()
            except (EOFError, KeyboardInterrupt):
                return None
            if not inp:
                return str(top[0].get("session_id", ""))
            if inp == "0" or inp.lower() in ("n", "new"):
                return None
            if inp.isdigit():
                num = int(inp)
                if 1 <= num <= n:
                    return str(top[num-1].get("session_id", ""))
                print(f"  {RD}(x) 序号超出范围 1-{n}{G}")
                continue
            matches = [s for s in top if str(s.get("session_id", "")).startswith(inp) or inp in str(s.get("session_id", ""))]
            if len(matches) == 1:
                return str(matches[0].get("session_id", ""))
            full = [s for s in sessions if str(s.get("session_id", "")) == inp]
            if full:
                return str(full[0].get("session_id", ""))
            print(f"  {RD}(x) 无匹配，请重试{G}")

    # ── 检测 raw 按键读取是否可用（win32=msvcrt, unix=termios）──
    _raw_ok = False
    try:
        if sys.platform == "win32":
            import msvcrt  # noqa: F401
            _raw_ok = True
        else:
            import termios  # noqa: F401
            _raw_ok = True
    except ImportError:
        _raw_ok = False

    # raw 不可用 → 文本输入回退
    if not _raw_ok:
        return _text_input_loop()

    # ── 交互式高亮选择 ──
    _print_header()
    _render_list(0)
    selected = 0
    while True:
        key = _read_key()
        # _read_key 读取失败 → 回退文本输入
        if key == "":
            return _text_input_loop()
        if key == "up":
            selected = (selected - 1 + n) % n
            _redraw_list(selected)
        elif key == "down":
            selected = (selected + 1) % n
            _redraw_list(selected)
        elif key == "return":
            _redraw_list(selected)
            print(f"{CY}╰{'─'*58}╯{G}")
            print(footer_hint)
            return str(top[selected].get("session_id", ""))
        elif key == "cancel":
            _redraw_list(selected)
            print(f"{CY}╰{'─'*58}╯{G}")
            print(footer_hint)
            return None
        elif key == "0":
            _redraw_list(selected)
            print(f"{CY}╰{'─'*58}╯{G}")
            print(footer_hint)
            return None
        elif key and key.isdigit() and 1 <= int(key) <= n:
            selected = int(key) - 1
            _redraw_list(selected)
            print(f"{CY}╰{'─'*58}╯{G}")
            print(footer_hint)
            return str(top[selected].get("session_id", ""))
        # 其他按键忽略


def main():
    import argparse
    if hasattr(sys.stdout, 'reconfigure'):
        try: sys.stdout.reconfigure(encoding='utf-8')
        except: pass

    p = argparse.ArgumentParser(description="Cortex Agent")
    p.add_argument("-V", "--version", action="store_true", help="显示版本号")
    p.add_argument("--update", action="store_true", help="更新 cortx 到最新版本")
    p.add_argument("--model", default=None, help="模型别名 (覆盖 settings.json)")
    p.add_argument("--work-dir", default=None, help="工作目录")
    p.add_argument("--max-steps", type=int, default=None, help="最大步数 (0=无限，支持长时连续运行；--long 模式自动设为0)")
    p.add_argument("--long", action="store_true", help="长时运行模式（自动续行直到完成）")
    p.add_argument("--max-rounds", type=int, default=None, help="限制续行轮数（0=无限）")
    p.add_argument("--no-stream", action="store_true", help="关闭流式输出")
    p.add_argument("--query","-q", default=None, help="单次查询")
    p.add_argument("-p", "--pipe", default=None, metavar="PROMPT", help="管道模式 (从 stdin 读取输入，非交互)")
    p.add_argument("-r", "--resume", default=None, nargs="?", const="__PICK__", metavar="SESSION_ID",
                   help="恢复会话: -r 弹出选择器, -r <id> 恢复指定会话")
    p.add_argument("--list-sessions", action="store_true", help="列出已保存的会话")
    p.add_argument("--init-config", action="store_true", help="创建默认 .cortex/settings.json")
    p.add_argument("--mode", default=None, choices=["standard","auto","yolo"],
                   help="权限模式: standard|auto|yolo")
    p.add_argument("--allowed-tools", default=None, help="工具白名单 (逗号分隔)")
    p.add_argument("--disallowed-tools", default=None, help="工具黑名单 (逗号分隔)")
    args = p.parse_args()

    if args.version:
        print(f"cortx {__import__('cortex_agent').__version__} (Python)")
        return

    if args.update:
        import subprocess, sys as _sys
        print(f"当前: cortx {__import__('cortex_agent').__version__}")
        _sys.exit(subprocess.call([_sys.executable, "-m", "pip", "install", "cortx", "--upgrade", "--no-cache-dir"]))

    if args.init_config:
        cfg_path = os.path.join(os.getcwd(), ".cortx", "settings.json")
        create_default_settings(cfg_path)
        print(f"已创建默认配置: {cfg_path}")
        return

    term = Terminal(enabled=not args.no_stream)

    # 首次运行：检查 API Key 是否配置
    settings = load_settings()
    provider = settings.get("provider", "deepseek")
    has_api_key = (settings.get("providers", {}).get(provider, {}).get("api_key", "")
                   or settings.get("api_key", ""))
    if not has_api_key:
        if term.enabled:
            config = AgentConfig()
            apply_to_config(config, settings)
            setup_wizard(config, settings)
            # 重新加载 settings（向导已写入）
            settings = load_settings()
        else:
            print("\n  ⚠️  未配置 API Key。\n"
                  "  交互模式运行 ctx 进入配置向导，或编辑 ~/.cortex/settings.json\n")
            sys.exit(1)

    # --long 模式下每轮无限步数（由 maxRounds 控制续行，避免每轮步数耗尽中断企业级开发）
    _effective_max_steps = 0 if args.long else (args.max_steps if args.max_steps is not None else None)
    agent = create_agent(model=args.model if args.model != "flash" else None,
                         work_dir=args.work_dir, max_steps=_effective_max_steps, term=term)
    if args.mode:
        agent.config.permission_mode = args.mode
    wd = agent.work_dir

    # ── MCP 运行时检测（交互式启动时提示缺失依赖）──
    if not args.query and not args.pipe:
        check_mcp_runtimes(verbose=True)

    # ── 加载 Hooks 配置 ──
    agent.hooks.load_from_config(settings)
    if agent.hooks.count > 0:
        print(f"[cortex] {agent.hooks.count} hooks loaded", file=sys.stderr)

    # ── 工具白名单/黑名单 ──
    if args.allowed_tools:
        allowed = [t.strip() for t in args.allowed_tools.split(",") if t.strip()]
        agent.set_tool_filter(allowed=allowed)
        print(f"[cortex] 工具白名单: {', '.join(allowed)}", file=sys.stderr)
    if args.disallowed_tools:
        disallowed = [t.strip() for t in args.disallowed_tools.split(",") if t.strip()]
        agent.set_tool_filter(disallowed=disallowed)
        print(f"[cortex] 工具黑名单: {', '.join(disallowed)}", file=sys.stderr)

    # ── Session initialization ──
    if args.list_sessions:
        if agent.sessions:
            sessions = agent.sessions.list_sessions()
            if not sessions:
                print("(无已保存的会话)")
            else:
                print(f"\n{'ID':<24} {'Q':<5} {'MODEL':<22} {'LAST ACTIVE':<20}")
                print("-" * 75)
                for s in sessions:
                    sid = s.get("session_id", "")[:22]
                    qcnt = s.get("query_count", 0)
                    model = s.get("model", "")[:20]
                    la = s.get("last_active", "")[:19]
                    marker = " *" if s["session_id"] == agent.session_id else "  "
                    print(f"{marker}{sid:<22} {qcnt:<5} {model:<22} {la}")
        else:
            print("(会话系统不可用)")
        return

    # Determine session mode
    # 默认创建新会话（仅注入历史摘要）；-r/--resume 才恢复完整上下文
    # -r 不带 id 弹出选择器；带 id 直接恢复
    is_resume = args.resume is not None
    resume_target = args.resume if (args.resume and args.resume != "__PICK__") else None
    resume_id = resume_target
    if is_resume and not resume_target:
        # 不带 id: 弹出选择器（banner 之前）
        resume_id = prompt_session_resume(agent)

    if is_resume and resume_id:
        agent.init_session(session_id=resume_id, resume=True)
    elif is_resume and resume_id is None:
        # 用户在选择器里选了"新建"
        agent.init_session(resume=False)
    elif is_resume:
        # 非 TTY 等场景退回默认 (get_last_session)
        agent.init_session(resume=True)
    else:
        agent.init_session(resume=False)

    if term.enabled:
        sid_display = ""
        if agent.session_id:
            sid_display = agent.session_id[:20] + "..." if len(agent.session_id) > 20 else agent.session_id
        term.banner(agent.model, len(registry.schemas), wd,
                    session_id=sid_display, mode=agent.config.permission_mode,
                    context_limit=agent.context_limit, is_resume=is_resume)

    # ── Skills 系统通过 agent.skill_mgr 访问 ──
    # ── 管道模式 (-p) ──
    is_pipe = args.pipe is not None or (not sys.stdin.isatty() and not args.query)
    if is_pipe:
        agent.set_non_interactive(True)
        pipe_prompt = args.pipe or ""
        stdin_data = ""
        if not sys.stdin.isatty():
            try:
                stdin_data = sys.stdin.read()
            except Exception:
                pass
        if pipe_prompt and stdin_data.strip():
            combined_query = f"{pipe_prompt}\n\n--- stdin 内容 ---\n{stdin_data.strip()}"
        elif pipe_prompt:
            combined_query = pipe_prompt
        elif stdin_data.strip():
            combined_query = stdin_data.strip()
        else:
            print('[cortex] 管道模式需要提供输入 (-p "prompt" 或 stdin)', file=sys.stderr)
            return
        ans = agent.run(combined_query)
        if args.no_stream: print(ans)
        t = agent.last_trace()
        if t and t.steps: print(f"\n[审计] {len(t.steps)} 步, {sum(s.latency_ms for s in t.steps):.0f}ms", file=sys.stderr)
        if agent.session_id:
            print(f"[会话] {agent.session_id}", file=sys.stderr)
        return

    if args.query:
        ans = agent.run(args.query)
        if args.no_stream: print(ans)
        t = agent.last_trace()
        if t and t.steps: print(f"\n[审计] {len(t.steps)} 步, {sum(s.latency_ms for s in t.steps):.0f}ms")
        if agent.session_id:
            print(f"[会话] {agent.session_id}")
        return

    # REPL
    while True:
        mode_label = {"standard": f"{term.GREEN}🛡{term.RESET}",
                      "auto": f"{term.YELLOW}✎{term.RESET}",
                      "yolo": f"{term.RED}⚠{term.RESET}"}.get(agent.config.permission_mode, "?")
        ctx_pct = agent.context_pct
        ctx_color = term.GREEN if ctx_pct < 50 else (term.YELLOW if ctx_pct < 80 else term.RED)
        # 缓存命中率实时显示
        cs = agent.cache_stats
        cache_str = ""
        if cs["calls"] > 0:
            hr = cs["hit_rate"]
            hc = term.GREEN if hr > 80 else (term.YELLOW if hr > 50 else term.RED)
            cache_str = f" {hc}⚡{hr:.0f}%{term.RESET}"
        try: q = _read_input_hints(f"\n{mode_label} {ctx_color}{ctx_pct}%{term.RESET}{cache_str}> ", work_dir, term).strip()
        except (EOFError, KeyboardInterrupt):
            agent.save_session()
            sid = agent.session_id or "?"
            print(f"\n{term.YELLOW}Bye.{term.RESET}  {term.GRAY}Session: {sid}{term.RESET}"); break
        if not q: continue
        if q in ("/exit", "/quit", "/q"):
            agent.save_session()
            sid = agent.session_id or "?"
            print(f"{term.YELLOW}Bye.{term.RESET}  {term.GRAY}Session: {sid}{term.RESET}"); break
        if q in ("/help", "/h", "/?"):
            print(f"  {term.CYAN}═══ 会话管理 ═══{term.RESET}")
            print(f"  {term.CYAN}/save{term.RESET}           保存会话")
            print(f"  {term.CYAN}/sessions{term.RESET}       列出会话")
            print(f"  {term.CYAN}/resume [id]{term.RESET}     恢复会话 (无 id 弹选择器)")
            print(f"  {term.CYAN}/reset{term.RESET}          重置上下文")
            print(f"  {term.CYAN}═══ 工具 & 模型 ═══{term.RESET}")
            print(f"  {term.CYAN}/tools{term.RESET}          列出工具")
            print(f"  {term.CYAN}/model [pro]{term.RESET}    切换模型")
            print(f"  {term.CYAN}/mode [s|a|y]{term.RESET}   切换权限模式")
            print(f"  {term.CYAN}═══ 上下文 & 记忆 ═══{term.RESET}")
            print(f"  {term.CYAN}/context{term.RESET}       上下文容量 + 缓存命中率")
            print(f"  {term.CYAN}/memory{term.RESET}        列出记忆")
            print(f"  {term.CYAN}/forget <name>{term.RESET}  删除记忆")
            print(f"  {term.CYAN}═══ 审计 & 调试 ═══{term.RESET}")
            print(f"  {term.CYAN}/trace{term.RESET}          最后轨迹")
            print(f"  {term.CYAN}/audit{term.RESET}          审计轨迹")
            print(f"  {term.CYAN}═══ 知识库 ═══{term.RESET}")
            print(f"  {term.CYAN}/kb{term.RESET}            查看项目知识库 CORTEX.md")
            print(f"  {term.CYAN}/init{term.RESET}           初始化项目 CORTEX.md")
            print(f"  {term.CYAN}═══ 技能系统 ═══{term.RESET}")
            print(f"  {term.CYAN}/skills{term.RESET}         列出技能")
            print(f"  {term.CYAN}/skill <name>{term.RESET}   调用技能")
            print(f"  {term.CYAN}═══ 目标 & 规划 ═══{term.RESET}")
            print(f"  {term.CYAN}/goal [目标]{term.RESET}    设置/查看持久化目标")
            print(f"  {term.CYAN}/plan [描述]{term.RESET}    进入规划模式")
            print(f"  {term.CYAN}═══ 快捷操作 ═══{term.RESET}")
            print(f"  {term.CYAN}@filename{term.RESET}       引用文件内容到上下文")
            print(f"  {term.CYAN}/q, /exit{term.RESET}       退出")
            continue
        if q in ("/tools", "/t"):
            for s in registry.schemas:
                n = s["function"]["name"]; m = registry.meta(n)
                print(f"  {term.CYAN}{n}{term.RESET} [{m['capability'].value if m else '?'}]")
                print(f"    {s['function']['description']}")
            continue
        if q in ("/model", "/m"):
            print(f"当前: {agent.model}\n可用: flash | pro"); continue
        if q.startswith("/model ") or q.startswith("/m "):
            agent.switch_model(q.split(" ",1)[1]); print(f"→ {agent.model}"); continue
        # ── Permission mode switching ──
        if q in ("/mode", "/permissions"):
            m = agent.config.permission_mode
            print(f"当前: {m}\n可用: {term.GREEN}s/standard{term.RESET} | {term.YELLOW}a/auto{term.RESET} | {term.RED}y/yolo{term.RESET}")
            continue
        if q.startswith("/mode ") or q.startswith("/permissions "):
            result = agent.switch_permission_mode(q.split(" ", 1)[1])
            print(f"→ {result}")
            continue
        if q == "/trace":
            t = agent.last_trace()
            if not t or not t.steps: print("(无轨迹)")
            else:
                for s in t.steps:
                    print(f"  [{s.step}] {s.tool_name} {s.capability} {s.latency_ms:.0f}ms {'OK' if s.success else 'FAIL'}")
            continue
        if q in ("/audit", "/a"):
            traces = agent.observer.traces
            if not traces:
                print("(无审计记录)")
            else:
                for ti, t in enumerate(traces):
                    print(f"\n{term.CYAN}--- 查询 {ti+1}: {t.query[:60]}{term.RESET}")
                    for s in t.steps:
                        status = f"{term.GREEN}OK{term.RESET}" if s.success else f"{term.RED}FAIL{term.RESET}"
                        print(f"  [{s.step}] {s.tool_name} {s.capability} {s.latency_ms:.0f}ms {status}")
                    if t.error: print(f"  ERROR: {t.error}")
                    if t.step_limit_reached: print(f"  结果: 超步数")
            continue
        if q in ("/save", "/s"):
            sid = agent.save_session()
            print(f"会话已保存: {sid}"); continue
        if q in ("/sessions", "/ls"):
            if agent.sessions:
                sessions = agent.sessions.list_sessions()
                if not sessions:
                    print("(无已保存的会话)")
                else:
                    for s in sessions:
                        marker = " *" if s['session_id'] == agent.session_id else "  "
                        print(f"{marker} {s['session_id'][:22]:<22} Q={s.get('query_count',0)} {s.get('last_active','')[:19]}")
            else:
                print("(会话系统不可用)")
            continue
        def _do_resume(target):
            """恢复指定会话（复用逻辑）"""
            try:
                if agent.sessions:
                    saved_ctx, meta = agent.sessions.load(target)
                    agent._ctx = saved_ctx
                    agent._session_id = target
                    agent._query_count = meta.get("query_count", 0)
                    agent._step_count_total = meta.get("step_count", 0)
                    agent.governor = agent._make_governor()
                    print(f"已恢复会话: {target}")
                else:
                    print("(会话系统不可用)")
            except FileNotFoundError:
                print(f"(x) 会话不存在: {target}")
            except Exception as e:
                print(f"(x) 恢复失败: {e}")
        # ── /resume [id] ──  不带 id 弹出选择器（与 CLI `ctx -r` 一致）
        if q in ("/resume", "/r"):
            picked = prompt_session_resume(agent)
            if picked:
                _do_resume(picked)
            elif picked is None:
                print("已选择新建会话")
            continue
        if q.startswith("/resume ") or q.startswith("/r "):
            target = q.split(" ", 1)[1].strip()
            _do_resume(target)
            continue
        if q in ("/memory", "/mem"):
            if agent.memory:
                facts = agent.memory.list_all()
                if not facts:
                    print("(没有记住任何事实)")
                else:
                    for f in facts:
                        # facts 是字符串列表（markdown 行），直接展示
                        print(f"  {term.CYAN}{f}{term.RESET}")
            else:
                print("(记忆系统不可用)")
            continue
        if q.startswith("/forget "):
            name = q.split(" ", 1)[1].strip()
            if agent.memory:
                if agent.memory.delete(name):
                    agent.governor = agent._make_governor()
                    print(f"已忘记: {name}")
                else:
                    print(f"(x) 未找到: {name}")
            else:
                print("(记忆系统不可用)")
            continue
        if q == "/reset":
            agent.reset()
            agent.governor = agent._make_governor()
            print("上下文已重置（含拒绝计数和暂停状态）"); continue
        # ── /context — 上下文容量 + 缓存统计（参考 Claude Code /context）──
        if q == "/context":
            ctx = agent.context_tokens
            lim = agent.context_limit
            pct = agent.context_pct
            in_pct = agent.input_tokens_pct
            color = term.GREEN if pct < 50 else (term.YELLOW if pct < 80 else term.RED)
            msgs = len(agent._ctx)
            # 格式化容量显示
            def _fmt_tok(n):
                if n >= 1_000_000: return f"{n / 1_000_000:.1f}M"
                if n >= 1_000: return f"{n // 1000}K"
                return str(n)
            print(f"  {term.CYAN}╭{'─'*46}╮{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  📊 上下文容量                                {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  消息数:    {term.BOLD}{msgs}{term.RESET} 条                          {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  Token:     {color}{ctx:,}{term.RESET} / {term.GRAY}{lim:,}{term.RESET}  ({color}{pct}%{term.RESET})          {term.CYAN}│{term.RESET}")
            # 进度条
            bar_len = 30; filled = int(bar_len * pct / 100)
            bar = f"{color}{'█' * filled}{term.GRAY}{'░' * (bar_len - filled)}{term.RESET}"
            print(f"  {term.CYAN}│{term.RESET}  [{bar}]                       {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  📐 Token 预算                                {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
            in_color = term.GREEN if in_pct < 80 else (term.YELLOW if in_pct < 90 else term.RED)
            print(f"  {term.CYAN}│{term.RESET}  输入上限:  {in_color}{_fmt_tok(agent.max_input_tokens)}{term.RESET}  (已用 {in_color}{in_pct}%{term.RESET})           {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  输出上限:  {term.GREEN}{_fmt_tok(agent.max_tokens)}{term.RESET}                              {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  上下文窗:  {term.DIM}{_fmt_tok(lim)}{term.RESET}  (输入+输出+安全余量)        {term.CYAN}│{term.RESET}")
            cs = agent.cache_stats
            if cs["calls"] > 0:
                print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
                print(f"  {term.CYAN}│{term.RESET}  ⚡ 缓存统计                                  {term.CYAN}│{term.RESET}")
                print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
                print(f"  {term.CYAN}│{term.RESET}  API 调用:  {term.BOLD}{cs['calls']}{term.RESET} 次                             {term.CYAN}│{term.RESET}")
                hit_rate = cs['hit_rate']
                hit_color = term.GREEN if hit_rate > 80 else (term.YELLOW if hit_rate > 50 else term.RED)
                print(f"  {term.CYAN}│{term.RESET}  缓存命中:  {hit_color}{hit_rate:.0f}%{term.RESET}  ({cs['cache_hits']}/{cs['calls']})                       {term.CYAN}│{term.RESET}")
                # 命中率进度条
                hit_bar_len = 20; hit_filled = int(hit_bar_len * hit_rate / 100)
                hit_bar = f"{hit_color}{'█' * hit_filled}{term.GRAY}{'░' * (hit_bar_len - hit_filled)}{term.RESET}"
                print(f"  {term.CYAN}│{term.RESET}  [{hit_bar}]                     {term.CYAN}│{term.RESET}")
                print(f"  {term.CYAN}│{term.RESET}  输入 token: {term.DIM}{cs['total_input_tokens']:,}{term.RESET}                          {term.CYAN}│{term.RESET}")
                if cs['total_cached_tokens'] > 0:
                    print(f"  {term.CYAN}│{term.RESET}  缓存 token: {term.GREEN}{cs['total_cached_tokens']:,}{term.RESET}                          {term.CYAN}│{term.RESET}")
            # 知识库状态
            kb_path = os.path.join(os.getcwd(), "CORTEX.md")
            kb_status = f"{term.GREEN}已加载{term.RESET}" if os.path.isfile(kb_path) else f"{term.GRAY}未创建{term.RESET}"
            print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  📚 知识库                                    {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}├{'─'*46}┤{term.RESET}")
            print(f"  {term.CYAN}│{term.RESET}  CORTEX.md: {kb_status}                          {term.CYAN}│{term.RESET}")
            print(f"  {term.CYAN}╰{'─'*46}╯{term.RESET}")
            continue
        # ── /kb — 查看/编辑知识库 ──
        if q == "/kb":
            kb_path = os.path.join(os.getcwd(), "CORTEX.md")
            if os.path.isfile(kb_path):
                with open(kb_path, "r", encoding="utf-8") as f:
                    content = f.read()
                lines = content.split("\n")
                print(f"  {term.CYAN}CORTEX.md ({len(lines)} 行, {len(content)} 字符){term.RESET}")
                sep_line = "─" * 40
                print(f"  {term.GRAY}{sep_line}{term.RESET}")
                for line in lines[:20]:
                    print(f"  {term.GRAY}{line}{term.RESET}")
                if len(lines) > 20:
                    print(f"  {term.GRAY}... ({len(lines) - 20} 行省略) ...{term.RESET}")
                print(f"\n  编辑: 直接修改 CORTEX.md 文件即可")
                print(f"  支持 @import 导入其他文件")
            else:
                print(f"  (CORTEX.md 不存在)")
                print(f"  创建: /init 或手动创建项目根目录的 CORTEX.md")
            continue
        # ── /init — 初始化项目 CORTEX.md（参考 Claude Code /init）──
        if q == "/init":
            print(f"{term.CYAN}正在分析项目...{term.RESET}")
            py_files = _glob.glob("*.py") + _glob.glob("tools_*.py") + _glob.glob("*.md")
            py_count = len(_glob.glob("*.py"))
            print(f"  发现 {py_count} 个 Python 文件")
            if os.path.isfile("CORTEX.md"):
                print(f"  CORTEX.md 已存在 — 跳过创建")
            else:
                print(f"  创建 CORTEX.md...")
            print(f"  提示: 使用 @CORTEX.md 查看/编辑项目记忆")
            continue
        # ── /goal — 持久化目标（参考 Claude Code /goal）──
        if q == "/goal":
            g = agent.goal
            if g: print(f"{term.CYAN}当前目标:{term.RESET}\n  {g}")
            else: print("(未设置目标)\n用法: /goal <描述>  设置目标\n      /goal clear   清除目标")
            continue
        if q.startswith("/goal "):
            gtext = q.split(" ", 1)[1].strip()
            if gtext.lower() in ("clear", "stop", "reset", "cancel", "none"):
                agent.set_goal("")
                print("目标已清除")
            else:
                result = agent.set_goal(gtext)
                print(f"{term.CYAN}目标已设置:{term.RESET}\n  {result}")
            continue
        # ── /plan — 规划模式（参考 Claude Code /plan）──
        if q.startswith("/plan"):
            plan_desc = q.split(" ", 1)[1].strip() if " " in q else ""
            plan_msg = "[规划模式] 请先分析问题，制定详细的实施方案，不要立即编写代码。"
            if plan_desc:
                plan_msg += f"\n\n任务: {plan_desc}"
            print(f"{term.CYAN}进入规划模式...{term.RESET}")
            ans = agent.run(plan_msg)
            if args.no_stream: print(ans)
            continue
        # ── /skills — 列出技能（参考 Claude Code /skills）──
        if q in ("/skills", "/skill"):
            cats = agent.skill_mgr.list_by_category()
            print(f"{term.CYAN}可用技能 ({len(agent.skill_mgr.skills)} 个):{term.RESET}\n")
            for cat, skills in sorted(cats.items()):
                print(f"  {term.YELLOW}[{cat}]{term.RESET}")
                for s in skills:
                    print(f"    {term.CYAN}{s.name:<20s}{term.RESET} — {s.description}")
            print(f"\n用法: /skill <name>  调用技能")
            continue
        # ── /subagents — 查看子代理结果 ──
        if q in ("/subagents", "/sub"):
            results = getattr(agent, '_subagent_results', [])
            if not results:
                print("(无子代理记录 — 派遣子代理后可在此查看结果)")
            else:
                print(f"{term.CYAN}子代理记录 ({len(results)} 个):{term.RESET}\n")
                for r in results:
                    icon = f"{term.GREEN}✓{term.RESET}" if r.get('success') else f"{term.RED}✗{term.RESET}"
                    time_s = f"{r.get('latency_ms', 0)/1000:.1f}s"
                    task = r.get('task', '')[:40]
                    preview = r.get('answer_preview', '').replace('\n', ' ').strip()[:60]
                    print(f"  {term.CYAN}#{r['id']}{term.RESET} {icon} {term.GRAY}[{time_s}]{term.RESET} {task}")
                    if r.get('skill'): print(f"       {term.YELLOW}skill:{term.RESET} {r['skill']}")
                    tc = r.get('tool_calls', [])
                    if tc: print(f"       {term.GRAY}工具调用: {len(tc)} 次{term.RESET}")
                    if preview: print(f"       {term.GRAY}{preview}{term.RESET}")
                print(f"\n用 {term.CYAN}/subagent <id>{term.RESET} 查看完整输出")
            continue
        # ── /subagent <id> — 查看子代理详情 ──
        if q.startswith("/subagent ") or q.startswith("/sub "):
            try: sid = int(q.split()[1])
            except (ValueError, IndexError):
                print("用法: /subagent <id>"); continue
            results = getattr(agent, '_subagent_results', [])
            r = next((x for x in results if x['id'] == sid), None)
            if not r:
                print(f"(x) 子代理 #{sid} 不存在。用 /subagents 查看列表")
            else:
                print(f"{term.CYAN}═══ 子代理 #{r['id']} ═══{term.RESET}")
                print(f"  任务: {r.get('task', '')}")
                if r.get('skill'): print(f"  技能: {r['skill']}")
                if r.get('tools'): print(f"  工具: {r['tools']}")
                status = "✓ 成功" if r.get('success') else "✗ 失败"
                print(f"  状态: {status}  耗时: {r.get('latency_ms', 0)/1000:.1f}s")
                tc = r.get('tool_calls', [])
                print(f"  工具调用: {len(tc)} 次")
                if tc:
                    print(f"\n{term.GRAY}── 工具调用历史 ──{term.RESET}")
                    for t in tc:
                        ti = f"{term.GREEN}✓{term.RESET}" if t.get('success') else f"{term.RED}✗{term.RESET}"
                        tp = t.get('result', '').replace('\n', ' ').strip()[:80]
                        print(f"  {ti} {term.CYAN}{t.get('name', '?')}{term.RESET} {term.GRAY}[{t.get('latency_ms', 0):.0f}ms]{term.RESET} {tp}")
                print(f"\n{term.GRAY}── 完整输出 ──{term.RESET}")
                print(r.get('result', ''))
            continue
        # ── /skill <name> — 调用技能 ──
        if q.startswith("/skill "):
            sname = q.split(" ", 1)[1].strip()
            skill = agent.skill_mgr.get(sname)
            if not skill:
                print(f"(x) 未知技能: {sname}\n使用 /skills 查看可用技能列表")
                continue
            print(f"{term.CYAN}技能已加载: {skill.name}{term.RESET} — {skill.description}")
            prompt = skill.to_prompt()
            ans = agent.run(prompt)
            if args.no_stream: print(ans)
            continue
        # ── @file — 文件引用（参考 Claude Code @mention）──
        if q.startswith("@"):
            fname = q[1:].strip().split()[0]
            rest = q[len(fname)+1:].strip()
            # 拒绝明显的路径穿越
            if ".." in fname or fname.startswith("/") or fname.startswith("\\"):
                print(f"(x) @引用不支持路径穿越: {fname}")
                continue
            matches = _glob.glob(f"**/{fname}", recursive=True) or _glob.glob(f"**/{fname}*", recursive=True)
            if matches:
                match = matches[0]
                # 安全检查：必须在项目目录内
                match_real = os.path.realpath(match)
                cwd_real = os.path.realpath(os.getcwd())
                if not match_real.startswith(cwd_real + os.sep) and match_real != cwd_real:
                    print(f"(x) @引用越权: {match}")
                    continue
                try:
                    with open(match, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()[:3000]
                    ctx_msg = f"[文件引用: {match}]\n\n```\n{content}\n```"
                    if rest:
                        ctx_msg += f"\n\n{rest}"
                    print(f"{term.GRAY}@{match} ({len(content)} 字符){term.RESET}")
                    ans = agent.run(ctx_msg)
                    if args.no_stream: print(ans)
                except Exception as e:
                    print(f"(x) 读取失败: {e}")
            else:
                # 没有匹配文件 — 可能是 MCP @resource 或普通输入，直接传给 agent
                ans = agent.run(q)
                if args.no_stream: print(ans)
            continue
        try:
            ans = agent.run_long(q, max_rounds=args.max_rounds) if args.long else agent.run(q, max_steps=args.max_steps, keep_history=True)
            if args.no_stream: print(ans)
        except KeyboardInterrupt:
            print(f"\n{term.YELLOW}中断{term.RESET}")
        except Exception as e:
            print(f"\n{term.RED}[ERROR] {e}{term.RESET}")


if __name__ == "__main__":
    main()
