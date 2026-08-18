"""
Cortex Agent 工具实现 — 所有工具注册到 registry

41 个 Harness Agent 内置工具:
  文件操作: list_directory, read_file, write_file, edit_file, glob, file_ops, diff_files, read_json, csv_query
  搜索:     grep
  数据库:   execute_sql_query
  执行:     run_shell_command, run_python, run_background_command, check_server_status, stop_background_process, list_background_processes
  网络:     web_search, web_fetch, http_request
  时间:     get_current_time
  记忆:     remember_fact, recall_fact, forget_fact
  任务:     task_create, task_list, task_update
  辅助:     ask_user, python_lint, list_tools
  Git:      git_status, git_diff, git_commit, git_branch, git_log
  子代理:   spawn_subagent, spawn_subagents
  技能:     list_skills, use_skill, skill_install, skill_remove
"""

import os, re, sys, sqlite3, platform, subprocess, datetime, json, csv, io, threading, time
import urllib.parse, urllib.request, urllib.error
from .cortex_agent import registry, RiskLevel, Capability, check_ssrf

_tasks = []  # 模块级简单任务存储

# ── 工具超时配置（可从 AgentConfig.tool_timeout 设置）──
_SHELL_TIMEOUT = 30          # 空闲超时（秒）：无输出超过此时间则判定卡死
_SHELL_MAX_TIMEOUT = 300     # 硬上限（秒）：无论如何最多运行 5 分钟
_PYTHON_TIMEOUT = 30         # 空闲超时（秒）
_PYTHON_MAX_TIMEOUT = 300    # 硬上限（秒）

# 阻塞命令模式（会启动长期运行的进程）
_BLOCKING_COMMAND_PATTERNS = [
    # ── npm/npx ──
    r'\b(npm\s+start|npm\s+run\s+dev|npm\s+run\s+serve)\b',
    r'\b(npx\s+.*serve|npx\s+.*start)\b',
    # ── Python 服务器 ──
    r'\b(flask\s+run)\b',                              # Flask
    r'\b(python\s+manage\.py\s+runserver)\b',          # Django
    r'\b(uvicorn\s+|gunicorn\s+|hypercorn\s+)\b',      # ASGI/WSGI
    r'\b(python\s+-m\s+http\.server)\b',               # Python HTTP server
    r'\b(python\s+app\.py|python\s+server\.py|python\s+main\.py)\b',  # 常见服务器入口
    r'\b(python\s+run\.py|python\s+start\.py)\b',      # 启动脚本
    # ── Node 服务器 ──
    r'\b(node\s+server|node\s+app|node\s+index)\b',
    # ── 其他 ──
    r'\b(php\s+-S)\b',                                  # PHP 内置服务器
    r'\b(rails\s+server|rails\s+s)\b',                  # Rails
    r'\b(go\s+run\s+.*main\.go)\b',                    # Go
    r'\b(cargo\s+run)\b',                               # Rust
    r'\b(docker\s+run|docker-compose\s+up)\b',          # Docker
    r'\b(git\s+daemon)\b',                              # Git daemon
]

def set_tool_timeout(seconds: int):
    """设置工具执行空闲超时（秒）。0 表示无超时。
    
    注意：这是「空闲超时」而非「硬超时」——
    只要命令持续产生输出就不会被中断，
    仅当命令无输出超过此时间才判定为卡死。
    """
    global _SHELL_TIMEOUT, _PYTHON_TIMEOUT
    if seconds > 0:
        _SHELL_TIMEOUT = seconds
        _PYTHON_TIMEOUT = seconds


