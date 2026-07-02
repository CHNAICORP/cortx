"""
Cortex Agent MCP 工具 — Model Context Protocol 客户端
═══════════════════════════════════════════════════════

mcp_list_servers / mcp_list_tools / mcp_call_tool
+ _split_args / _resolve_command / _mcp_exchange
"""

import os, re, sys, json, shlex, platform, subprocess
from .cortex_agent import registry, RiskLevel, Capability


# ══════════════════════════════════════════════════════════════
# MCP (Model Context Protocol) 客户端
# ══════════════════════════════════════════════════════════════

def _split_args(args_str: str) -> list:
    """跨平台安全拆分命令行参数字符串。Windows 上用 posix=False 防止反斜杠被转义。"""
    if not args_str:
        return []
    return shlex.split(args_str, posix=(platform.system() != "Windows"))


def _resolve_command(cmd: list) -> list:
    """Windows: 用 shutil.which 解析命令路径（.cmd 后缀等）。"""
    import shutil as _sh
    if platform.system() == "Windows":
        resolved = _sh.which(cmd[0])
        if resolved and resolved != cmd[0]:
            cmd[0] = resolved
        elif not resolved and not cmd[0].endswith(".cmd"):
            alt = cmd[0] + ".cmd"
            if _sh.which(alt):
                cmd[0] = alt
    return cmd


def _mcp_exchange(server_cmd: list, requests: list, timeout: float = 15.0) -> list:
    """启动 MCP 服务器，发送请求序列，返回解析后的 JSON 响应列表。
    
    协议：先写全部请求 → 关闭 stdin → communicate() 读取全部响应。
    这样避免了 stdio 管道上的死锁。
    """
    import subprocess as _sp, json as _j
    proc = _sp.Popen(server_cmd, stdin=_sp.PIPE, stdout=_sp.PIPE,
                     stderr=_sp.PIPE, text=True)
    # 写入所有请求（含换行）
    for req in requests:
        proc.stdin.write(req + "\n")
    proc.stdin.flush()
    proc.stdin.close()
    # 读取全部响应
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except _sp.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
    # 解析 JSON 行
    responses = []
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            responses.append(_j.loads(line))
        except _j.JSONDecodeError:
            pass
    return responses


@registry.register(
    "列出已配置的 MCP 服务器 + 注册表中可用的服务器。\n"
    "从 settings.json 读取 mcpServers 段 + MCP_REGISTRY 内置注册表。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def mcp_list_servers(work_dir: str) -> str:
    from . import config as cfg
    settings = cfg.load_settings()
    configured = settings.get("mcpServers", {})
    lines = []
    # 1. 已配置的 server
    if configured:
        lines.append(f"=== 已配置 ({len(configured)} 个) ===\n")
        for name, cfg_s in configured.items():
            cmd = cfg_s.get("command", cfg_s.get("url", "?"))
            args = " ".join(cfg_s.get("args", []))
            desc = cfg_s.get("description", "")
            status = "🟢 已配置"
            lines.append(f"  [{name}] {cmd} {args}")
            if desc:
                lines.append(f"         {desc}")
    else:
        lines.append("=== 已配置 (0 个) ===\n  (无)\n")
    # 2. 注册表中可用但未配置的 server
    available = {k: v for k, v in MCP_REGISTRY.items() if k not in configured}
    if available:
        lines.append(f"\n=== 注册表可用 ({len(available)} 个，未安装) ===\n")
        for key, info in available.items():
            req = info.get("requires", "?")
            icon = {"none": "🟢", "node": "🟡", "python": "🟡"}.get(req, "🔑")
            lines.append(f"  {icon} {key:<20s} — {info['description'][:55]}")
    lines.append(f"\n安装: mcp_install(server=\"<name>\")  |  试用: mcp_quick(server=\"<name>\")")
    lines.append(f"注册表: mcp_registry()")
    return "\n".join(lines)


@registry.register(
    "启动 MCP 服务器并列出其提供的所有工具。\n"
    "用法: mcp_list_tools(server_command=\"npx\", server_args=\"-y @playwright/mcp@latest\")",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def mcp_list_tools(work_dir: str, server_command: str, server_args: str = "") -> str:
    import json as _j
    cmd = [server_command] + _split_args(server_args) if server_args else [server_command]
    cmd = _resolve_command(cmd)
    try:
        init = _j.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "cortex-agent", "version": "1.0"}}})
        notified = _j.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
        list_req = _j.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        responses = _mcp_exchange(cmd, [init, notified, list_req])
        # 从响应中提取 tools
        tools = []
        for msg in responses:
            if "result" in msg and "tools" in msg.get("result", {}):
                tools = msg["result"]["tools"]
        if not tools:
            return f"(x) 服务器未返回工具列表 (收到 {len(responses)} 条响应)"
        out = [f"来自 {server_command} 的 {len(tools)} 个工具:\n"]
        for t in tools:
            out.append(f"  ● {t.get('name','?')}: {t.get('description','')[:80]}")
        return "\n".join(out)
    except FileNotFoundError:
        return f"(x) 命令不存在: {server_command}"
    except Exception as e:
        return f"(x) MCP 错误: {e}"


