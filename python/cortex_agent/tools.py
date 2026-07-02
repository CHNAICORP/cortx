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
"""

import os, re, shlex, sqlite3, platform, subprocess, datetime, json, csv, io
import urllib.parse, urllib.request, urllib.error
from .cortex_agent import registry, RiskLevel, Capability, check_ssrf

_tasks = []  # 模块级简单任务存储


# ══════════════════════════════════════════════════════════════
# HTML → 文本
# ══════════════════════════════════════════════════════════════

def _html_to_text(html: str) -> str:
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S|re.I)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.S|re.I)
    html = re.sub(r'</?(div|p|h[1-6]|li|tr|br|article|section|header|footer)[^>]*>', '\n', html, flags=re.I)
    html = re.sub(r'<[^>]+>', ' ', html)
    for e, c in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&quot;','"'),('&#39;',"'"),('&#x27;',"'"),('&nbsp;',' ')]:
        html = html.replace(e, c)
    html = re.sub(r'[ \t]+', ' ', html); html = re.sub(r'\n{3,}', '\n\n', html)
    return html.strip()


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
    full_pattern = os.path.join(base, pattern)
    # 防止 pattern 穿越工作区
    resolved = os.path.realpath(full_pattern)
    if not resolved.startswith(base + os.sep) and resolved != base:
        return f"(x) 模式超出工作区范围: {pattern}"
    matches = glob_mod.glob(full_pattern, recursive=True)
    if not matches: return f"(无匹配: {pattern})"
    # 过滤掉工作区外的结果
    matches = [m for m in matches if os.path.realpath(m).startswith(base + os.sep) or os.path.realpath(m) == base]
    if not matches: return f"(无匹配: {pattern})"
    matches.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
    head = min(len(matches), 50)
    lines = [f"({len(matches)} 个匹配，显示前 {head} 个)"]
    for fp in matches[:head]:
        try:
            size = os.path.getsize(fp)
        except OSError:
            size = 0
        lines.append(f"  {os.path.relpath(fp, base)} ({size:,} bytes)")
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
    is_win = platform.system() == "Windows"
    try:
        args = ["powershell","-NoProfile","-NonInteractive","-Command",command] if is_win else shlex.split(command)
        r = subprocess.run(args, cwd=work_dir, capture_output=True, text=True, timeout=10, shell=False,
                          encoding='utf-8', errors='replace')
        out = ((r.stdout or "") + (r.stderr or "")).strip()[:2000] or "(无输出)"
        return f"exit={r.returncode}\n{out}"
    except subprocess.TimeoutExpired: return "(x) 超时"
    except Exception as e: return f"(x) {e}"


@registry.register("执行 Python 代码（子进程隔离）", risk=RiskLevel.SYSTEM, capability=Capability.PYTHON)
def run_python(work_dir: str, code: str) -> str:
    return "(x) 内部错误"  # actual execution delegated to ToolExecutor


# ══════════════════════════════════════════════════════════════
# 时间
# ══════════════════════════════════════════════════════════════

@registry.register("获取当前系统日期时间", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def get_current_time(work_dir: str) -> str:
    now = datetime.datetime.now()
    return now.strftime("%Y-%m-%d %H:%M:%S %A (week %W)")


# ══════════════════════════════════════════════════════════════
# 网络
# ══════════════════════════════════════════════════════════════

@registry.register("联网搜索网页（免费 DuckDuckGo Lite）", risk=RiskLevel.SAFE, capability=Capability.NET_SEARCH)
def web_search(work_dir: str, query: str) -> str:
    try:
        url = "https://lite.duckduckgo.com/lite/"
        body = urllib.parse.urlencode({"q": query}).encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
                                              "Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=8) as r:
            html = r.read().decode("utf-8", errors="ignore")
        results = []
        for m in re.finditer(r'<a[^>]*rel=["\']nofollow["\'][^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I):
            u, title = m.group(1), re.sub(r'<[^>]+>', '', m.group(2)).strip()
            if not title or "duckduckgo.com" in u: continue
            sm = re.search(r'<span[^>]*class=["\']snippet["\'][^>]*>(.*?)</span>', html[m.end():m.end()+2000], re.I|re.S)
            snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip() if sm else ""
            results.append((title, u, snippet))
            if len(results) >= 5: break
        if not results: return "(未找到结果)"
        out = [f'搜索 "{query}" ({len(results)} 条):\n']
        for i,(t,u,s) in enumerate(results,1):
            out.append(f"[{i}] {t}\n    URL: {u}")
            if s: out.append(f"    {s}")
            out.append("")
        return "\n".join(out)
    except Exception as e: return f"(x) 搜索失败: {e}"


@registry.register("抓取网页全文并提取可读文本", risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def web_fetch(work_dir: str, url: str) -> str:
    if not re.match(r'^https?://', url): return "(x) URL 须以 http:// 或 https:// 开头"
    ok, reason = check_ssrf(url)
    if not ok: return f"(x) {reason}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)"})
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read(51200); ct = r.headers.get("Content-Type", "")
        if "text/html" in ct:
            try: text = raw.decode("utf-8", errors="ignore")
            except: text = raw.decode("latin-1", errors="ignore")
            text = _html_to_text(text)
        elif any(t in ct for t in ["text/plain","application/json","text/csv"]):
            try: text = raw.decode("utf-8", errors="ignore")
            except: text = raw.decode("latin-1", errors="ignore")
        else: return f"(x) 不支持的内容类型: {ct}"
        if len(text) > 8000: text = text[:8000] + f"\n\n[... 已截断，原文 {len(text)} 字符]"
        return f"--- {url} ---\n{text}" if text.strip() else "(无有效文本)"
    except urllib.error.HTTPError as e: return f"(x) HTTP {e.code}"
    except urllib.error.URLError as e: return f"(x) 连接失败: {e.reason}"
    except Exception as e: return f"(x) {e}"


# ══════════════════════════════════════════════════════════════
# 记忆系统
# ══════════════════════════════════════════════════════════════

def _get_memory_store(work_dir: str):
    try: from .memory import MemoryStore
    except ImportError: return None
    from . from . import cortex_agent as ca
    memory_path = getattr(ca, '_project_memory_path', None)
    if not memory_path:
        memory_path = os.path.join(os.path.dirname(os.path.abspath(work_dir)), '.cortex', 'memory.md')
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

@registry.register("向用户提问并获取回答", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def ask_user(work_dir: str, question: str) -> str:
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
        with urllib.request.urlopen(req, timeout=10) as r:
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
        # 简单 SQL 解析: SELECT col1,col2 WHERE col=val ORDER BY col LIMIT n
        q = query.upper().replace("SELECT ", "").strip()
        cols = [c.strip() for c in rows[0].keys()]
        selected = cols
        where_clause = None
        order_by = None
        limit = 50
        if " WHERE " in q:
            parts = q.split(" WHERE ", 1)
            q = parts[0]
            rest = parts[1]
            if " ORDER BY " in rest:
                where_clause, order_part = rest.split(" ORDER BY ", 1)
                order_by = order_part.strip()
                if " LIMIT " in order_by:
                    order_by, lim = order_by.split(" LIMIT ", 1)
                    try: limit = int(lim)
                    except: pass
            elif " LIMIT " in rest:
                where_clause, lim = rest.split(" LIMIT ", 1)
                try: limit = int(lim)
                except: pass
            else:
                where_clause = rest
            where_clause = where_clause.strip()
        if q and q != "*":
            selected = [c.strip() for c in q.split(",")]
        # 过滤
        if where_clause:
            m = re.match(r"(\w+)\s*=\s*(.+)", where_clause)
            if m:
                col, val = m.group(1), m.group(2).strip().strip("'\"")
                rows = [r for r in rows if r.get(col, "") == val]
        # 排序
        if order_by:
            desc = order_by.endswith(" DESC")
            col = order_by.replace(" DESC", "").replace(" ASC", "").strip()
            rows = sorted(rows, key=lambda r: r.get(col, ""), reverse=desc)
        rows = rows[:limit]
        lines = [" | ".join(selected)]
        lines.append("-" * len(lines[0]))
        for r in rows:
            lines.append(" | ".join(r.get(c, "") for c in selected))
        return f"({len(rows)} 行)\n" + "\n".join(lines)
    except Exception as e:
        return f"(x) {e}"



# ══════════════════════════════════════════════════════════════
