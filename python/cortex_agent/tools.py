"""
Cortex Agent 工具实现 — 所有工具注册到 registry

24 个 Harness Agent 内置工具:
  文件操作: list_directory, read_file, write_file, edit_file, glob, file_ops, diff_files
  搜索:     grep
  数据库:   execute_sql_query, csv_query
  执行:     run_shell_command, run_python
  网络:     web_search, web_fetch, http_request
  配置:     read_json
  时间:     get_current_time
  记忆:     remember_fact, recall_fact, forget_fact
  任务:     task_create, task_list, task_update
  辅助:     ask_user, python_lint
  Git:      git_status, git_diff, git_commit, git_branch, git_log
  子代理:   spawn_subagent
"""

import os, re, sqlite3, platform, subprocess, datetime, json, csv, io, threading, time
import urllib.parse, urllib.request, urllib.error
from .cortex_agent import registry, RiskLevel, Capability, check_ssrf

_tasks = []  # 模块级简单任务存储

# ── 工具超时配置（可从 AgentConfig.tool_timeout 设置）──
_SHELL_TIMEOUT = 30  # 默认 30 秒
_PYTHON_TIMEOUT = 30  # 默认 30 秒

# 阻塞命令模式（会启动长期运行的进程）
_BLOCKING_COMMAND_PATTERNS = [
    r'\b(npm\s+start|npm\s+run\s+dev|npm\s+run\s+serve)\b',  # npm 启动
    r'\b(node\s+server|python\s+-m\s+http\.server|php\s+-S)\b',  # 服务器启动
    r'\b(git\s+daemon|serve|run\s+server)\b',  # 服务器相关
    r'\b(npx\s+.*serve|npx\s+.*start)\b',  # npx 启动
]

def set_tool_timeout(seconds: int):
    """设置工具执行超时（秒）。0 表示无超时。"""
    global _SHELL_TIMEOUT, _PYTHON_TIMEOUT
    if seconds > 0:
        _SHELL_TIMEOUT = seconds
        _PYTHON_TIMEOUT = seconds


# ══════════════════════════════════════════════════════════════
# 文件操作
# ══════════════════════════════════════════════════════════════