@registry.register(
    "调用 MCP 服务器上的工具。\n"
    "用法: mcp_call_tool(server_command=\"npx\", server_args=\"-y @playwright/mcp@latest\", "
    "tool_name=\"browser_navigate\", tool_args='{\"url\":\"https://example.com\"}')",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def mcp_call_tool(work_dir: str, server_command: str, server_args: str = "",
                  tool_name: str = "", tool_args: str = "{}") -> str:
    import json as _j
    cmd = [server_command] + _split_args(server_args) if server_args else [server_command]
    cmd = _resolve_command(cmd)
    # 解析 tool_args
    try:
        args_dict = _j.loads(tool_args) if tool_args else {}
    except _j.JSONDecodeError:
        return f"(x) tool_args 不是有效的 JSON: {tool_args[:100]}"
    try:
        init = _j.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "cortex-agent", "version": "1.0"}}})
        notified = _j.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
        call_req = _j.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": tool_name, "arguments": args_dict}})
        responses = _mcp_exchange(cmd, [init, notified, call_req])
        # 提取最后一个包含 result 的响应
        for msg in reversed(responses):
            if "result" in msg:
                result = msg["result"]
                content = result.get("content", [])
                if isinstance(content, list):
                    texts = [c.get("text", str(c)) for c in content if isinstance(c, dict)]
                    if texts:
                        return "\n".join(texts)[:3000]
                return _j.dumps(result, ensure_ascii=False)[:3000]
        return f"(x) 无有效响应 (收到 {len(responses)} 条)"
    except FileNotFoundError:
        return f"(x) 命令不存在: {server_command}"
    except Exception as e:
        return f"(x) MCP 调用失败: {e}"


# ══════════════════════════════════════════════════════════════
# MCP Server 注册表 — 已知开源 MCP Server 一键安装
# ══════════════════════════════════════════════════════════════

MCP_REGISTRY = {
    "playwright": {
        "name": "Playwright MCP",
        "description": "浏览器自动化（Microsoft 官方）— 页面导航/截图/表单填写/数据提取",
        "category": "browser",
        "install": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"]},
        "requires": "node",
    },
    "fetch": {
        "name": "Fetch MCP",
        "description": "HTTP 抓取 + HTML→Markdown 转换，适合网页内容提取",
        "category": "network",
        "install": {"command": sys.executable, "args": ["-m", "pip", "install", "mcp-server-fetch"]},
        "run": {"command": sys.executable, "args": ["-m", "mcp_server_fetch"]},
        "requires": "python",
    },
    "filesystem": {
        "name": "Filesystem MCP",
        "description": "安全文件系统操作 — 读写/列表/搜索（可限制目录范围）",
        "category": "filesystem",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"]},
        "requires": "node",
    },
    "sqlite": {
        "name": "SQLite MCP",
        "description": "本地 SQLite 数据库查询与分析",
        "category": "database",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite"]},
        "requires": "node",
    },
    "postgres": {
        "name": "PostgreSQL MCP",
        "description": "PostgreSQL 只读查询 — Schema 检查 + SQL 执行",
        "category": "database",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"]},
        "requires": "node",
    },
    "chrome-devtools": {
        "name": "Chrome DevTools MCP",
        "description": "Chrome DevTools 协议直连 — 性能分析/调试/截图/DOM 操作",
        "category": "browser",
        "install": {"command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"]},
        "requires": "node",
    },
    "docker": {
        "name": "Docker MCP",
        "description": "Docker 容器与镜像管理",
        "category": "infra",
        "install": {"command": "npx", "args": ["-y", "@cpecf/docker-mcp"]},
        "requires": "node",
    },
    "context7": {
        "name": "Context7",
        "description": "实时库/框架文档查询 — 解决 LLM 知识截止问题",
        "category": "knowledge",
        "install": {"url": "https://mcp.context7.com/mcp"},
        "requires": "none",
    },
    "github": {
        "name": "GitHub MCP",
        "description": "GitHub PR/Issue/代码搜索/仓库管理",
        "category": "devtools",
        "install": {"url": "https://api.githubcopilot.com/mcp/"},
        "requires": "github_token",
    },
    "slack": {
        "name": "Slack MCP",
        "description": "Slack 频道消息发送/文件上传/工作流",
        "category": "communication",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"]},
        "requires": "slack_token",
    },
    "memory": {
        "name": "Memory MCP",
        "description": "持久化知识图谱记忆系统",
        "category": "knowledge",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]},
        "requires": "node",
    },
    "brave-search": {
        "name": "Brave Search MCP",
        "description": "Brave Search API 联网搜索（需 API Key）",
        "category": "network",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-brave-search"]},
        "requires": "brave_api_key",
    },
    "puppeteer": {
        "name": "Puppeteer MCP",
        "description": "Puppeteer 浏览器自动化 — 轻量级网页交互",
        "category": "browser",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-puppeteer"]},
        "requires": "node",
    },
    "everart": {
        "name": "EverArt MCP",
        "description": "AI 图像生成（通过 EverArt API）",
        "category": "media",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everart"]},
        "requires": "everart_api_key",
    },
    "sequential-thinking": {
        "name": "Sequential Thinking MCP",
        "description": "多步推理与思维链增强",
        "category": "reasoning",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]},
        "requires": "node",
    },
}