def _run_with_inactivity_timeout(args, cwd, env=None, inactivity_timeout=30, max_timeout=300):
    """使用空闲超时执行子进程。
    
    与 subprocess.run(timeout=N) 的区别：
    - subprocess.run: 硬超时 — N 秒后无条件杀死，即使命令在持续输出
    - 本函数: 空闲超时 — 仅当 N 秒无输出时才杀死；命令持续输出则一直等待
              另有硬上限 max_timeout 作为安全网
    
    返回: (returncode, stdout, stderr, timed_out_reason)
      timed_out_reason: None=正常结束, "inactivity"=空闲超时, "max"=硬上限超时
    """
    import threading

    proc = subprocess.Popen(
        args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8', errors='replace',
        env=env,
    )

    stdout_lines = []
    stderr_lines = []
    last_activity = [time.time()]
    start_time = time.time()
    timed_out = [None]  # None | "inactivity" | "max"

    def kill_tree():
        """强制终止整个进程树。
        仅 proc.kill() 会留下孤儿子进程（如 cmd /c start 分离的 GUI 应用），
        继承的 stdio 管道不关闭 → proc.wait() 永久阻塞 → agent 卡死。"""
        try:
            if sys.platform == "win32" and proc.pid:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            else:
                import os, signal
                try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception: proc.kill()
        except Exception:
            try: proc.kill()
            except Exception: pass

    def read_stream(stream, buf_list):
        """逐行读取输出，更新最后活动时间"""
        try:
            for line in stream:
                buf_list.append(line)
                last_activity[0] = time.time()
        except Exception:
            pass

    # 启动两个线程分别读取 stdout 和 stderr
    t_out = threading.Thread(target=read_stream, args=(proc.stdout, stdout_lines), daemon=True)
    t_err = threading.Thread(target=read_stream, args=(proc.stderr, stderr_lines), daemon=True)
    t_out.start()
    t_err.start()

    # 主线程：监控超时
    while True:
        ret = proc.poll()
        if ret is not None:
            # 进程已结束
            break

        now = time.time()
        idle = now - last_activity[0]
        total = now - start_time

        if inactivity_timeout > 0 and idle > inactivity_timeout:
            timed_out[0] = "inactivity"
            kill_tree()
            break

        if max_timeout > 0 and total > max_timeout:
            timed_out[0] = "max"
            kill_tree()
            break

        time.sleep(0.2)  # 200ms 轮询
    
    # 等待读取线程完成
    t_out.join(timeout=2)
    t_err.join(timeout=2)
    # 安全网：kill 后 proc.wait() 可能因孤儿子进程持有管道而阻塞，
    # 最多等 3s，超时则放弃等待（returncode 保持 None）
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass

    stdout = "".join(stdout_lines).strip()
    stderr = "".join(stderr_lines).strip()
    return proc.returncode, stdout, stderr, timed_out[0]


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
            return (f"(x) 检测到阻塞命令: '{command}'\n"
                    f"该命令会启动长期运行的服务器进程，无法在 run_shell_command 中执行。\n\n"
                    f"✅ 正确做法：使用 run_background_command 工具在后台启动服务器，然后用 check_server_status 验证。\n"
                    f"   示例：run_background_command(command='python app.py')\n"
                    f"   然后：check_server_status(url='http://localhost:5000')")
    
    is_win = platform.system() == "Windows"
    # PowerShell 5.x 不支持 &&，自动转换为 ;
    effective_cmd = command.replace("&&", ";") if is_win else command
    args = ["powershell","-NoProfile","-NonInteractive","-Command",effective_cmd] if is_win else ["bash", "-c", command]
    
    retcode, stdout, stderr, timeout_reason = _run_with_inactivity_timeout(
        args, cwd=work_dir,
        inactivity_timeout=_SHELL_TIMEOUT,
        max_timeout=_SHELL_MAX_TIMEOUT,
    )
    
    if timeout_reason == "inactivity":
        idle_str = f"{_SHELL_TIMEOUT}s 无输出" if _SHELL_TIMEOUT > 0 else "无限制"
        partial = (stdout + stderr).strip()
        partial_msg = f"\n\n已捕获的部分输出:\n{partial[:500]}" if partial else ""
        return (f"(x) 空闲超时（命令 {_SHELL_TIMEOUT}s 无任何输出，判定为卡死）\n"
                f"命令: {command}\n"
                f"已运行时间内有输出，但之后陷入沉默。{partial_msg}\n\n"
                f"可能的原因:\n"
                f"  1. 命令启动了阻塞式进程（如服务器）等待输入\n"
                f"  2. 命令在等待网络响应（如 npm install 网络不通）\n"
                f"  3. 命令进入了交互模式等待用户操作\n\n"
                f"建议:\n"
                f"  1. 检查命令是否需要 --non-interactive 或 --yes 参数\n"
                f"  2. 尝试添加超时参数（如 timeout 60 npm install）\n"
                f"  3. 使用 Ctrl+C 中断后重试")
    elif timeout_reason == "max":
        partial = (stdout + stderr).strip()
        partial_msg = f"\n\n已捕获的部分输出:\n{partial[:500]}" if partial else ""
        return (f"(x) 硬超时（命令执行超过 {_SHELL_MAX_TIMEOUT}s 上限）\n"
                f"命令: {command}{partial_msg}")
    
    out = (stdout + stderr).strip() or "(无输出)"
    return f"exit={retcode}\n{out}"


