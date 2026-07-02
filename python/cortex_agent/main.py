"""
Cortex Agent CLI — 入口 + 工厂函数
用法:
  python main.py                          # 交互 REPL（默认恢复上次会话）
  python main.py --model pro              # 指定模型
  python main.py --work-dir ./ws          # 工作目录
  python main.py -q "search for Python"   # 单次查询
  python main.py --no-stream              # 关闭流式输出
  python main.py --new-session            # 强制新会话
  python main.py --resume <SESSION_ID>    # 恢复到指定会话
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
del _


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
    """首次运行配置向导。"""
    t = Terminal(enabled=True)
    t._w(f"\n{t.CYAN}{'='*50}{t.RESET}\n")
    t._w(f"  🎉 欢迎使用 Cortx！\n")
    t._w(f"  这是第一次运行，需要配置 AI 模型。\n")
    t._w(f"{t.CYAN}{'='*50}{t.RESET}\n\n")

    # 1. Provider
    providers = {"1": "deepseek", "2": "openai"}
    t._w(f"  {t.YELLOW}选择模型提供商:{t.RESET}\n")
    t._w(f"    [1] DeepSeek (推荐，国内可用)\n")
    t._w(f"    [2] OpenAI\n")
    choice = input(f"  {t.GREEN}请选择 (1/2):{t.RESET} ").strip() or "1"
    provider = providers.get(choice, "deepseek")

    # 2. API Key
    t._w(f"\n  {t.YELLOW}输入 API Key:{t.RESET}\n")
    t._w(f"  {t.GRAY}(DeepSeek: https://platform.deepseek.com/api_keys){t.RESET}\n")
    t._w(f"  {t.GRAY}(OpenAI: https://platform.openai.com/api-keys){t.RESET}\n")
    api_key = input(f"  {t.GREEN}API Key:{t.RESET} ").strip()
    while not api_key:
        t._w(f"  {t.RED}API Key 不能为空{t.RESET}\n")
        api_key = input(f"  {t.GREEN}API Key:{t.RESET} ").strip()

    # 3. Model
    models = {"deepseek": {"1": ("pro", "deepseek-v4-pro"), "2": ("flash", "deepseek-v4-flash")},
              "openai": {"1": ("gpt-4o", "gpt-4o"), "2": ("gpt-4o-mini", "gpt-4o-mini")}}
    t._w(f"\n  {t.YELLOW}选择模型:{t.RESET}\n")
    for k, (alias, name) in models.get(provider, {}).items():
        t._w(f"    [{k}] {alias} ({name})\n")
    m_choice = input(f"  {t.GREEN}请选择 (1/2):{t.RESET} ").strip() or "1"
    model_alias, model_name = models.get(provider, {}).get(m_choice, ("pro", "deepseek-v4-pro"))

    # 4. Save
    user_path = os.path.join(os.path.expanduser("~"), ".cortex", "settings.json")
    new_settings = {
        "model": model_alias,
        "provider": provider,
        "providers": {provider: {"api_key": api_key, "base_url": f"https://api.{provider}.com/v1",
                                  "models": {model_alias: model_name}}},
        "max_steps": 10, "context_limit": 1000000, "permission_mode": "standard",
        "auto_extract_memory": True, "memory_enabled": True, "sessions_enabled": True,
    }
    os.makedirs(os.path.dirname(user_path), exist_ok=True)
    with open(user_path, "w", encoding="utf-8") as f:
        json.dump(new_settings, f, ensure_ascii=False, indent=2)

    t._w(f"\n  {t.GREEN}✅ 配置已保存到 {user_path}{t.RESET}\n")
    t._w(f"  {t.CYAN}启动 Cortx...{t.RESET}\n\n")

    config.api_key = api_key
    config.model = model_name
    LLMProvider.setup(new_settings["providers"], provider)
    return config


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
    p.add_argument("--max-steps", type=int, default=10)
    p.add_argument("--no-stream", action="store_true", help="关闭流式输出")
    p.add_argument("--query","-q", default=None, help="单次查询")
    p.add_argument("--resume", default=None, metavar="SESSION_ID", help="恢复到指定会话")
    p.add_argument("--list-sessions", action="store_true", help="列出已保存的会话")
    p.add_argument("--new-session", action="store_true", help="强制创建新会话")
    p.add_argument("--init-config", action="store_true", help="创建默认 .cortex/settings.json")
    p.add_argument("--mode", default=None, choices=["standard","auto-edit","yolo"],
                   help="权限模式: standard|auto-edit|yolo")
    args = p.parse_args()

    if args.version:
        print(f"cortx {__import__('cortex_agent').__version__} (Python)")
        return

    if args.update:
        import subprocess, sys as _sys
        print(f"当前: cortx {__import__('cortex_agent').__version__}")
        print("正在更新...")
        _sys.exit(subprocess.call([_sys.executable, "-m", "pip", "install", "cortx", "--upgrade"]))

    if args.init_config:
        cfg_path = os.path.join(os.getcwd(), ".cortex", "settings.json")
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

    agent = create_agent(model=args.model if args.model != "flash" else None,
                         work_dir=args.work_dir, max_steps=args.max_steps, term=term)
    if args.mode:
        agent.config.permission_mode = args.mode
    wd = agent.work_dir

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
    if args.resume:
        agent.init_session(session_id=args.resume, resume=True)
    elif args.new_session:
        agent.init_session(resume=False)
    else:
        agent.init_session(resume=True)  # 默认尝试恢复

    if term.enabled:
        sid_display = ""
        if agent.session_id:
            sid_display = agent.session_id[:20] + "..." if len(agent.session_id) > 20 else agent.session_id
        term.banner(agent.model, len(registry.schemas), wd,
                    session_id=sid_display, mode=agent.config.permission_mode)

    # ── Skills 系统通过 agent.skill_mgr 访问 ──
    if args.query:
        ans = agent.run(args.query)
        if args.no_stream: print(ans)
        t = agent.last_trace()
        if t and t.steps: print(f"\n[审计] {len(t.steps)} 步, {sum(s.latency_ms for s in t.steps):.0f}ms")
        return

    # REPL
    while True:
        mode_label = {"standard": f"{term.GREEN}s{term.RESET}", 
                      "auto-edit": f"{term.YELLOW}a{term.RESET}", 
                      "yolo": f"{term.RED}y{term.RESET}"}.get(agent.config.permission_mode, "?")
        ctx_pct = agent.context_pct
        ctx_color = term.GREEN if ctx_pct < 50 else (term.YELLOW if ctx_pct < 80 else term.RED)
        try: q = input(f"\n{term.GREEN}[{mode_label} {ctx_color}{ctx_pct}%{term.RESET}{term.GREEN}]{term.RESET}> ").strip()
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
            print(f"  {term.CYAN}/init{term.RESET}           初始化项目 CORTEX.md")
            print(f"  {term.CYAN}/goal [目标]{term.RESET}    设置/查看持久化目标")
            print(f"  {term.CYAN}/plan [描述]{term.RESET}   进入规划模式")
            print(f"  {term.CYAN}/context{term.RESET}       上下文容量 + 缓存命中率")
            print(f"  {term.CYAN}/kb{term.RESET}            查看项目知识库 CORTEX.md")
            print(f"  {term.CYAN}═══ 技能系统 ═══{term.RESET}")
            print(f"  {term.CYAN}/skills{term.RESET}         列出所有可用技能")
            print(f"  {term.CYAN}/skill <name>{term.RESET}   调用技能（如 /skill code-review）")
            print(f"  {term.CYAN}═══ 工具 & 模型 ═══{term.RESET}")
            print(f"  {term.CYAN}/m, /model [pro]{term.RESET}  切换模型")
            print(f"  {term.CYAN}/mode [s|a|y]{term.RESET}   切换权限模式 (Shift+Tab)")
            print(f"  {term.CYAN}/t, /tools{term.RESET}       列出工具")
            print(f"  {term.CYAN}═══ 审计 & 调试 ═══{term.RESET}")
            print(f"  {term.CYAN}/trace{term.RESET}          最后轨迹")
            print(f"  {term.CYAN}/a, /audit{term.RESET}      审计轨迹")
            print(f"  {term.CYAN}/reset{term.RESET}          重置上下文")
            print(f"  {term.CYAN}═══ 会话 & 记忆 ═══{term.RESET}")
            print(f"  {term.CYAN}/s, /save{term.RESET}       保存会话")
            print(f"  {term.CYAN}/ls, /sessions{term.RESET}  列出会话")
            print(f"  {term.CYAN}/mem, /memory{term.RESET}   列记忆")
            print(f"  {term.CYAN}/forget <name>{term.RESET}  删除记忆")
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
        # ── Permission mode switching (参考 Claude Code Shift+Tab / Codex /permissions) ──
        if q in ("/mode", "/permissions"):
            m = agent.config.permission_mode
            print(f"当前: {m}\n可用: {term.GREEN}s/standard{term.RESET} | {term.YELLOW}a/auto-edit{term.RESET} | {term.RED}y/yolo{term.RESET}")
            print(f"快捷键: Shift+Tab 循环切换")
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
        if q.startswith("/resume ") or q.startswith("/r "):
            target = q.split(" ", 1)[1].strip()
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
            color = term.GREEN if pct < 50 else (term.YELLOW if pct < 80 else term.RED)
            msgs = len(agent._ctx)
            print(f"  {term.CYAN}═══ 上下文容量 ═══{term.RESET}")
            print(f"  消息数:  {msgs} 条")
            print(f"  Token:   {color}{ctx:,} / {lim:,}{term.RESET}  ({color}{pct}%{term.RESET})")
            bar_len = 30; filled = int(bar_len * pct / 100)
            bar = f"{color}{'█' * filled}{term.GRAY}{'░' * (bar_len - filled)}{term.RESET}"
            print(f"  [{bar}]")
            cs = agent.cache_stats
            if cs["calls"] > 0:
                print(f"  {term.CYAN}═══ 缓存统计 ═══{term.RESET}")
                print(f"  API 调用: {cs['calls']} 次")
                hit_color = term.GREEN if cs['hit_rate'] > 80 else (term.YELLOW if cs['hit_rate'] > 50 else term.RED)
                print(f"  缓存命中: {hit_color}{cs['hit_rate']:.0f}%{term.RESET}  ({cs['cache_hits']}/{cs['calls']})")
                print(f"  输入 token: {cs['total_input_tokens']:,}")
                if cs['total_cached_tokens'] > 0:
                    print(f"  缓存 token: {cs['total_cached_tokens']:,}")
            # 知识库状态
            kb_path = os.path.join(os.getcwd(), "CORTEX.md")
            kb_status = f"{term.GREEN}已加载{term.RESET}" if os.path.isfile(kb_path) else f"{term.GRAY}未创建{term.RESET}"
            print(f"  {term.CYAN}═══ 知识库 ═══{term.RESET}")
            print(f"  CORTEX.md: {kb_status}  ({kb_path})")
            print(f"  使用 /kb 查看或 @CORTEX.md 引用内容")
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
            ans = agent.run(q, max_steps=args.max_steps, keep_history=True)
            if args.no_stream: print(ans)
        except KeyboardInterrupt:
            print(f"\n{term.YELLOW}中断{term.RESET}")
        except Exception as e:
            print(f"\n{term.RED}[ERROR] {e}{term.RESET}")


if __name__ == "__main__":
    main()