@registry.register(
    "列出已知的 MCP Server 注册表，包含安装命令和分类。\n"
    "用法: mcp_registry(category=\"\")  — 留空列出全部，指定分类筛选",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def mcp_registry(work_dir: str, category: str = "") -> str:
    if category:
        servers = {k: v for k, v in MCP_REGISTRY.items() if v.get("category") == category}
        if not servers:
            cats = sorted(set(v["category"] for v in MCP_REGISTRY.values()))
            return f"(x) 未知分类: {category}\n可用分类: {', '.join(cats)}"
    else:
        servers = MCP_REGISTRY
    lines = [f"MCP Server 注册表 ({len(servers)} 个):\n"]
    by_cat = {}
    for key, info in servers.items():
        cat = info.get("category", "other")
        by_cat.setdefault(cat, []).append((key, info))
    for cat in sorted(by_cat):
        lines.append(f"\n{'─'*40}")
        lines.append(f"  [{cat}]")
        for key, info in by_cat[cat]:
            req = info.get("requires", "?")
            icon = {"none": "🟢", "node": "🟡", "python": "🟡", 
                    "github_token": "🔑", "slack_token": "🔑",
                    "brave_api_key": "🔑", "everart_api_key": "🔑"}.get(req, "🔑")
            lines.append(f"  {icon} {key:<20s} — {info['description'][:60]}")
            if req not in ("none", "node", "python"):
                lines.append(f"     {' ' * 22} 需要: {req}")
    lines.append(f"\n{'─'*40}")
    lines.append(f"\n安装: mcp_install(server=\"playwright\")")
    lines.append(f"快速试用: mcp_quick(server=\"fetch\")")
    return "\n".join(lines)


@registry.register(
    "一键安装 MCP Server（从注册表）。自动执行 pip/npm 安装命令。\n"
    "用法: mcp_install(server=\"playwright\")  — 安装指定 server\n"
    "      mcp_install(server=\"all\")          — 安装所有无需 API Key 的 server",
    risk=RiskLevel.WRITE, capability=Capability.SHELL)
def mcp_install(work_dir: str, server: str = "") -> str:
    if not server:
        return ("请指定要安装的 server:\n"
                "  mcp_install(server=\"playwright\")\n"
                "  mcp_install(server=\"all\")  ← 安装所有免费 server\n"
                f"可用 server: {', '.join(sorted(MCP_REGISTRY.keys()))}")
    if server == "all":
        to_install = [(k, v) for k, v in MCP_REGISTRY.items()
                      if v.get("requires") in ("none", "node", "python")]
    elif server in MCP_REGISTRY:
        to_install = [(server, MCP_REGISTRY[server])]
    else:
        return (f"(x) 未知 server: {server}\n"
                f"可用: {', '.join(sorted(MCP_REGISTRY.keys()))}\n"
                f"使用 mcp_registry() 查看完整列表")
    results = []
    for key, info in to_install:
        install = info.get("install", {})
        if not install:
            url = info.get("url", "")
            if url:
                results.append(f"  {key}: 无需安装（URL 直连: {url}）")
            else:
                results.append(f"  {key}: 无安装命令")
            continue
        cmd = install.get("command", "")
        args = install.get("args", [])
        full_cmd = [cmd] + args if cmd else []
        if not full_cmd:
            results.append(f"  {key}: 无安装命令")
            continue
        try:
            r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=120,
                              encoding='utf-8', errors='replace')
            if r.returncode == 0:
                results.append(f"  ✅ {key}: 安装成功")
            else:
                err = (r.stderr or r.stdout)[:100]
                results.append(f"  ❌ {key}: 安装失败 — {err}")
        except subprocess.TimeoutExpired:
            results.append(f"  ⏰ {key}: 安装超时 (>120s)")
        except FileNotFoundError:
            results.append(f"  ❌ {key}: 命令不存在 ({cmd}) — 请先安装 {info.get('requires', '?')}")
        except Exception as e:
            results.append(f"  ❌ {key}: {e}")
    # 更新 settings.json 配置
    for key, info in to_install:
        _add_mcp_to_settings(key, info)
    return f"安装结果 ({len(to_install)} 个):\n" + "\n".join(results) + \
           "\n\n已安装的 server 已自动添加到 settings.json mcpServers 配置中。"