@registry.register("执行 Python 代码（子进程隔离）", risk=RiskLevel.SYSTEM, capability=Capability.PYTHON)
def run_python(work_dir: str, code: str) -> str:
    import tempfile, sys as _sys, os as _os
    try:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8")
        try:
            tmp.write(code); tmp.close()
            retcode, stdout, stderr, timeout_reason = _run_with_inactivity_timeout(
                [_sys.executable, tmp.name], cwd=work_dir,
                env={**_os.environ, "PYTHONPATH": "", "PATH": _os.environ.get("PATH", "")},
                inactivity_timeout=_PYTHON_TIMEOUT,
                max_timeout=_PYTHON_MAX_TIMEOUT,
            )
            if timeout_reason == "inactivity":
                partial = (stdout + stderr).strip()
                partial_msg = f"\n\n已捕获的部分输出:\n{partial[:500]}" if partial else ""
                return (f"(x) 空闲超时（Python 代码 {_PYTHON_TIMEOUT}s 无输出，判定为卡死）\n"
                        f"可能的原因:\n"
                        f"  1. 代码中有 input() 等待用户输入\n"
                        f"  2. 代码在等待网络响应或文件 I/O\n"
                        f"  3. 代码进入了死循环但不产生输出{partial_msg}")
            elif timeout_reason == "max":
                partial = (stdout + stderr).strip()
                partial_msg = f"\n\n已捕获的部分输出:\n{partial[:500]}" if partial else ""
                return f"(x) 硬超时（Python 代码执行超过 {_PYTHON_MAX_TIMEOUT}s 上限）{partial_msg}"
            out = (stdout + stderr).strip() or "(无输出)"
            return f"exit={retcode}\n{out}"
        finally: _os.unlink(tmp.name)
    except Exception as e: return f"(x) Python 沙箱异常: {e}"


# ══════════════════════════════════════════════════════════════
# 后台进程管理 — 启动服务器、验证状态、停止进程
# ══════════════════════════════════════════════════════════════

# 模块级存储：后台进程注册表 { pid: { proc, command, start_time, log_file } }
_bg_processes: dict = {}