@registry.register("列出目录内的文件和子目录（绝对路径需授权）", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def list_directory(work_dir: str, path: str = "./") -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if not os.path.isdir(d): return f"(x) 目录不存在: {path}"
    items = os.listdir(d)
    if not items: return "(空目录)"
    lines = [f"{'[DIR]' if os.path.isdir(os.path.join(d,x)) else '[   ]'} {x}" for x in sorted(items)]
    return f"({len(items)} 项)\n" + "\n".join(lines)


@registry.register("读取文本文件内容（绝对路径需授权）", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def read_file(work_dir: str, path: str) -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if not os.path.isfile(d): return f"(x) 不存在: {path}"
    if os.path.getsize(d) > 102400: return "(x) 文件过大 (>100KB)"
    with open(d, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()


@registry.register("写入/覆盖文本文件（绝对路径需授权）", risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def write_file(work_dir: str, path: str, content: str) -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    parent = os.path.dirname(d)
    if parent: os.makedirs(parent, exist_ok=True)
    with open(d, "w", encoding="utf-8") as f: f.write(content)
    return f"已写入 {path} ({len(content)} 字符)"


@registry.register("精确编辑文件：查找 old_string 并替换为 new_string", risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def edit_file(work_dir: str, path: str, old_string: str, new_string: str) -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if not os.path.isfile(d): return f"(x) 文件不存在: {path}"
    with open(d, "r", encoding="utf-8") as f: content = f.read()
    if old_string not in content: return f"(x) 未找到匹配文本"
    content = content.replace(old_string, new_string, 1)
    with open(d, "w", encoding="utf-8") as f: f.write(content)
    preview = new_string[:60].replace("\n", "\\n")
    return f"已替换 1 处 → {preview}{'...' if len(new_string) > 60 else ''}"


@registry.register("用通配符模式匹配文件路径", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def glob(work_dir: str, pattern: str) -> str:
    import glob as glob_mod
    base = os.path.realpath(work_dir)
    # 支持 absolute path pattern
    if os.path.isabs(pattern):
        full_pattern = pattern
    else:
        full_pattern = os.path.join(base, pattern)
    matches = glob_mod.glob(full_pattern, recursive=True)
    if not matches: return f"(无匹配: {pattern})"
    matches.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
    head = min(len(matches), 50)
    lines = [f"({len(matches)} 个匹配，显示前 {head} 个)"]
    for fp in matches[:head]:
        try:
            size = os.path.getsize(fp)
        except OSError:
            size = 0
        try:
            rel = os.path.relpath(fp, base)
        except ValueError:
            rel = fp
        lines.append(f"  {rel} ({size:,} bytes)")
    if len(matches) > head: lines.append(f"  ... 还有 {len(matches) - head} 个")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════
# 内容搜索
# ══════════════════════════════════════════════════════════════

@registry.register("在文件中搜索正则模式", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def grep(work_dir: str, pattern: str, path: str = ".", glob_filter: str = "", head: int = 50) -> str:
    import fnmatch
    base = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if os.path.isfile(base): files = [base]
    elif os.path.isdir(base):
        files = []
        for root_dir, _, filenames in os.walk(base):
            for fn in filenames:
                if glob_filter and not fnmatch.fnmatch(fn, glob_filter): continue
                files.append(os.path.join(root_dir, fn))
        files.sort()
    else: return f"(x) 路径不存在: {path}"
    try: regex = re.compile(pattern)
    except re.error as e: return f"(x) 正则错误: {e}"
    results = []
    for fp in files:
        try:
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                for lineno, line in enumerate(f, 1):
                    if regex.search(line):
                        results.append(f"{fp}:{lineno}: {line.rstrip()[:200]}")
                        if len(results) >= head: break
            if len(results) >= head: break
        except (PermissionError, OSError, UnicodeDecodeError):
            pass  # 跳过无法读取的文件
    if not results: return f"(未找到匹配 '{pattern}' 的结果)"
    return f"({len(results)} 条)\n" + "\n".join(results)


# ══════════════════════════════════════════════════════════════
# 数据库
# ══════════════════════════════════════════════════════════════

@registry.register("执行只读 SQL 查询（仅 SELECT）", risk=RiskLevel.SAFE, capability=Capability.DB_READ)
def execute_sql_query(work_dir: str, sql: str) -> str:
    db_path = os.path.join(work_dir, "agent.db")
    db = sqlite3.connect(db_path); db.row_factory = sqlite3.Row
    MAX_ROWS = 50
    try:
        s = sql.strip().rstrip(";")
        cursor = db.execute(s)
        rows = []
        for i, r in enumerate(cursor):
            if i >= MAX_ROWS:
                rows.append({k: f"...(截断，共超过{MAX_ROWS}行)" for k in r.keys()})
                break
            rows.append(dict(r))
        if not rows: return "(空结果)"
        cols = list(rows[0].keys())
        lines = [" | ".join(cols), "-" * len(" | ".join(cols))]
        for r in rows: lines.append(" | ".join(str(v) for v in r.values()))
        return f"({len(rows)} 行{'，已达上限' if len(rows) >= MAX_ROWS else ''})\n" + "\n".join(lines)
    except Exception as e:
        return f"(x) SQL 查询失败: {e}"
    finally: db.close()


# ══════════════════════════════════════════════════════════════
# 命令执行
# ══════════════════════════════════════════════════════════════

@registry.register("执行系统命令（Windows: PowerShell, Linux/Mac: bash）",
                    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def run_shell_command(work_dir: str, command: str) -> str:
    os.makedirs(work_dir, exist_ok=True)
    
    # ── 阻塞命令检测 ──
    for pattern in _BLOCKING_COMMAND_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return f"(x) 检测到阻塞命令: '{command}'\n该命令会启动长期运行的进程（如服务器），无法在工具执行超时内完成。\n\n建议:\n  1. 使用后台运行模式（如 npm start &）\n  2. 使用专门的验证工具检查服务是否正常\n  3. 使用 Ctrl+C 中断当前命令"
    
    is_win = platform.system() == "Windows"
    try:
        args = ["powershell","-NoProfile","-NonInteractive","-Command",command] if is_win else ["bash", "-c", command]
        timeout = _SHELL_TIMEOUT if _SHELL_TIMEOUT > 0 else None
        r = subprocess.run(args, cwd=work_dir, capture_output=True, text=True, timeout=timeout, shell=False,
                          encoding='utf-8', errors='replace')
        out = ((r.stdout or "") + (r.stderr or "")).strip() or "(无输出)"
        return f"exit={r.returncode}\n{out}"
    except subprocess.TimeoutExpired:
        timeout_str = f"{_SHELL_TIMEOUT}s" if _SHELL_TIMEOUT > 0 else "无限制"
        return f"(x) 超时（命令执行超过 {timeout_str}）\n命令: {command}\n\n可能的原因:\n  1. 命令是长期运行的进程（如服务器启动）\n  2. 命令陷入了死循环\n  3. 网络问题导致挂起\n\n建议:\n  1. 检查命令是否为阻塞式启动命令\n  2. 使用 Ctrl+C 中断后重试"
    except Exception as e:
        return f"(x) {e}"


@registry.register("执行 Python 代码（子进程隔离）", risk=RiskLevel.SYSTEM, capability=Capability.PYTHON)
def run_python(work_dir: str, code: str) -> str:
    import tempfile, sys as _sys, os as _os
    try:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8")
        try:
            tmp.write(code); tmp.close()
            timeout = _PYTHON_TIMEOUT if _PYTHON_TIMEOUT > 0 else None
            r = subprocess.run([_sys.executable, tmp.name], cwd=work_dir,
                               capture_output=True, text=True, timeout=timeout,
                               env={**_os.environ, "PYTHONPATH": "", "PATH": _os.environ.get("PATH", "")})
            out = (r.stdout + r.stderr).strip() or "(无输出)"
            return f"exit={r.returncode}\n{out}"
        finally: _os.unlink(tmp.name)
    except subprocess.TimeoutExpired:
        timeout_str = f"{_PYTHON_TIMEOUT}s" if _PYTHON_TIMEOUT > 0 else "无限制"
        return f"(x) 超时（Python 代码执行超过 {timeout_str}）\n\n可能的原因:\n  1. 代码中有无限循环\n  2. 代码长时间等待 I/O\n  3. 代码计算量过大\n\n建议:\n  1. 添加超时控制或退出条件\n  2. 使用 Ctrl+C 中断后重试"
    except Exception as e: return f"(x) Python 沙箱异常: {e}"


# ══════════════════════════════════════════════════════════════
# 时间
# ══════════════════════════════════════════════════════════════

@registry.register("获取当前系统日期时间", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def get_current_time(work_dir: str) -> str:
    now = datetime.datetime.now()
    return now.strftime("%Y-%m-%d %H:%M:%S %A (week %W)")


# ══════════════════════════════════════════════════════════════
# 网络 — 代理感知的 opener（自动读取环境变量 HTTPS_PROXY/HTTP_PROXY）
# ══════════════════════════════════════════════════════════════

def _build_opener():
    """构建带代理支持的 urllib opener。自动从环境变量读取代理配置。"""
    handlers = []
    for proto_key, proxy_key in [("https", "HTTPS_PROXY"), ("https", "https_proxy"),
                                   ("http", "HTTP_PROXY"), ("http", "http_proxy")]:
        proxy_url = os.environ.get(proxy_key, "")
        if proxy_url:
            handlers.append(urllib.request.ProxyHandler({proto_key: proxy_url}))
            break  # 一个代理通常覆盖两种协议
    return urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()


# ══════════════════════════════════════════════════════════════
# 网络
#
# 设计参照 Claude Code 的 WebSearch / WebFetch:
#   web_search → 找页面 (标题+URL+摘要)，支持域名过滤、结果去重
#   web_fetch  → 读内容 (HTML→可读文本)，支持截断控制、元数据提取
#
# Harness Agent 设计哲学:
#   1. 工具即原语 — 搜索和抓取职责分离，LLM 自主决定何时用哪个
#   2. LLM 可控 — 关键参数暴露给 LLM (allowed_domains, max_chars 等)
#   3. 优雅降级 — 多引擎 fallback 链，每步失败有清晰日志
#   4. 结构化输出 — 结果格式统一，便于 LLM 推理
#   5. 可观测性 — 每条结果标注来源引擎
# ══════════════════════════════════════════════════════════════

# 搜索结果缓存 (避免同一查询重复请求)
_search_cache: dict = {}
_SEARCH_CACHE_MAX = 50


def _filter_domains(url: str, allowed: list = None, blocked: list = None) -> bool:
    """检查 URL 的域名是否通过过滤。"""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
        host = host.lower()
        if blocked:
            for d in blocked:
                if host == d.lower() or host.endswith("." + d.lower()):
                    return False
        if allowed:
            for d in allowed:
                if host == d.lower() or host.endswith("." + d.lower()):
                    return True
            return False
        return True
    except Exception:
        return True


def _dedup_results(results: list) -> list:
    """对搜索结果去重 (基于 URL hostname+path)。"""
    seen = set()
    deduped = []
    for item in results:
        url = item.get("url", "")
        try:
            p = urllib.parse.urlparse(url)
            key = (p.hostname or "").lower() + (p.path or "").rstrip("/").lower()
        except Exception:
            key = url.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(item)
    return deduped


def _format_search_results(query: str, engine: str, results: list) -> str:
    """统一格式化搜索结果输出。"""
    if not results:
        return ""
    out = [f'搜索 "{query}" via {engine} ({len(results)} 条):\n']
    for i, r in enumerate(results, 1):
        title = r.get("title", "")[:120]
        url = r.get("url", "")
        snippet = r.get("snippet", "")[:200]
        out.append(f"  [{i}] {title}")
        out.append(f"      🔗 {url}")
        if snippet:
            out.append(f"      {snippet}")
        out.append("")
    return "\n".join(out)


@registry.register(
    "联网搜索网页 — 返回标题、URL 和摘要。找到页面后可用 web_fetch 读取全文。\n"
    "参数:\n"
    "  query           搜索关键词 (必填)\n"
    "  allowed_domains 限定搜索域名，逗号分隔 (可选，如 'github.com,stackoverflow.com')\n"
    "  max_results     最大结果数 (可选，默认 5)\n"
    "用法: web_search(query=\"Python 3.13 新特性\")\n"
    "      web_search(query=\"React hooks\", allowed_domains=\"reactjs.org,github.com\")",
    risk=RiskLevel.SAFE, capability=Capability.NET_SEARCH)
def web_search(work_dir: str, query: str, allowed_domains: str = "",
               max_results: int = 0) -> str:
    """多引擎联网搜索，支持域名过滤和结果去重。

    引擎优先级 (由 settings.json 中 web_search.provider 决定):
      brave       → Brave Search API (付费, 更高精准度)
      tavily      → Tavily Search API (付费, AI 优化摘要)
      serpapi     → SerpAPI / Google (付费, 结果最丰富)
      duckduckgo  → DDG API → DDG Lite → Bing HTML (免费, 默认)
    """
    # ── 解析参数 ──
    cfg = _load_web_search_config()
    provider = cfg.get("provider", "duckduckgo")
    n = int(max_results) if max_results and int(max_results) > 0 else int(cfg.get("max_results", 5))
    timeout = int(cfg.get("timeout", 10))
    opener = _build_opener()
    encoded = urllib.parse.quote(query)

    allowed = [d.strip() for d in allowed_domains.split(",") if d.strip()] if allowed_domains else None
    blocked = ["bing.com", "duckduckgo.com", "google.com", "baidu.com", "csdn.net"]

    # ── 检查缓存 ──
    cache_key = f"{query}|{allowed or ''}|{n}"
    if cache_key in _search_cache:
        cached = _search_cache[cache_key]
        return cached + "\n[缓存命中]"

    raw_results: list = []
    engine_used = ""

    # ── Brave Search API ──
    if provider == "brave" and cfg.get("brave_api_key"):
        try:
            api_url = f"https://api.search.brave.com/res/v1/web/search?q={encoded}&count={n}"
            req = urllib.request.Request(api_url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                "Accept": "application/json",
                "X-Subscription-Token": cfg["brave_api_key"],
                "Accept-Encoding": "gzip",
            })
            with opener.open(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", errors="ignore"))
            for item in (data.get("web", {}).get("results", []) or [])[:n * 2]:
                raw_results.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("description", ""),
                })
            engine_used = "Brave"
        except Exception:
            pass

    # ── Tavily Search API ──
    if not raw_results and provider == "tavily" and cfg.get("tavily_api_key"):
        try:
            api_url = "https://api.tavily.com/search"
            body = json.dumps({
                "api_key": cfg["tavily_api_key"],
                "query": query, "max_results": n * 2, "search_depth": "basic",
            }).encode()
            req = urllib.request.Request(api_url, data=body, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                "Content-Type": "application/json",
                "Accept": "application/json",
            })
            with opener.open(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", errors="ignore"))
            for item in (data.get("results", []) or [])[:n * 2]:
                raw_results.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("content", ""),
                })
            engine_used = "Tavily"
        except Exception:
            pass

    # ── SerpAPI (Google) ──
    if not raw_results and provider == "serpapi" and cfg.get("serpapi_api_key"):
        try:
            api_url = f"https://serpapi.com/search?q={encoded}&api_key={cfg['serpapi_api_key']}&num={n*2}&engine=google"
            req = urllib.request.Request(api_url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                "Accept": "application/json",
            })
            with opener.open(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", errors="ignore"))
            for item in (data.get("organic_results", []) or [])[:n * 2]:
                raw_results.append({
                    "title": item.get("title", ""),
                    "url": item.get("link", ""),
                    "snippet": item.get("snippet", ""),
                })
            engine_used = "SerpAPI"
        except Exception:
            pass

    # ── DuckDuckGo Instant Answer API (JSON — 最快) ──
    if not raw_results:
        try:
            api_url = f"https://api.duckduckgo.com/?q={encoded}&format=json&no_html=1&skip_disambig=1"
            req = urllib.request.Request(api_url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                "Accept": "application/json",
            })
            with opener.open(req, timeout=8) as r:
                data = json.loads(r.read().decode("utf-8", errors="ignore"))
            if data.get("AbstractText", "").strip():
                raw_results.append({
                    "title": data.get("Heading", query),
                    "url": data.get("AbstractURL", ""),
                    "snippet": data["AbstractText"][:300],
                })
            for t in data.get("RelatedTopics", []):
                if t.get("Text") and t.get("FirstURL"):
                    raw_results.append({
                        "title": t["Text"][:120],
                        "url": t["FirstURL"],
                        "snippet": t.get("Text", ""),
                    })
            engine_used = "DuckDuckGo"
        except Exception:
            pass

    # ── DuckDuckGo Lite (HTML scraping — fallback) ──
    if not raw_results:
        try:
            url = "https://lite.duckduckgo.com/lite/"
            body = urllib.parse.urlencode({"q": query}).encode()
            req = urllib.request.Request(url, data=body, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html",
            })
            with opener.open(req, timeout=8) as r:
                html = r.read().decode("utf-8", errors="ignore")
            for m in re.finditer(
                r'<a[^>]*rel=["\']nofollow["\'][^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                html, re.I
            ):
                u, title = m.group(1), re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if not title or "duckduckgo.com" in u:
                    continue
                sm = re.search(
                    r'<span[^>]*class=["\']snippet["\'][^>]*>(.*?)</span>',
                    html[m.end():m.end() + 2000], re.I | re.S
                )
                snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip() if sm else ""
                raw_results.append({"title": title, "url": u, "snippet": snippet})
            # Fallback: DDG Lite table format
            if not raw_results:
                for m in re.finditer(
                    r'<td[^>]*>\s*<a[^>]*?href=["\']([^"\']+)["\'][^>]*?>(.*?)</a>',
                    html, re.I | re.S
                ):
                    u, title = m.group(1), re.sub(r'<[^>]+>', '', m.group(2)).strip()
                    if not title or "duckduckgo.com" in u or u == "/lite/":
                        continue
                    raw_results.append({"title": title, "url": u, "snippet": ""})
            engine_used = "DuckDuckGo Lite"
        except Exception:
            pass

    # ── Bing Web Search (HTML scraping — final fallback) ──
    if not raw_results:
        try:
            bing_url = f"https://cn.bing.com/search?q={encoded}&setlang=zh-cn"
            req = urllib.request.Request(bing_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            with opener.open(req, timeout=10) as r:
                bing_html = r.read().decode("utf-8", errors="ignore")
            for m in re.finditer(r'<h2[^>]*>\s*<a[^>]*?href=["\']([^"\']+)["\'][^>]*?>(.*?)</a>', bing_html, re.S|re.I):
                b_url = m.group(1)
                b_title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if not b_title or 'bing.com' in b_url:
                    continue
                rest = bing_html[m.end():m.end()+2000]
                sm = re.search(r'<p[^>]*>(.*?)</p>', rest, re.S|re.I)
                b_snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip() if sm else ''
                raw_results.append({"title": b_title, "url": b_url, "snippet": b_snippet})
            engine_used = "Bing"
        except Exception:
            pass

    # ── 后处理: 域名过滤 + 去重 + 截断 ──
    filtered = [r for r in raw_results if _filter_domains(r["url"], allowed, blocked if not allowed else None)]
    if not filtered and raw_results:
        filtered = raw_results  # 域名过滤太严格时回退
    filtered = _dedup_results(filtered)[:n]

    if not filtered:
        return (f"(未找到与 \"{query}\" 相关的结果。建议:\n"
                f"  1. 使用更通用的搜索词\n"
                f"  2. 在 settings.json 中配置 web_search.provider 为 brave/serpapi/tavily\n"
                f"  3. 检查网络连接)")

    output = _format_search_results(query, engine_used, filtered)

    # ── 写入缓存 ──
    if len(_search_cache) >= _SEARCH_CACHE_MAX:
        _search_cache.clear()
    _search_cache[cache_key] = output

    return output


def _load_web_search_config() -> dict:
    """从 settings.json 加载 web_search 配置段。"""
    try:
        from .config import load_settings
        return load_settings().get("web_search", {})
    except Exception:
        return {}


# ── 网页抓取缓存 ──
_fetch_cache: dict = {}
_FETCH_CACHE_MAX = 20
_FETCH_CACHE_TTL = 300  # 5 分钟


def _extract_page_metadata(html: str) -> dict:
    """从 HTML 中提取页面元数据 (title, description, og 标签)。"""
    meta = {"title": "", "description": ""}
    m = re.search(r'<title[^>]*>(.*?)</title>', html, re.S | re.I)
    if m:
        meta["title"] = re.sub(r'<[^>]+>', '', m.group(1)).strip()[:200]
    m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\']', html, re.I)
    if m:
        meta["description"] = m.group(1).strip()[:300]
    m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)["\']', html, re.I)
    if m and not meta["title"]:
        meta["title"] = m.group(1).strip()[:200]
    return meta


def _html_to_readable(html: str) -> str:
    """增强版 HTML→文本：去除导航/页脚/广告等模板内容，保留正文。"""
    # 移除 script/style/nav/footer/aside/header 标签及内容
    for tag in ['script', 'style', 'nav', 'footer', 'aside', 'header', 'noscript', 'iframe', 'svg']:
        html = re.sub(rf'<{tag}[^>]*>.*?</{tag}>', '', html, flags=re.S | re.I)
    # 移除常见广告/模板 class
    html = re.sub(r'<div[^>]*class=["\'][^"\']*(?:ad|banner|cookie|sidebar|menu|navigation|comment|share|social|related|recommend)[^"\']*["\'][^>]*>.*?</div>', '', html, flags=re.S | re.I)
    # HTML → 文本
    html = re.sub(r'</?(div|p|h[1-6]|li|tr|br|article|section|blockquote|pre|code)[^>]*>', '\n', html, flags=re.I)
    html = re.sub(r'<[^>]+>', ' ', html)
    for e, c in [('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&#39;', "'"), ('&#x27;', "'"), ('&nbsp;', ' '), ('&ensp;', ' '), ('&mdash;', '—'), ('&hellip;', '…')]:
        html = html.replace(e, c)
    html = re.sub(r'[ \t]+', ' ', html)
    html = re.sub(r'\n{3,}', '\n\n', html)
    # 移除连续空行和行首尾空格
    lines = [line.strip() for line in html.split('\n') if line.strip()]
    return '\n'.join(lines)


@registry.register(
    "抓取网页全文并提取可读文本。适合读取 web_search 找到的具体页面。\n"
    "参数:\n"
    "  url       目标网址 (必填，须以 http:// 或 https:// 开头)\n"
    "  max_chars 最大返回字符数 (可选，默认 4000，最大 20000)\n"
    "用法: web_fetch(url=\"https://docs.python.org/3/whatsnew/3.13.html\")\n"
    "      web_fetch(url=\"https://long-article.com\", max_chars=8000)",
    risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def web_fetch(work_dir: str, url: str, max_chars: int = 0) -> str:
    if not re.match(r'^https?://', url):
        return "(x) URL 须以 http:// 或 https:// 开头"
    ok, reason = check_ssrf(url)
    if not ok:
        return f"(x) {reason}"

    limit = min(int(max_chars) if max_chars and int(max_chars) > 0 else 4000, 20000)

    # ── 检查缓存 ──
    import time as _time
    cache_key = f"{url}|{limit}"
    if cache_key in _fetch_cache:
        cached_time, cached_text = _fetch_cache[cache_key]
        if _time.time() - cached_time < _FETCH_CACHE_TTL:
            return cached_text + "\n[缓存命中]"

    opener = _build_opener()
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/json,text/plain,*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        })
        with opener.open(req, timeout=15) as r:
            raw = r.read(102400)  # 读取最多 100KB
            ct = r.headers.get("Content-Type", "")
            status = r.status

        # ── 根据内容类型处理 ──
        if "text/html" in ct:
            try:
                html = raw.decode("utf-8", errors="ignore")
            except Exception:
                html = raw.decode("latin-1", errors="ignore")
            meta = _extract_page_metadata(html)
            text = _html_to_readable(html)
            # 构建带元数据的输出
            header_parts = [f"--- {url} ---"]
            if meta["title"]:
                header_parts.append(f"标题: {meta['title']}")
            if meta["description"]:
                header_parts.append(f"摘要: {meta['description']}")
            header = "\n".join(header_parts) + "\n\n"
        elif any(t in ct for t in ["text/plain", "application/json", "text/csv", "application/xml"]):
            text = raw.decode("utf-8", errors="ignore")
            header = f"--- {url} ---\n[Content-Type: {ct}]\n\n"
        else:
            return f"(x) 不支持的内容类型: {ct}"

        if not text.strip():
            return f"--- {url} ---\n(无有效文本)"

        # ── 智能截断: 保留开头和结尾 ──
        if len(text) > limit:
            keep_head = int(limit * 0.8)
            keep_tail = int(limit * 0.15)
            text = text[:keep_head] + f"\n\n[... 已截断，原文 {len(text)} 字符 ...]\n\n" + text[-keep_tail:]

        result = header + text

        # ── 写入缓存 ──
        if len(_fetch_cache) >= _FETCH_CACHE_MAX:
            _fetch_cache.clear()
        _fetch_cache[cache_key] = (_time.time(), result)

        return result
    except urllib.error.HTTPError as e:
        return f"(x) HTTP {e.code} — {url}"
    except urllib.error.URLError as e:
        return f"(x) 连接失败: {e.reason} — {url}"
    except Exception as e:
        return f"(x) {e}"


# ══════════════════════════════════════════════════════════════
# 记忆系统
# ══════════════════════════════════════════════════════════════

def _get_memory_store(work_dir: str):
    try: from .memory import MemoryStore
    except ImportError: return None
    from . import cortex_agent as ca
    memory_path = getattr(ca, '_project_memory_path', None)
    if not memory_path:
        memory_path = os.path.join(os.path.dirname(os.path.abspath(work_dir)), '.cortx', 'memory.md')
    return MemoryStore(memory_path)


@registry.register("记住一条重要事实供后续对话使用", risk=RiskLevel.SAFE, capability=Capability.FS_WRITE)
def remember_fact(work_dir: str, name: str, description: str) -> str:
    store = _get_memory_store(work_dir)
    if store is None: return "(x) 记忆系统不可用"
    try:
        store.append(f"{name} {description}")
        return f"已记住: {name} {description}"
    except Exception as e: return f"(x) 记忆失败: {e}"


@registry.register("回忆之前记住的事实", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def recall_fact(work_dir: str, query: str = "") -> str:
    store = _get_memory_store(work_dir)
    if store is None: return "(x) 记忆系统不可用"
    try:
        facts = store.list_all()
        if not facts: return "(空) 没有记住任何事实。"
        if query:
            facts = [f for f in facts if query.lower() in f.lower()]
            if not facts: return f"(x) 未找到包含 '{query}' 的记忆。"
        return "\n".join(facts)
    except Exception as e: return f"(x) 回忆失败: {e}"


@registry.register("删除一条记忆", risk=RiskLevel.SAFE, capability=Capability.FS_WRITE)
def forget_fact(work_dir: str, name: str) -> str:
    store = _get_memory_store(work_dir)
    if store is None: return "(x) 记忆系统不可用"
    try:
        if store.remove(name): return f"已忘记包含 '{name}' 的记忆"
        return f"(x) 未找到包含 '{name}' 的记忆"
    except Exception as e: return f"(x) 操作失败: {e}"


# ══════════════════════════════════════════════════════════════
# 辅助工具
# ══════════════════════════════════════════════════════════════

@registry.register(
    "向用户提问并获取回答。当需要用户确认、选择或提供信息时使用。\n"
    "在非交互模式（管道/CI）下会自动返回默认提示。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def ask_user(work_dir: str, question: str) -> str:
    # 尝试通过全局工具上下文进行交互
    try:
        from .tool_context import get_tool_context
        ctx = get_tool_context()
        if ctx.get("askUser"):
            import asyncio
            return asyncio.get_event_loop().run_until_complete(ctx["askUser"](question))
    except Exception:
        pass
    return f"[需要用户确认] {question}"


@registry.register("用 Python AST 检查 Python 代码语法错误", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def python_lint(work_dir: str, path: str = "", code: str = "") -> str:
    import ast
    source = ""
    if path:
        d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
        if not os.path.isfile(d): return f"(x) 文件不存在: {path}"
        with open(d, "r", encoding="utf-8") as f: source = f.read()
    elif code: source = code
    else: return "(x) 需要 path 或 code 参数"
    try:
        ast.parse(source)
        return "OK — 语法检查通过"
    except SyntaxError as e:
        return f"语法错误 第{e.lineno}行 第{e.offset}列: {e.msg}"


# ══════════════════════════════════════════════════════════════
# 任务管理 (对标 Claude Code TaskCreate/TaskList/TaskUpdate)
# ══════════════════════════════════════════════════════════════

@registry.register(
    "创建待办任务，返回任务ID。用于管理复杂多步骤工作。\n"
    "用法: task_create(subject=\"修复登录bug\", description=\"用户无法用邮箱登录\")",
    risk=RiskLevel.SAFE, capability=Capability.FS_WRITE)
def task_create(work_dir: str, subject: str, description: str = "") -> str:
    tid = f"task_{len(_tasks) + 1:03d}_{subject[:10].replace(' ', '_')}"
    _tasks.append({"id": tid, "subject": subject, "description": description, "status": "pending"})
    return f"已创建 #{tid}: {subject}"


@registry.register(
    "列出所有任务及其状态。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def task_list(work_dir: str) -> str:
    if not _tasks:
        return "(无任务)"
    lines = [f"{t['id']:<30} [{t['status']:<12}] {t['subject']}" for t in _tasks]
    return "\n".join(lines)


@registry.register(
    "更新任务状态。status 可选: pending, in_progress, completed, deleted。",
    risk=RiskLevel.SAFE, capability=Capability.FS_WRITE)
def task_update(work_dir: str, task_id: str, status: str) -> str:
    for t in _tasks:
        if t["id"] == task_id:  # 仅精确匹配
            if status in ("pending", "in_progress", "completed", "deleted"):
                t["status"] = status
                return f"任务 {t['id']} → {status}"
            return f"(x) 无效状态: {status}"
    return f"(x) 未找到任务: {task_id}"


# ══════════════════════════════════════════════════════════════
# 文件差异对比
# ══════════════════════════════════════════════════════════════

@registry.register(
    "对比两个文件的内容差异（类似 git diff）。\n"
    "返回逐行对比结果，+ 表示新增行，- 表示删除行。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def diff_files(work_dir: str, file_a: str, file_b: str) -> str:
    def resolve(p):
        return os.path.realpath(p if os.path.isabs(p) else os.path.join(work_dir, p))
    pa, pb = resolve(file_a), resolve(file_b)
    if not os.path.isfile(pa):
        return f"(x) 文件不存在: {file_a}"
    if not os.path.isfile(pb):
        return f"(x) 文件不存在: {file_b}"
    with open(pa, "r", encoding="utf-8", errors="ignore") as f:
        lines_a = f.readlines()
    with open(pb, "r", encoding="utf-8", errors="ignore") as f:
        lines_b = f.readlines()
    import difflib
    diff = list(difflib.unified_diff(
        lines_a, lines_b, fromfile=file_a, tofile=file_b, lineterm=""
    ))
    if not diff:
        return "(文件完全相同)"
    return "\n".join(diff[:80])  # limit 80 lines


# ══════════════════════════════════════════════════════════════
# HTTP 客户端
# ══════════════════════════════════════════════════════════════

@registry.register(
    "发送 HTTP 请求。支持 GET/POST，返回状态码和响应体文本（截断至5000字符）。\n"
    "用法: http_request(url=\"https://api.example.com\", method=\"GET\", body=\"\", headers=\"\")",
    risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def http_request(work_dir: str, url: str, method: str = "GET", body: str = "",
                 headers: str = "") -> str:
    if not url.startswith("http"):
        return "(x) URL 须以 http:// 或 https:// 开头"
    ok, reason = check_ssrf(url)
    if not ok:
        return f"(x) {reason}"
    try:
        hdrs = {"User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)"}
        if headers:
            for line in headers.strip().split("\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    hdrs[k.strip()] = v.strip()
        data = body.encode() if body else None
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method.upper())
        opener = _build_opener()
        with opener.open(req, timeout=10) as r:  # 代理感知
            text = r.read().decode("utf-8", errors="ignore")[:5000]
            return f"HTTP {r.status}\n{text}"
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="ignore")[:1000] if e.fp else ""
        return f"HTTP {e.code}\n{body_text}"
    except Exception as e:
        return f"(x) {e}"


# ══════════════════════════════════════════════════════════════
# 文件操作 (移动/复制/删除/创建目录)
# ══════════════════════════════════════════════════════════════

@registry.register(
    "文件/目录操作：复制、移动、删除、创建目录。\n"
    "用法: file_ops(operation=\"cp|mv|rm|mkdir\", source=\"源路径\", target=\"目标路径\")",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def file_ops(work_dir: str, operation: str, source: str, target: str = "") -> str:
    import shutil as sh
    def resolve(p):
        return os.path.realpath(p if os.path.isabs(p) else os.path.join(work_dir, p))
    op = operation.lower()
    try:
        if op == "cp":
            src, dst = resolve(source), resolve(target)
            if not os.path.exists(src):
                return f"(x) 源不存在: {source}"
            if os.path.isdir(src):
                sh.copytree(src, dst)
            else:
                parent = os.path.dirname(dst)
                if parent: os.makedirs(parent, exist_ok=True)
                sh.copy2(src, dst)
            return f"已复制 {source} → {target}"
        elif op == "mv":
            src, dst = resolve(source), resolve(target)
            if not os.path.exists(src):
                return f"(x) 源不存在: {source}"
            parent = os.path.dirname(dst)
            if parent: os.makedirs(parent, exist_ok=True)
            sh.move(src, dst)
            return f"已移动 {source} → {target}"
        elif op == "rm":
            src = resolve(source)
            if not os.path.exists(src):
                return f"(x) 不存在: {source}"
            work_root = os.path.realpath(work_dir)
            if os.path.realpath(src) == work_root:
                return "(x) 禁止删除工作目录根目录"
            if os.path.isdir(src):
                sh.rmtree(src)
            else:
                os.remove(src)
            return f"已删除 {source}"
        elif op == "mkdir":
            dst = resolve(source)
            os.makedirs(dst, exist_ok=True)
            return f"已创建目录 {source}"
        else:
            return f"(x) 不支持的操作: {operation} (可用: cp, mv, rm, mkdir)"
    except PermissionError as e:
        return f"(x) 权限不足: {e}"
    except Exception as e:
        return f"(x) {e}"


# ══════════════════════════════════════════════════════════════
# 结构化数据读取
# ══════════════════════════════════════════════════════════════

@registry.register(
    "读取并解析 JSON 文件，返回格式化后的 JSON 字符串。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def read_json(work_dir: str, path: str) -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if not os.path.isfile(d):
        return f"(x) 文件不存在: {path}"
    try:
        with open(d, "r", encoding="utf-8") as f:
            data = json.load(f)
        return json.dumps(data, ensure_ascii=False, indent=2)
    except json.JSONDecodeError as e:
        return f"(x) JSON解析错误: {e}"
    except Exception as e:
        return f"(x) {e}"


# ══════════════════════════════════════════════════════════════
# CSV / 表格查询
# ══════════════════════════════════════════════════════════════

@registry.register(
    "读取 CSV 文件并执行类 SQL 查询（支持 WHERE/ORDER BY/LIMIT）。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def csv_query(work_dir: str, path: str, query: str = "SELECT * LIMIT 50") -> str:
    import csv, io
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    if not os.path.isfile(d):
        return f"(x) 文件不存在: {path}"
    try:
        with open(d, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        if not rows:
            return "(空CSV)"
        cols = list(rows[0].keys())
        # 大小写不敏感的列名查找
        col_lower = {c.lower(): c for c in cols}
        def _resolve_col(name: str) -> str:
            return col_lower.get(name.lower(), name)
        # ── SQL 解析: SELECT cols FROM table WHERE cond ORDER BY col LIMIT n ──
        # 不大写整个查询（保留值原始大小写），用 IGNORECASE 正则拆分关键词
        def _split_kw(text: str, kw: str) -> list:
            """用大小写不敏感的关键词拆分，返回各部分（不含关键词本身）。"""
            parts = re.split(r'\s+' + kw + r'\s+', text, maxsplit=1, flags=re.IGNORECASE)
            return parts
        # 去掉 SELECT 前缀
        working = re.sub(r'^\s*SELECT\s+', '', query, flags=re.IGNORECASE).strip()
        # 分离 LIMIT
        limit = 50
        lim_parts = _split_kw(working, "LIMIT")
        if len(lim_parts) == 2:
            working = lim_parts[0].strip()
            try: limit = int(lim_parts[1].strip())
            except: pass
        # 分离 ORDER BY
        order_by = None
        ob_parts = _split_kw(working, "ORDER\\s+BY")
        if len(ob_parts) == 2:
            working = ob_parts[0].strip()
            order_by = ob_parts[1].strip()
        # 分离 WHERE
        where_clause = None
        w_parts = _split_kw(working, "WHERE")
        if len(w_parts) == 2:
            working = w_parts[0].strip()
            where_clause = w_parts[1].strip()
        # 去掉 FROM table
        from_parts = _split_kw(working, "FROM")
        if len(from_parts) == 2:
            working = from_parts[0].strip()
        # 解析选择的列
        if working.strip() == "*" or not working.strip():
            selected = cols
        else:
            selected = [_resolve_col(c.strip()) for c in working.split(",")]
        # ── WHERE 过滤: 支持 =, !=, >, <, >=, <= ──
        if where_clause:
            m = re.match(r"(\w+)\s*(>=|<=|!=|=|>|<)\s*(.+)", where_clause)
            if m:
                col = _resolve_col(m.group(1))
                op = m.group(2)
                val = m.group(3).strip().strip("'\"")
                def _cmp(v):
                    try:
                        fv = float(val); fv2 = float(v)
                    except (ValueError, TypeError):
                        fv = None
                    if op == "=": return v == val or (fv is not None and fv2 == fv)
                    if op == "!=": return v != val
                    if fv is not None:
                        if op == ">": return fv2 > fv
                        if op == "<": return fv2 < fv
                        if op == ">=": return fv2 >= fv
                        if op == "<=": return fv2 <= fv
                    return False
                rows = [r for r in rows if _cmp(r.get(col, ""))]
        # ── ORDER BY 排序 ──
        if order_by:
            desc = order_by.endswith(" DESC")
            col = _resolve_col(order_by.replace(" DESC", "").replace(" ASC", "").strip())
            try:
                rows = sorted(rows, key=lambda r: float(r.get(col, "0")), reverse=desc)
            except (ValueError, TypeError):
                rows = sorted(rows, key=lambda r: r.get(col, ""), reverse=desc)
        rows = rows[:limit]
        lines = [" | ".join(selected)]
        lines.append("-" * max(len(lines[0]), 10))
        for r in rows:
            lines.append(" | ".join(str(r.get(c, "")) for c in selected))
        return f"({len(rows)} 行)\n" + "\n".join(lines)
    except Exception as e:
        return f"(x) {e}"


@registry.register(
    "列出当前 Agent 已注册的所有工具及其描述和参数定义。\n"
    "在开始任何任务之前，应先调用此工具了解你拥有哪些能力，再规划行动方案。\n"
    "返回每个工具的名称、描述、风险等级和参数列表。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def list_tools(work_dir: str) -> str:
    import json as _j
    schemas = registry.schemas
    lines = [f"=== 已注册工具 ({len(schemas)} 个) ===\n"]
    for s in schemas:
        fn = s.get("function", {})
        name = fn.get("name", "?")
        desc = fn.get("description", "").split("\n")[0][:100]
        params = fn.get("parameters", {}).get("properties", {})
        required = fn.get("parameters", {}).get("required", [])
        meta = registry.meta(name)
        risk_str = str(meta["risk"]).split(".")[-1] if meta else "?"
        cap_str = meta["capability"].value if meta else "?"
        param_parts = []
        for pname, pinfo in params.items():
            ptype = pinfo.get("type", "?")
            req = "必填" if pname in required else "可选"
            param_parts.append(f"{pname}({ptype},{req})")
        params_str = ", ".join(param_parts) if param_parts else "无参数"
        lines.append(f"  ● {name}")
        lines.append(f"    描述: {desc}")
        lines.append(f"    风险: {risk_str} | 能力: {cap_str}")
        lines.append(f"    参数: {params_str}")
        lines.append("")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════
# Git 专用工具 (与 TS git.ts 对齐)
# ══════════════════════════════════════════════════════════════

import subprocess as _sp

def _git_exec(work_dir: str, git_args: list, timeout: int = 30) -> tuple:
    """执行 git 命令，返回 (ok, stdout, stderr)"""
    try:
        r = _sp.run(["git"] + git_args, cwd=work_dir, timeout=timeout,
                     capture_output=True, text=True)
        return (r.returncode == 0, r.stdout.strip(), r.stderr.strip())
    except Exception as e:
        return (False, "", str(e))

def _is_git_repo(work_dir: str) -> bool:
    ok, out, _ = _git_exec(work_dir, ["rev-parse", "--is-inside-work-tree"], 5)
    return ok and out == "true"


@registry.register(
    "查看 Git 工作区状态。显示已修改、已暂存、未跟踪的文件。\n用法: git_status()",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def git_status(work_dir: str) -> str:
    if not _is_git_repo(work_dir): return "(x) 当前目录不是 Git 仓库"
    ok, out, err = _git_exec(work_dir, ["status", "--porcelain=v1", "--branch"])
    if not ok: return f"(x) git status 失败: {err}"
    if not out: return "工作区干净 (无变更)"
    lines = out.split("\n")
    branch_line = next((l for l in lines if l.startswith("##")), "")
    changes = [l for l in lines if not l.startswith("##")]
    result = ""
    if branch_line: result += f"分支: {branch_line[3:]}\n\n"
    staged, unstaged, untracked = [], [], []
    for line in changes:
        code = line[:2]
        file = line[3:]
        if code[0] == "?" and code[1] == "?": untracked.append(file)
        elif code[0] not in (" ", "?"): staged.append(file)
        elif code[1] not in (" "): unstaged.append(file)
    if staged: result += "已暂存:\n" + "\n".join(f"  + {f}" for f in staged) + "\n"
    if unstaged: result += "已修改:\n" + "\n".join(f"  ~ {f}" for f in unstaged) + "\n"
    if untracked: result += "未跟踪:\n" + "\n".join(f"  ? {f}" for f in untracked) + "\n"
    return result.strip() or "工作区干净"


@registry.register(
    "查看 Git 差异。staged=true 查看已暂存的变更，staged=false 查看未暂存的变更。\n"
    "用法: git_diff(staged=True)\n      git_diff(staged=False, filePath=\"src/main.ts\")",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def git_diff(work_dir: str, staged: bool = True, filePath: str = "") -> str:
    if not _is_git_repo(work_dir): return "(x) 当前目录不是 Git 仓库"
    git_args = ["diff"]
    if staged: git_args.append("--cached")
    if filePath: git_args += ["--", filePath]
    ok, out, err = _git_exec(work_dir, git_args)
    if not ok: return f"(x) git diff 失败: {err}"
    if not out: return "(无已暂存的变更)" if staged else "(无未暂存的变更)"
    return out


@registry.register(
    "暂存文件并创建 Git 提交。\nfilePath 可以是具体文件、通配符或 \".\"（全部）。\n"
    "用法: git_commit(filePath=\".\", message=\"修复登录页面样式\")",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def git_commit(work_dir: str, filePath: str = ".", message: str = "") -> str:
    if not _is_git_repo(work_dir): return "(x) 当前目录不是 Git 仓库"
    if not message.strip(): return "(x) 提交消息不能为空"
    ok_add, _, err_add = _git_exec(work_dir, ["add", filePath], 10)
    if not ok_add: return f"(x) git add 失败: {err_add}"
    ok_commit, out_commit, err_commit = _git_exec(work_dir, ["commit", "-m", message], 15)
    if not ok_commit:
        if "nothing to commit" in err_commit: return "无变更可提交 (工作区已是最新)"
        return f"(x) git commit 失败: {err_commit}"
    ok_hash, hash_out, _ = _git_exec(work_dir, ["rev-parse", "--short", "HEAD"], 5)
    hash_val = hash_out if ok_hash else "?"
    return f"已提交 {hash_val}: {message}\n{out_commit}"


@registry.register(
    "管理 Git 分支。\n"
    "action=\"list\" 列出所有分支\n"
    "action=\"create\" 创建新分支 (需 branchName)\n"
    "action=\"switch\" 切换分支 (需 branchName)\n"
    "action=\"delete\" 删除分支 (需 branchName)\n"
    "用法: git_branch(action=\"create\", branchName=\"feature/auth\")",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def git_branch(work_dir: str, action: str = "list", branchName: str = "") -> str:
    if not _is_git_repo(work_dir): return "(x) 当前目录不是 Git 仓库"
    if action == "list":
        ok, out, err = _git_exec(work_dir, ["branch", "-a", "--format=%(refname:short) %(objectname:short) %(committerdate:relative)"])
        if not ok: return f"(x) git branch 失败: {err}"
        if not out: return "(无分支)"
        return "分支列表:\n" + "\n".join(f"  {l}" for l in out.split("\n"))
    if not branchName.strip(): return "(x) 需要 branchName 参数"
    if action == "create":
        ok, out, err = _git_exec(work_dir, ["checkout", "-b", branchName], 10)
        if not ok: return f"(x) 创建分支失败: {err}"
        return f"已创建并切换到分支: {branchName}"
    if action == "switch":
        ok, out, err = _git_exec(work_dir, ["checkout", branchName], 10)
        if not ok: return f"(x) 切换分支失败: {err}"
        return f"已切换到分支: {branchName}"
    if action == "delete":
        ok, out, err = _git_exec(work_dir, ["branch", "-d", branchName], 10)
        if not ok: return f"(x) 删除分支失败: {err}"
        return f"已删除分支: {branchName}"
    return f"(x) 未知操作: {action}\n可用: list, create, switch, delete"


@registry.register(
    "查看 Git 提交历史。limit 指定显示条数（默认 10）。\n用法: git_log(limit=20)",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def git_log(work_dir: str, limit: int = 10) -> str:
    if not _is_git_repo(work_dir): return "(x) 当前目录不是 Git 仓库"
    ok, out, err = _git_exec(work_dir, [
        "log", f"--max-count={limit}",
        "--format=%h %ad %an  %s", "--date=short",
    ])
    if not ok: return f"(x) git log 失败: {err}"
    if not out: return "(无提交历史)"
    return f"提交历史 (最近 {limit} 条):\n" + "\n".join(f"  {l}" for l in out.split("\n"))


# ══════════════════════════════════════════════════════════════
# 子代理工具 (与 TS subagent.ts 对齐)
# ══════════════════════════════════════════════════════════════

@registry.register(
    "生成子代理执行独立任务。子代理拥有独立的上下文和工具集，执行完毕后返回结果。\n"
    "适用于将复杂任务分解为子任务，避免污染主对话上下文。\n"
    "用法: spawn_subagent(task=\"搜索所有 API 端点并生成文档\")",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def spawn_subagent(work_dir: str, task: str, model: str = "") -> str:
    if not task.strip(): return "(x) 请提供任务描述"
    return f"[子代理任务] {task}"


# ══════════════════════════════════════════════════════════════