def _add_mcp_to_settings(key: str, info: dict):
    """将 MCP server 添加到 settings.json 的 mcpServers 段。"""
    from . import config as cfg
    settings_path = os.path.join(os.path.dirname(os.path.abspath(work_dir := '.')), '.cortex', 'settings.json')
    # 尝试找到实际 settings.json
    for candidate in [os.path.join(os.getcwd(), '.cortex', 'settings.json'),
                      os.path.expanduser('~/.cortex/settings.json')]:
        if os.path.isfile(candidate):
            settings_path = candidate
            break
    try:
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
    except Exception:
        settings = {}
    settings.setdefault("mcpServers", {})
    if key not in settings["mcpServers"]:
        run_cfg = info.get("run") or info.get("install") or {}
        entry = {}
        if "command" in run_cfg:
            entry["command"] = run_cfg["command"]
            entry["args"] = run_cfg.get("args", [])
        elif "url" in info:
            entry["url"] = info["url"]
        if entry:
            entry["description"] = info.get("description", "")
            settings["mcpServers"][key] = entry
            os.makedirs(os.path.dirname(settings_path), exist_ok=True)
            with open(settings_path, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)


@registry.register(
    "一键安装并启动 MCP Server，列出其提供的工具。试用的最快方式！\n"
    "用法: mcp_quick(server=\"fetch\")  — 安装+启动+列出工具",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def mcp_quick(work_dir: str, server: str = "") -> str:
    if not server or server not in MCP_REGISTRY:
        return (f"请指定要试用的 server:\n"
                f"  mcp_quick(server=\"fetch\")       ← HTTP 抓取\n"
                f"  mcp_quick(server=\"playwright\")  ← 浏览器自动化\n"
                f"  mcp_quick(server=\"sqlite\")      ← 数据库查询\n"
                f"可用: {', '.join(sorted(MCP_REGISTRY.keys()))}")
    info = MCP_REGISTRY[server]
    # 0. URL-only servers (install dict has url instead of command)
    install = info.get("install", {})
    if "url" in install or ("url" in info and "command" not in install):
        url = install.get("url") or info.get("url", "")
        return (f"=== {info['name']} ===\n{info['description']}\n\n"
                f"此 server 使用 URL 直连: {url}\n"
                f"无需安装，直接在 settings.json 的 mcpServers 中配置即可。\n"
                f"配置示例: {{\"mcpServers\": {{\"{server}\": {{\"url\": \"{url}\"}}}}}}")
    # 1. Quick install if needed
    install_result = ""
    install = info.get("install", {})
    if install:
        cmd = [install["command"]] + install.get("args", [])
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                              encoding='utf-8', errors='replace')
            if r.returncode != 0:
                # Try installing anyway — npx may just need download time
                pass
        except Exception:
            pass  # Try running anyway
    # 2. Determine run command
    run_info = info.get("run") or info.get("install") or {}
    run_cmd = run_info.get("command", "")
    run_args = " ".join(run_info.get("args", []))
    # 3. List tools using the MCP client
    if run_cmd:
        result = mcp_list_tools(work_dir, run_cmd, run_args)
        return f"=== {info['name']} ===\n{info['description']}\n\n{result}"
    elif "url" in info:
        return (f"=== {info['name']} ===\n{info['description']}\n\n"
                f"此 server 使用 URL 直连: {info['url']}\n"
                f"无需安装，直接在 settings.json 中配置即可使用。")
    return f"(x) 无法确定 {server} 的运行方式"