@registry.register("在后台启动长期运行的命令（如 Flask/Express 服务器），立即返回 PID。"
                   "用于启动开发服务器、构建守护进程等。配合 check_server_status 验证服务是否正常。",
                   risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def run_background_command(work_dir: str, command: str) -> str:
    """后台启动命令，立即返回 PID 和日志文件路径。"""
    os.makedirs(work_dir, exist_ok=True)
    is_win = platform.system() == "Windows"

    # 日志文件
    import tempfile
    log_file = os.path.join(work_dir, f".bg_log_{int(time.time())}.txt")

    if is_win:
        args = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command.replace("&&", ";")]
    else:
        args = ["bash", "-c", command]

    try:
        with open(log_file, "w", encoding="utf-8") as lf:
            proc = subprocess.Popen(
                args, cwd=work_dir,
                stdout=lf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
    except Exception as e:
        return f"(x) 后台启动失败: {e}"

    pid = proc.pid
    _bg_processes[pid] = {
        "proc": proc,
        "command": command,
        "start_time": time.time(),
        "log_file": log_file,
    }

    # 等待短暂时间检查进程是否立即崩溃
    time.sleep(1)
    if proc.poll() is not None:
        # 进程已退出 — 读取日志
        try:
            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                log_content = f.read().strip()[:500]
        except Exception:
            log_content = "(无法读取日志)"
        return (f"(x) 后台进程启动后立即退出 (exit={proc.returncode})\n"
                f"命令: {command}\n"
                f"日志:\n{log_content}")

    return (f"✅ 后台进程已启动 (PID={pid})\n"
            f"命令: {command}\n"
            f"日志: {log_file}\n"
            f"提示: 等待 2-3 秒后使用 check_server_status 验证（自动重试3次）\n"
            f"      使用 stop_background_process(pid={pid}) 停止进程")


@registry.register("检查服务器状态（HTTP 健康检查）。发送 HTTP 请求验证服务是否正常运行。",
                   risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def check_server_status(work_dir: str, url: str, expected_status: int = 200,
                        timeout: int = 5, method: str = "GET") -> str:
    """HTTP 健康检查。自动重试 3 次，间隔 1.5 秒。"""
    import urllib.request as _ureq, urllib.error, time as _time

    # 安全检查：只允许 localhost/127.0.0.1
    if not re.search(r'https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)', url):
        return f"(x) 安全限制：check_server_status 仅允许检查本地服务 (localhost/127.0.0.1)\nURL: {url}"

    # 自动重试：服务器可能需要几秒才能就绪
    max_retries = 3
    retry_delay = 1.5
    for attempt in range(1, max_retries + 1):
        try:
            req = _ureq.Request(url, method=method)
            req.add_header("User-Agent", "CortexAgent/HealthCheck")
            with _ureq.urlopen(req, timeout=timeout) as resp:
                status = resp.status
                body = resp.read(1000).decode("utf-8", errors="replace")
                ok = (status == expected_status) if expected_status else (200 <= status < 400)
                icon = "✅" if ok else "⚠"
                retry_note = f" (第{attempt}次尝试成功)" if attempt > 1 else ""
                return (f"{icon} 服务正常运行{retry_note}\n"
                        f"URL: {url}\n"
                        f"HTTP 状态码: {status} (期望: {expected_status})\n"
                        f"响应体预览: {body[:200]}")
        except urllib.error.HTTPError as e:
            return (f"⚠ 服务返回错误\n"
                    f"URL: {url}\n"
                    f"HTTP 状态码: {e.code} (期望: {expected_status})\n"
                    f"错误: {e.reason}")
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            if attempt < max_retries:
                _time.sleep(retry_delay)
                continue
            reason = str(getattr(e, 'reason', e))
            return (f"(x) 服务未启动或端口未监听（已重试 {max_retries} 次）\n"
                    f"URL: {url}\n"
                    f"可能的原因:\n"
                    f"  1. 服务器进程未成功启动\n"
                    f"  2. 服务器正在启动中，尚未就绪\n"
                    f"  3. 端口号错误\n"
                    f"建议: 检查后台进程日志 (list_background_processes + read_file 查看日志)")
    return f"(x) 检查失败（已重试 {max_retries} 次）\nURL: {url}"


@registry.register("停止后台进程（通过 PID）",
                   risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def stop_background_process(work_dir: str, pid: int) -> str:
    """停止指定 PID 的后台进程。"""
    pid = int(pid)

    info = _bg_processes.get(pid)
    if not info:
        # 尝试直接 kill
        try:
            if platform.system() == "Windows":
                subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                               capture_output=True, timeout=5)
            else:
                import signal
                os.kill(pid, signal.SIGTERM)
            return f"✅ 已发送终止信号 (PID={pid})"
        except Exception as e:
            return f"(x) 进程 {pid} 不在注册表中，且直接终止失败: {e}"

    proc = info["proc"]
    command = info["command"]
    log_file = info["log_file"]

    try:
        proc.terminate()  # 优雅终止
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()  # 强制终止
            proc.wait(timeout=2)
    except Exception as e:
        return f"(x) 终止进程 {pid} 失败: {e}"

    # 读取最后日志
    log_tail = ""
    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
            log_tail = "".join(lines[-10:]).strip()
    except Exception:
        pass

    del _bg_processes[pid]

    return (f"✅ 后台进程已停止 (PID={pid})\n"
            f"命令: {command}\n"
            f"运行时长: {time.time() - info['start_time']:.1f}s\n"
            f"最后日志:\n{log_tail[:500]}")


@registry.register("列出所有正在运行的后台进程",
                   risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def list_background_processes(work_dir: str) -> str:
    """列出所有通过 run_background_command 启动的后台进程。"""
    if not _bg_processes:
        return "(无后台进程)"

    lines = [f"运行中的后台进程 ({len(_bg_processes)} 个):\n"]
    for pid, info in _bg_processes.items():
        proc = info["proc"]
        elapsed = time.time() - info["start_time"]
        alive = "运行中" if proc.poll() is None else f"已退出(exit={proc.returncode})"
        lines.append(f"  PID={pid} | {alive} | {elapsed:.0f}s | {info['command'][:60]}")

    return "\n".join(lines)


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
        snippet = r.get("snippet", "")[:600]
        out.append(f"  [{i}] {title}")
        out.append(f"      🔗 {url}")
        if snippet:
            out.append(f"      {snippet}")
        out.append("")
    return "\n".join(out)


@registry.register(
    "联网搜索网页 — 返回标题、URL 和摘要。先看摘要是否已包含答案，够用就不必 web_fetch。\n"
    "参数:\n"
    "  query           搜索关键词 (必填)\n"
    "  allowed_domains 限定搜索域名，逗号分隔 (可选，如 'github.com,stackoverflow.com')\n"
    "  max_results     最大结果数 (可选，默认 10)\n"
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
    n = int(max_results) if max_results and int(max_results) > 0 else int(cfg.get("max_results", 10))
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

    # ── Firecrawl Search（默认引擎，免费 keyless，国内直连）──
    if not raw_results:
        try:
            import json as _json
            fc_data = _json.dumps({"query": query, "limit": n}).encode()
            fc_req = urllib.request.Request(
                "https://api.firecrawl.dev/v1/search",
                data=fc_data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with opener.open(fc_req, timeout=10) as r:
                fc_result = _json.loads(r.read().decode("utf-8", errors="ignore"))
            for item in fc_result.get("data", []):
                if item.get("url") and item.get("title"):
                    raw_results.append({
                        "title": item["title"],
                        "url": item["url"],
                        "snippet": item.get("description", ""),
                    })
            if raw_results:
                engine_used = "Firecrawl"
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

    # ── Bing CN (国内国际通用，0.3s 极快) ──
    if not raw_results:
        try:
            bing_url = f"https://cn.bing.com/search?q={encoded}&ensearch=1&setlang=en"
            req = urllib.request.Request(bing_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            })
            with opener.open(req, timeout=5) as r:
                html = r.read().decode("utf-8", errors="ignore")
            # 提取完整 b_algo 块（包含标题+URL+所有文本，非仅 <p> 段落）
            block_re = re.compile(r'<li[^>]*class="b_algo"[^>]*>([\s\S]*?)</li>', re.IGNORECASE)
            for bm in block_re.finditer(html):
                if len(raw_results) >= n:
                    break
                block = bm.group(1)
                # 标题
                h2 = re.search(r'<h2[^>]*><a[^>]*>(.*?)</a>', block, re.IGNORECASE)
                title = re.sub(r'<[^>]+>', '', h2.group(1)).strip().replace('&amp;', '&') if h2 else ""
                # URL (cite)
                cite = re.search(r'<cite[^>]*>(.*?)</cite>', block, re.IGNORECASE)
                raw_url = re.sub(r'<[^>]+>', '', cite.group(1)).strip() if cite else ""
                url = raw_url if raw_url.startswith('http') else 'https://' + raw_url.split('›')[0].strip()
                # 富摘要：整块纯文本，去掉标题和URL
                full_text = re.sub(r'<[^>]+>', ' ', block)
                full_text = full_text.replace('&ensp;', ' ').replace('&#0183;', ' • ').replace('&amp;', '&')
                full_text = full_text.replace('&nbsp;', ' ').replace('&quot;', '"').replace('&#39;', "'")
                full_text = re.sub(r'\s+', ' ', full_text).strip()
                snippet = full_text
                if title:
                    snippet = snippet.replace(title, '').strip()
                if raw_url:
                    snippet = snippet.replace(raw_url, '').strip()
                if len(snippet) > 600:
                    snippet = snippet[:600] + ' [...]'
                if title and url:
                    raw_results.append({"title": title, "url": url, "snippet": snippet})
            engine_used = "Bing"
        except Exception:
            pass

    # ── DuckDuckGo Instant Answer API (JSON — 备用，需代理) ──
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
    "  max_chars 最大返回字符数 (可选，默认 8000，最大 20000)\n"
    "用法: web_fetch(url=\"https://docs.python.org/3/whatsnew/3.13.html\")\n"
    "      web_fetch(url=\"https://long-article.com\", max_chars=8000)",
    risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def web_fetch(work_dir: str, url: str, max_chars: int = 0) -> str:
    if not re.match(r'^https?://', url):
        return "(x) URL 须以 http:// 或 https:// 开头"
    ok, reason = check_ssrf(url)
    if not ok:
        return f"(x) {reason}"

    # ── 易超时域名警告 ──
    _SLOW_DOMAINS = ["news.google.com", "duckduckgo.com", "lite.duckduckgo.com",
                     "html.duckduckgo.com", "google.com/search", "bing.com/search"]
    if any(d in url for d in _SLOW_DOMAINS):
        return f"(⚠️) {url} 是已知的慢速域名，抓取可能超时。建议从搜索结果中选择其他来源。"

    limit = min(int(max_chars) if max_chars and int(max_chars) > 0 else 8000, 20000)

    # ── 检查缓存 ──
    import time as _time
    cache_key = f"{url}|{limit}"
    if cache_key in _fetch_cache:
        cached_time, cached_text = _fetch_cache[cache_key]
        if _time.time() - cached_time < _FETCH_CACHE_TTL:
            return cached_text + "\n[缓存命中]"

    # ── 策略 0: Firecrawl Scrape（优先，干净 Markdown，限速时回退）──
    _is_blocked = any(d in url for d in _SLOW_DOMAINS) or "github.com" in url or "huggingface.co" in url
    try:
        import json as _json
        fc_data = _json.dumps({"url": url, "formats": ["markdown"]}).encode()
        fc_req = urllib.request.Request(
            "https://api.firecrawl.dev/v1/scrape",
            data=fc_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with opener.open(fc_req, timeout=8 if _is_blocked else 5) as r:
            fc_result = _json.loads(r.read().decode("utf-8", errors="ignore"))
        md = fc_result.get("data", {}).get("markdown", "")
        title = fc_result.get("data", {}).get("metadata", {}).get("title", "")
        if len(md) > 100:
            text = md
            if len(text) > limit:
                keep_head = int(limit * 0.8)
                keep_tail = int(limit * 0.15)
                text = text[:keep_head] + f"\n\n[... 已截断，原文 {len(text)} 字符 ...]\n\n" + text[-keep_tail:]
            header = f"--- {url} ---" + (f"\n标题: {title}" if title else "") + "\n\n"
            result = header + text
            if len(_fetch_cache) >= _FETCH_CACHE_MAX:
                _fetch_cache.clear()
            _fetch_cache[cache_key] = (_time.time(), result)
            return result
    except Exception:
        pass

    # ── 国内不稳定域名：跳过原始 HTTP（必然超时），直接用 Jina Reader ──
    if _is_blocked:
        try:
            jina_url = f"https://r.jina.ai/{url}"
            jina_req = urllib.request.Request(jina_url, headers={
                "User-Agent": "cortex-agent",
                "Accept": "text/plain",
            })
            opener = _build_opener()
            with opener.open(jina_req, timeout=8) as r:
                if r.status == 200:
                    jina_text = r.read(204800).decode("utf-8", errors="ignore").strip()
                    if jina_text and len(jina_text) > 100:
                        text = jina_text
                        if len(text) > limit:
                            keep_head = int(limit * 0.8)
                            keep_tail = int(limit * 0.15)
                            text = text[:keep_head] + f"\n\n[... 已截断，原文 {len(text)} 字符 ...]\n\n" + text[-keep_tail:]
                        result = f"--- {url} ---\n\n{text}"
                        if len(_fetch_cache) >= _FETCH_CACHE_MAX:
                            _fetch_cache.clear()
                        _fetch_cache[cache_key] = (_time.time(), result)
                        return result
        except Exception:
            pass
        return f"(x) 抓取失败: {url} 是国内不稳定域名（GitHub/HuggingFace 等），Firecrawl 限速且直连超时。建议稍后重试或换用其他来源。"

    # ── 策略 1: Jina Reader（备用，干净 Markdown，处理 JS 渲染）──
    try:
        jina_url = f"https://r.jina.ai/{url}"
        jina_req = urllib.request.Request(jina_url, headers={
            "User-Agent": "cortex-agent",
            "Accept": "text/plain",
        })
        opener = _build_opener()
        with opener.open(jina_req, timeout=8) as r:
            if r.status == 200:
                jina_text = r.read(204800).decode("utf-8", errors="ignore").strip()
                if jina_text and len(jina_text) > 100:
                    text = jina_text
                    if len(text) > limit:
                        keep_head = int(limit * 0.8)
                        keep_tail = int(limit * 0.15)
                        text = text[:keep_head] + f"\n\n[... 已截断，原文 {len(text)} 字符 ...]\n\n" + text[-keep_tail:]
                    result = f"--- {url} ---\n\n{text}"
                    if len(_fetch_cache) >= _FETCH_CACHE_MAX:
                        _fetch_cache.clear()
                    _fetch_cache[cache_key] = (_time.time(), result)
                    return result
    except Exception:
        pass  # Jina 失败，回退到原始 HTTP

    # ── 策略 2: 原始 HTTP + HTML 解析（回退）──
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
    schemas = registry.schemas
    lines = [f"=== 已注册工具 ({len(schemas)} 个) ==="]
    for s in schemas:
        fn = s.get("function", {})
        name = fn.get("name", "?")
        desc = fn.get("description", "").split("\n")[0][:70]
        params = fn.get("parameters", {}).get("properties", {})
        required = fn.get("parameters", {}).get("required", [])
        meta = registry.meta(name)
        risk_str = str(meta["risk"]).split(".")[-1] if meta else "?"
        param_names = [p for p in params if p not in ("work_dir", "workDir")]
        params_str = ", ".join(
            f"{p}*" if p in required else p for p in param_names
        ) if param_names else "无参数"
        lines.append(f"  • {name} — {desc} [{risk_str}] ({params_str})")
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
    "生成子代理执行独立任务。子代理拥有独立的上下文和工具集，执行完毕后返回结果摘要。\n"
    "适用于将复杂任务分解为子任务，避免污染主对话上下文。\n"
    "参数:\n"
    "  task   — 任务描述（必填）\n"
    "  tools  — 限制子代理可用的工具，逗号分隔（如 'read_file,grep,glob'），留空则继承父代理\n"
    "  skill  — 预加载技能名称（如 'code-review'），技能指引会注入子代理上下文\n"
    "  model  — 模型别名覆盖（留空用父代理模型）\n"
    "用法: spawn_subagent(task=\"审查 auth.py 的安全性\", tools=\"read_file,grep\", skill=\"code-review\")",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def spawn_subagent(work_dir: str, task: str, model: str = "",
                   tools: str = "", skill: str = "") -> str:
    if not task.strip(): return "(x) 请提供任务描述"
    try:
        from .tool_context import get_tool_context
        ctx = get_tool_context()
        handler = ctx.get("spawnSubagent")
    except Exception:
        handler = None
    if not handler:
        return "(x) 子代理系统不可用 — 请在 Agent 模式下使用"
    try:
        result = handler(task, model, tools, skill)
        if not result.strip(): return "(子代理未返回结果)"
        if len(result) > 5000:
            head = result[:3500]
            tail = result[-1500:]
            result = f"{head}\n\n[...子代理结果已截断...]\n\n{tail}"
        return result
    except Exception as e:
        return f"(x) 子代理执行失败: {e}"


@registry.register(
    "并行派遣多个子代理执行独立任务（fan-out 模式）。所有子代理同时运行，互不干扰。\n"
    "适用于大规模代码分析、多维度审查（安全/性能/测试分别由不同子代理检查）等场景。\n\n"
    "tasks_json 是一个 JSON 数组字符串，每个元素是一个任务对象:\n"
    '  [{"task":"审查安全性","tools":"read_file,grep","skill":"code-review"},\n'
    '   {"task":"检查测试覆盖率","tools":"read_file,grep,glob"},\n'
    '   {"task":"审查代码风格","tools":"read_file"}]\n\n'
    "每个任务对象支持: task(必填), tools(可选), skill(可选), model(可选)\n"
    "用法: spawn_subagents(tasks_json='[{\"task\":\"分析模块A\"},{\"task\":\"分析模块B\"}]')",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def spawn_subagents(work_dir: str, tasks_json: str) -> str:
    if not tasks_json.strip():
        return "(x) 请提供 tasks_json 参数（JSON 数组）"
    try:
        from .tool_context import get_tool_context
        ctx = get_tool_context()
        handler = ctx.get("spawnSubagents")
    except Exception:
        handler = None
    if not handler:
        return "(x) 并行子代理系统不可用 — 请在 Agent 模式下使用"
    try:
        return handler(tasks_json)
    except Exception as e:
        return f"(x) 并行子代理执行失败: {e}"


# ══════════════════════════════════════════════════════════════
# 技能工具 (与 TS skills.ts 对齐)
# ══════════════════════════════════════════════════════════════

@registry.register(
    "列出所有可用的技能（Skills）。技能是可复用的专家级指引模板，能为特定任务提供专业方法论\n"
    "（如代码审查、PPT 制作、Office 文档处理、安全审计等）。无需参数。\n"
    "用法: list_skills()",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def list_skills(work_dir: str) -> str:
    try:
        from .tool_context import get_tool_context
        mgr = get_tool_context().get("skillManager")
    except Exception:
        mgr = None
    if not mgr:
        return "(x) 技能系统不可用"
    cats = mgr.list_by_category()
    total = len(mgr.skills)
    if total == 0:
        return "(没有可用技能)"
    lines = [f"可用技能 ({total} 个):\n"]
    for cat in sorted(cats):
        lines.append(f"  [{cat}]")
        for s in cats[cat]:
            desc = s.description or "(无描述)"
            lines.append(f"    • {s.name} — {desc}")
        lines.append("")
    lines.append("用 use_skill(name=\"技能名\") 加载某技能的完整指引。")
    return "\n".join(lines)


@registry.register(
    "加载指定技能的完整内容（专家指引/prompt）到上下文。先用 list_skills 查看可用技能名。\n"
    "加载后请按技能指引执行用户任务。\n"
    "用法: use_skill(name=\"code-review\")",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def use_skill(work_dir: str, name: str) -> str:
    if not name or not name.strip():
        return "(x) 请提供技能名称。用 list_skills() 查看可用技能。"
    try:
        from .tool_context import get_tool_context
        mgr = get_tool_context().get("skillManager")
    except Exception:
        mgr = None
    if not mgr:
        return "(x) 技能系统不可用"
    skill = mgr.get(name.strip())
    if not skill:
        available = ", ".join(sorted(mgr.skills.keys()))
        return f"(x) 技能不存在: {name}\n可用技能: {available}"
    return skill.to_prompt()


@registry.register(
    "从 GitHub 仓库或 URL 安装技能（SKILL.md）。安装后自动注册到技能系统，立即可用。\n"
    "参数:\n"
    '  source — 技能来源，支持: GitHub 简写("owner/repo")、GitHub URL、raw URL、直接 .md URL\n'
    '  name   — 技能名称覆盖（可选，默认从来源推断）\n'
    "用法:\n"
    '  skill_install(source="alchaincyf/huashu-design")\n'
    '  skill_install(source="https://github.com/pengpengliu1212-art/humanize-write")',
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def skill_install(work_dir: str, source: str, name: str = "") -> str:
    import urllib.request, hashlib, json as _json, shutil
    source = (source or "").strip()
    if not source:
        return "(x) 请提供 skill 来源（GitHub owner/repo 或 URL）"

    # 解析来源
    urls = []
    source_type = "unknown"
    if source.startswith(("http://", "https://")):
        if "raw.githubusercontent.com" in source:
            parts = source.split("/")
            default_name = parts[4] if len(parts) > 4 else "skill"
            urls = [source]
            source_type = "github"
        elif "github.com/" in source:
            import re
            m = re.match(r"https?://github\.com/([^/]+/[^/]+)", source)
            if m:
                repo = m.group(1).replace(".git", "").rstrip("/")
                default_name = repo.split("/")[1]
                urls = [
                    f"https://raw.githubusercontent.com/{repo}/main/SKILL.md",
                    f"https://raw.githubusercontent.com/{repo}/master/SKILL.md",
                ]
                source_type = "github"
            else:
                default_name = "custom-skill"
                urls = [source]
        else:
            default_name = source.split("/")[-1].replace(".md", "") or "custom-skill"
            urls = [source]
            source_type = "url"
    elif "/" in source and not source.startswith("."):
        default_name = source.split("/")[1]
        urls = [
            f"https://raw.githubusercontent.com/{source}/main/SKILL.md",
            f"https://raw.githubusercontent.com/{source}/master/SKILL.md",
        ]
        source_type = "github"
    else:
        default_name = source

    skill_name = name.strip() or default_name
    if not urls:
        return f"(x) 无法解析来源: {source}"

    # 下载
    content = ""
    last_err = ""
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cortex-agent/skill-install"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                content = resp.read().decode("utf-8")
            if content and len(content) > 10 and "404: Not Found" not in content:
                break
            last_err = f"内容无效或 404: {url}"
        except Exception as e:
            last_err = str(e)
    if not content or len(content) < 10:
        return f"(x) 下载失败: {last_err}\n请检查来源是否正确: {source}"

    # 保存
    skill_dir = os.path.join(work_dir, ".cortx", "skills", skill_name)
    skill_path = os.path.join(skill_dir, "SKILL.md")
    try:
        os.makedirs(skill_dir, exist_ok=True)
        with open(skill_path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        return f"(x) 写入文件失败: {e}"

    # hash
    computed_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

    # 更新 skills-lock.json
    try:
        lock_path = os.path.join(work_dir, "skills-lock.json")
        lock = {"version": 1, "skills": {}}
        if os.path.exists(lock_path):
            try:
                with open(lock_path, "r", encoding="utf-8") as f:
                    lock = _json.load(f)
            except Exception:
                pass
        lock.setdefault("skills", {})[skill_name] = {
            "source": source, "sourceType": source_type,
            "skillPath": "SKILL.md", "computedHash": computed_hash,
        }
        with open(lock_path, "w", encoding="utf-8") as f:
            _json.dump(lock, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

    # 重新加载
    try:
        from .tool_context import get_tool_context
        mgr = get_tool_context().get("skillManager")
        if mgr:
            mgr.reload()
    except Exception:
        pass

    # 提取 description
    import re as _re
    desc_match = _re.search(r'^description:\s*"?(.+?)"?\s*$', content, _re.MULTILINE)
    desc = desc_match.group(1) if desc_match else "(从文件内容推断)"

    return (f"✅ 技能安装成功!\n"
            f"  名称: {skill_name}\n"
            f"  描述: {desc}\n"
            f"  来源: {source}\n"
            f"  路径: {skill_path}\n\n"
            f'用 use_skill(name="{skill_name}") 加载该技能，或 list_skills() 查看所有技能。')


@registry.register(
    "删除已安装的技能。从磁盘移除 SKILL.md 并更新 skills-lock.json。\n"
    '用法: skill_remove(name="humanize-write")',
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def skill_remove(work_dir: str, name: str) -> str:
    import shutil
    name = (name or "").strip()
    if not name:
        return "(x) 请提供要删除的技能名称"
    if name in ("code-review", "refactor", "test-writer", "doc-writer", "debug", "explain", "architect"):
        return f'(x) "{name}" 是内置技能，无法删除'

    skill_dir = os.path.join(work_dir, ".cortx", "skills", name)
    skill_file = os.path.join(work_dir, ".cortx", "skills", name + ".md")
    removed = False

    if os.path.isdir(skill_dir):
        try:
            shutil.rmtree(skill_dir)
            removed = True
        except Exception as e:
            return f"(x) 删除失败: {e}"
    elif os.path.isfile(skill_file):
        try:
            os.remove(skill_file)
            removed = True
        except Exception as e:
            return f"(x) 删除失败: {e}"
    if not removed:
        return f"(x) 技能不存在: {name}"

    # 更新 skills-lock.json
    try:
        import json as _json
        lock_path = os.path.join(work_dir, "skills-lock.json")
        if os.path.exists(lock_path):
            with open(lock_path, "r", encoding="utf-8") as f:
                lock = _json.load(f)
            if lock.get("skills", {}).get(name):
                del lock["skills"][name]
                with open(lock_path, "w", encoding="utf-8") as f:
                    _json.dump(lock, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

    # 重新加载
    try:
        from .tool_context import get_tool_context
        mgr = get_tool_context().get("skillManager")
        if mgr:
            mgr.reload()
    except Exception:
        pass

    return f"✅ 技能已删除: {name}"


# ══════════════════════════════════════════════════════════════
