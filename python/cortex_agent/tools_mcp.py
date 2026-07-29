"""
Cortex Agent MCP 工具 — Model Context Protocol 客户端
═══════════════════════════════════════════════════════

mcp_list_servers / mcp_list_tools / mcp_call_tool
+ _split_args / _resolve_command / _mcp_exchange
"""

import os, re, sys, json, shlex, platform, subprocess
import shutil as _shutil
from .cortex_agent import registry, RiskLevel, Capability


# ══════════════════════════════════════════════════════════════
# MCP (Model Context Protocol) 客户端
# ══════════════════════════════════════════════════════════════

def _split_args(args_str: str) -> list:
    """跨平台安全拆分命令行参数字符串。Windows 上用 posix=False 防止反斜杠被转义。"""
    if not args_str:
        return []
    return shlex.split(args_str, posix=(platform.system() != "Windows"))


def _check_command_exists(cmd: str) -> bool:
    """检查命令是否存在（跨平台，Windows 上 .cmd 后缀也会被 which 解析）。"""
    if not cmd:
        return False
    return _shutil.which(cmd) is not None


def _detect_system_chrome() -> str:
    """检测系统已安装的 Chrome 路径，返回可执行文件路径或空字符串。"""
    if platform.system() == "Windows":
        candidates = [
            os.environ.get("PROGRAMFILES", r"C:\Program Files") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe",
        ]
    elif platform.system() == "Darwin":
        candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:  # Linux
        candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return ""


def _identify_registry_server(server_command: str, server_args: str) -> str:
    """根据 command+args 反查 MCP_REGISTRY 中的 server key。
    匹配规则：(1) command_base 等于 registry key 直接返回；
              (2) 否则 command 相同且 args 中包含 server 包名关键词。"""
    cmd_lower = (server_command or "").lower()
    # 去掉路径，只取可执行文件名（npx / uvx / python / cua-driver 等）
    cmd_base = os.path.basename(cmd_lower).replace(".cmd", "").replace(".exe", "")
    # 规则 1：command_base 直接等于 registry key（如 cua-driver）
    if cmd_base in MCP_REGISTRY:
        return cmd_base
    args_lower = (server_args or "").lower()
    full = f"{cmd_base} {args_lower}"
    # 规则 2：command 相同 + args 中包含包名片段
    for key, info in MCP_REGISTRY.items():
        run = info.get("run") or info.get("install") or {}
        run_cmd = (run.get("command") or "")
        run_cmd_base = os.path.basename(run_cmd.lower()).replace(".cmd", "").replace(".exe", "")
        if run_cmd_base and run_cmd_base != cmd_base:
            continue
        run_args = " ".join(run.get("args") or []).lower()
        # 匹配 args 中的关键包名片段（至少 4 字符，跳过 -y 等标志）
        for token in run_args.split():
            if len(token) >= 4 and token.startswith("-"):
                continue  # 跳过 -y / --db-path 等参数标志
            if len(token) >= 4 and token in full:
                return key
    return ""



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


def _mcp_exchange(server_cmd: list, requests: list, timeout: float = 90.0) -> list:
    """启动 MCP 服务器，发送请求序列，返回解析后的 JSON 响应列表。
    
    改进实现：逐行读取 stdout，用 queue 实现真正的超时控制。
    使用线程读取 stderr 防止管道死锁。
    """
    import subprocess as _sp, json as _j, threading as _th, queue as _q, time as _t
    
    proc = _sp.Popen(server_cmd, stdin=_sp.PIPE, stdout=_sp.PIPE,
                     stderr=_sp.PIPE, text=True, bufsize=1, encoding='utf-8',
                     errors='replace')
    
    responses = []
    line_queue: _q.Queue = _q.Queue()
    
    def _read_stdout():
        """逐行读取 stdout，放入队列。"""
        try:
            for line in proc.stdout:
                line_queue.put(line)
        except Exception:
            pass
        finally:
            line_queue.put(None)  # EOF 标记
    
    def _read_stderr():
        try:
            for _ in proc.stderr:
                pass
        except Exception:
            pass
    
    stdout_thread = _th.Thread(target=_read_stdout, daemon=True)
    stdout_thread.start()
    stderr_thread = _th.Thread(target=_read_stderr, daemon=True)
    stderr_thread.start()
    
    try:
        for req in requests:
            proc.stdin.write(req + "\n")
            proc.stdin.flush()
            # 如果是通知（没有 id），不等待响应
            try:
                parsed = _j.loads(req)
                if "id" not in parsed:
                    continue
            except _j.JSONDecodeError:
                continue
            # 等待带 id 的响应（真正的超时控制）
            deadline = _t.time() + timeout
            got_response = False
            while _t.time() < deadline and not got_response:
                remaining = deadline - _t.time()
                try:
                    line = line_queue.get(timeout=min(remaining, 5.0))
                except _q.Empty:
                    continue
                if line is None:
                    break  # EOF
                line = line.strip()
                if not line:
                    continue
                try:
                    resp = _j.loads(line)
                    responses.append(resp)
                    got_response = True
                except _j.JSONDecodeError:
                    continue
            if not got_response:
                break  # 超时或 EOF
    except BrokenPipeError:
        pass
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
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
            icon = {"none": "🟢", "node": "🟡", "python": "🟡",
                    "cua_driver": "🟡", "blender": "🟡"}.get(req, "🔑")
            lines.append(f"  {icon} {key:<20s} — {info['description'][:55]}")
    lines.append(f"\n安装: mcp_install(server=\"<name>\")  |  试用: mcp_quick(server=\"<name>\")")
    lines.append(f"注册表: mcp_registry()")
    return "\n".join(lines)


@registry.register(
    "启动 MCP 服务器并列出其提供的所有工具。\n"
    "用法: mcp_list_tools(server_command=\"npx\", server_args=\"-y @playwright/mcp@latest\")",
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
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
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
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
        # 优先返回 id=2 的响应（工具调用结果），含 error 也要返回
        for msg in reversed(responses):
            if msg.get("id") == 2:
                if "error" in msg:
                    err = msg["error"]
                    return f"(x) MCP 工具错误: {err.get('message', err)}"
                if "result" in msg:
                    result = msg["result"]
                    content = result.get("content", [])
                    if isinstance(content, list):
                        texts = [c.get("text", str(c)) for c in content if isinstance(c, dict)]
                        if texts:
                            return "\n".join(texts)[:3000]
                    return _j.dumps(result, ensure_ascii=False)[:3000]
        # 回退：任意含 result 的响应
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
# 持久化 MCP 会话 — 解决浏览器/桌面控制类 MCP 每次调用重启进程的问题
# 启动一次服务器进程，保持 stdin/stdout 管道，多次调用复用同一进程
# ══════════════════════════════════════════════════════════════

import threading as _th
import queue as _q


class _McpSession:
    """一个持久化的 MCP 服务器会话。进程启动后保持运行，可多次调用工具。"""

    def __init__(self, server_cmd: list, timeout: float = 30.0):
        self.cmd = _resolve_command(server_cmd)
        self.timeout = timeout
        self.proc = None
        self._stdout_q = _q.Queue()
        self._stderr_q = _q.Queue()
        self._reader = None
        self._err_reader = None
        self._next_id = 1
        self._initialized = False

    def start(self) -> str:
        """启动服务器并发送 initialize 握手。返回 "" 成功，否则错误信息。"""
        try:
            self.proc = subprocess.Popen(
                self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8",
                errors="replace", bufsize=1,
            )
        except FileNotFoundError:
            return f"(x) 命令不存在: {self.cmd[0]}"
        except Exception as e:
            return f"(x) 启动失败: {e}"

        # 后台线程读 stdout 行
        self._reader = _th.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        self._err_reader = _th.Thread(target=self._read_stderr, daemon=True)
        self._err_reader.start()

        # 发送 initialize
        resp = self._request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "cortex-agent", "version": "1.0"},
        })
        if resp is None:
            err = self._drain_stderr()
            return f"(x) initialize 无响应 (stderr: {err[:200]})"
        if "error" in resp:
            return f"(x) initialize 错误: {resp['error'].get('message', resp['error'])}"
        # 发送 initialized 通知
        self._notify("notifications/initialized")
        self._initialized = True
        return ""

    def _read_stdout(self):
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if line:
                    try:
                        self._stdout_q.put(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass

    def _read_stderr(self):
        try:
            for line in self.proc.stderr:
                self._stderr_q.put(line)
        except Exception:
            pass

    def _drain_stderr(self) -> str:
        lines = []
        while not self._stderr_q.empty():
            try:
                lines.append(self._stderr_q.get_nowait())
            except _q.Empty:
                break
        return "".join(lines)

    def _send(self, msg: dict):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _notify(self, method: str, params: dict = None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _request(self, method: str, params: dict, timeout: float = None) -> dict:
        rid = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        t = timeout or self.timeout
        try:
            resp = self._stdout_q.get(timeout=t)
            # 跳过不匹配 id 的响应（通知等）
            while resp.get("id") != rid:
                resp = self._stdout_q.get(timeout=t)
            return resp
        except _q.Empty:
            return None

    def call_tool(self, tool_name: str, args: dict, timeout: float = None) -> str:
        """调用工具并返回结果字符串。"""
        if not self._initialized:
            return "(x) 会话未初始化"
        resp = self._request("tools/call", {"name": tool_name, "arguments": args}, timeout)
        if resp is None:
            return f"(x) 工具调用超时 ({tool_name})"
        if "error" in resp:
            return f"(x) MCP 工具错误: {resp['error'].get('message', resp['error'])}"
        if "result" in resp:
            content = resp["result"].get("content", [])
            if isinstance(content, list):
                texts = [c.get("text", str(c)) for c in content if isinstance(c, dict)]
                if texts:
                    return "\n".join(texts)[:3000]
            return json.dumps(resp["result"], ensure_ascii=False)[:3000]
        return f"(x) 无有效响应"

    def list_tools(self, timeout: float = None) -> str:
        if not self._initialized:
            return "(x) 会话未初始化"
        resp = self._request("tools/list", {}, timeout)
        if resp is None:
            return "(x) list_tools 超时"
        if "result" in resp and "tools" in resp["result"]:
            tools = resp["result"]["tools"]
            lines = [f"来自持久会话的 {len(tools)} 个工具:", ""]
            for t in tools:
                desc = (t.get("description", "") or "")[:60]
                lines.append(f"  ● {t['name']}: {desc}")
            return "\n".join(lines)
        return f"(x) 无法列出工具: {resp}"

    def stop(self):
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.stdin.close()
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except Exception:
                    self.proc.kill()
        except Exception:
            pass
        self._initialized = False


# 会话注册表: session_id → _McpSession
_MCP_SESSIONS: dict = {}


@registry.register(
    "启动持久化 MCP 服务器会话。适用于浏览器控制(chrome-devtools/puppeteer/playwright)等需要跨调用保持状态的 MCP。\n"
    "用法: mcp_session_start(session_id=\"browser1\", server_command=\"npx\", server_args=\"-y chrome-devtools-mcp@latest\")\n"
    "启动后用 mcp_session_call 多次调用工具，最后用 mcp_session_stop 关闭。\n"
    "自动安装：如果命令不存在或启动失败，会从注册表识别 server 并自动 mcp_install。\n"
    "puppeteer 自动检测系统 Chrome，避免下载 Chromium。",
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
def mcp_session_start(work_dir: str, session_id: str, server_command: str,
                      server_args: str = "", timeout: float = 30.0) -> str:
    # 如果已有同名会话，先关闭
    if session_id in _MCP_SESSIONS:
        _MCP_SESSIONS[session_id].stop()
        del _MCP_SESSIONS[session_id]

    # ── puppeteer 特殊处理：自动设置 PUPPETEER_EXECUTABLE_PATH 指向系统 Chrome ──
    args_lower = (server_args or "").lower()
    if "puppeteer" in args_lower and not os.environ.get("PUPPETEER_EXECUTABLE_PATH"):
        chrome = _detect_system_chrome()
        if chrome:
            os.environ["PUPPETEER_EXECUTABLE_PATH"] = chrome
            os.environ["PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"] = "true"

    # ── 自动安装检测：如果命令不存在，尝试从注册表识别并安装 ──
    install_notice = ""
    if not _check_command_exists(server_command):
        server_key = _identify_registry_server(server_command, server_args)
        if server_key:
            install_notice = f"\n⏳ 命令 '{server_command}' 不存在，自动安装 {server_key}..."
            try:
                install_result = mcp_install(work_dir, server_key)
                install_notice += f"\n{install_result}"
            except Exception as e:
                install_notice += f"\n(x) 安装失败: {e}"
            # 安装后重新检测
            if not _check_command_exists(server_command):
                return f"(x) 自动安装 {server_key} 后命令 '{server_command}' 仍不存在{install_notice}"
        else:
            return f"(x) 命令不存在: {server_command}（且无法从注册表识别对应 server 进行自动安装）"

    cmd = [server_command] + _split_args(server_args) if server_args else [server_command]
    session = _McpSession(cmd, timeout=timeout)
    err = session.start()
    if err:
        # 启动失败时，如果是命令不存在类错误，尝试自动安装后重试
        if "命令不存在" in err or "FileNotFoundError" in err or "启动失败" in err:
            server_key = _identify_registry_server(server_command, server_args)
            if server_key and not install_notice:  # 避免重复安装
                try:
                    mcp_install(work_dir, server_key)
                    session2 = _McpSession(cmd, timeout=timeout)
                    err2 = session2.start()
                    if err2:
                        return f"{err}\n(自动安装 {server_key} 后仍失败: {err2})"
                    session = session2
                except Exception as e:
                    return f"{err}\n(自动安装 {server_key} 异常: {e})"
            else:
                return err + install_notice
        else:
            return err + install_notice
    _MCP_SESSIONS[session_id] = session
    # 返回工具列表
    tools_out = session.list_tools(timeout=timeout)
    return f"✅ 会话 '{session_id}' 已启动 (PID {session.proc.pid})\n{tools_out}{install_notice}"


@registry.register(
    "在持久化 MCP 会话中调用工具（会话必须已通过 mcp_session_start 启动）。\n"
    "用法: mcp_session_call(session_id=\"browser1\", tool_name=\"navigate_page\", tool_args='{\"url\":\"https://example.com\"}')",
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
def mcp_session_call(work_dir: str, session_id: str, tool_name: str,
                     tool_args: str = "{}", timeout: float = 60.0) -> str:
    if session_id not in _MCP_SESSIONS:
        return f"(x) 会话 '{session_id}' 不存在，请先 mcp_session_start"
    session = _MCP_SESSIONS[session_id]
    try:
        args_dict = json.loads(tool_args) if tool_args else {}
    except json.JSONDecodeError:
        return f"(x) tool_args 不是有效的 JSON: {tool_args[:100]}"
    return session.call_tool(tool_name, args_dict, timeout=timeout)


@registry.register(
    "列出持久化 MCP 会话中可用的工具。\n"
    "用法: mcp_session_list_tools(session_id=\"browser1\")",
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
def mcp_session_list_tools(work_dir: str, session_id: str, timeout: float = 30.0) -> str:
    if session_id not in _MCP_SESSIONS:
        return f"(x) 会话 '{session_id}' 不存在"
    return _MCP_SESSIONS[session_id].list_tools(timeout=timeout)


@registry.register(
    "关闭持久化 MCP 会话并释放资源。\n"
    "用法: mcp_session_stop(session_id=\"browser1\")",
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
def mcp_session_stop(work_dir: str, session_id: str) -> str:
    if session_id not in _MCP_SESSIONS:
        return f"(x) 会话 '{session_id}' 不存在"
    _MCP_SESSIONS[session_id].stop()
    del _MCP_SESSIONS[session_id]
    return f"✅ 会话 '{session_id}' 已关闭"



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
        "description": "本地 SQLite 数据库查询与分析（官方 Python 实现，建表/读写/列表/分析）",
        "category": "database",
        "install": {"command": "uv", "args": ["tool", "install", "mcp-server-sqlite"]},
        "run": {"command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "agent.db"]},
        "requires": "python",
        "note": "官方 SQLite MCP（原 @modelcontextprotocol/server-sqlite npm 包已下架）。"
                "通过 uvx 运行，首次会自动下载依赖（可能需 60s+）。"
                "可用 --db-path 指定数据库路径",
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
        "install": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]},
        "run": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]},
        "url": "https://mcp.context7.com/mcp",
        "requires": "node",
        "note": "支持两种启动方式: (1) npx -y @upstash/context7-mcp (stdio, 推荐) "
              "(2) URL 直连 https://mcp.context7.com/mcp (SSE)。"
              "工具: resolve-library-id(libraryName+query) → query-docs(libraryId+query)。",
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
        "description": "Puppeteer 浏览器自动化 — 轻量级网页交互（推荐设置 PUPPETEER_EXECUTABLE_PATH 指向系统 Chrome 避免下载 Chromium）",
        "category": "browser",
        "install": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-puppeteer"]},
        "run": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-puppeteer"]},
        "requires": "node",
        "note": "默认会下载 Chromium (~170MB)，慢且易失败。"
              "推荐设置环境变量 PUPPETEER_EXECUTABLE_PATH 指向系统 Chrome "
              "(如 Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe)，"
              "并设置 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true 跳过下载。",
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
    "browser-use": {
        "name": "Browser Use",
        "description": "AI 浏览器自动化代理（Python 库+CLI）— LLM 驱动网页任务，需 Chromium",
        "category": "browser",
        "install": {"command": sys.executable, "args": ["-m", "pip", "install", "browser-use"]},
        "run": {"command": "browser-use", "args": []},
        "requires": "python",
        "kind": "library",
        "note": "AI 浏览器代理库（非标准 MCP server）：安装后先运行 `browser-use install` 安装 Chromium，"
                "再通过 `browser-use` CLI 或 Python SDK（from browser_use import Agent）调用",
    },
    "cua-driver": {
        "name": "CUA Driver",
        "description": "后台桌面控制 MCP server（Win/macOS/Linux）— 不抢占光标的计算机使用，含截图/点击/键盘/拖拽/滚动/应用管理",
        "category": "computer",
        "install": {"command": "powershell", "args": ["-NoProfile", "-Command",
                   "$d=\"$env:LOCALAPPDATA\\cua-driver\"; New-Item -ItemType Directory -Force -Path $d|Out-Null;"
                   "Invoke-WebRequest 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64-binary.zip' -OutFile \"$env:TEMP\\cua.zip\";"
                   "Expand-Archive \"$env:TEMP\\cua.zip\" -DestinationPath $d -Force;"
                   "[Environment]::SetEnvironmentVariable('PATH', \"$d;\" + [Environment]::GetEnvironmentVariable('PATH','User'), 'User')"]},
        "run": {"command": "cua-driver", "args": ["mcp"]},
        "requires": "node",
        "note": "cua-driver-rs v0.8.3（Rust 跨平台实现，Windows 原生支持）。"
                "安装后 `cua-driver mcp` 启动 MCP server，提供 40+ 桌面控制工具。"
                "macOS/Linux 替换为 install.sh / install-linux",
    },
    "blender": {
        "name": "Blender MCP",
        "description": "Blender 3D 建模 MCP — 创建/修改 3D 对象/材质/场景，执行 Python 代码",
        "category": "media",
        "install": {"command": "uv", "args": ["tool", "install", "blender-mcp"]},
        "run": {"command": "uvx", "args": ["blender-mcp"]},
        "requires": "blender",
        "note": "需先安装 uv/uvx，并在 Blender 中加载 addon.py 启动 socket server（默认端口 9876）；"
                "BLENDER_HOST/BLENDER_PORT 环境变量可配置连接",
    },
    "officecli": {
        "name": "OfficeCLI MCP",
        "description": "Office 文档操作 MCP — 创建/编辑 Word(.docx) Excel(.xlsx) PowerPoint(.pptx)，通过命名管道高性能通信",
        "category": "office",
        "install": {"command": "powershell", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                   "$s = try { irm 'https://d.officecli.ai/install.ps1' } catch { irm 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.ps1' }; $s | iex"]},
        "run": {"command": "officecli", "args": ["mcp"]},
        "requires": "none",
        "note": "OfficeCLI 是 .NET 编译的二进制工具，通过命名管道与 resident 进程通信实现高性能文档操作。"
                "安装后 `officecli mcp` 启动 MCP server (JSON-RPC over stdio)。"
                "也可通过内置 office_create/office_send/office_batch/office_view 工具直接调用，无需 MCP。"
                "首次使用时自动检测并安装二进制（零配置）。"
                "Skills: officecli, officecli-pptx, officecli-docx, officecli-xlsx",
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
                    "brave_api_key": "🔑", "everart_api_key": "🔑",
                    "cua_driver": "🟡", "blender": "🟡"}.get(req, "🔑")
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
    risk=RiskLevel.WRITE, capability=Capability.MCP)
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
    # 尝试找到实际 settings.json — 优先当前工作目录
    settings_path = None
    for candidate in [os.path.join(os.getcwd(), '.cortx', 'settings.json'),
                      os.path.expanduser('~/.cortex/settings.json')]:
        if os.path.isfile(candidate):
            settings_path = candidate
            break
    if not settings_path:
        settings_path = os.path.join(os.getcwd(), '.cortx', 'settings.json')
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
    risk=RiskLevel.SYSTEM, capability=Capability.MCP)
def mcp_quick(work_dir: str, server: str = "") -> str:
    if not server or server not in MCP_REGISTRY:
        return (f"请指定要试用的 server:\n"
                f"  mcp_quick(server=\"fetch\")       ← HTTP 抓取\n"
                f"  mcp_quick(server=\"playwright\")  ← 浏览器自动化\n"
                f"  mcp_quick(server=\"sqlite\")      ← 数据库查询\n"
                f"可用: {', '.join(sorted(MCP_REGISTRY.keys()))}")
    info = MCP_REGISTRY[server]
    # 0a. 非 MCP 的库类条目（如 browser-use）：只安装并给出使用说明，不尝试 JSON-RPC 列工具
    if info.get("kind") == "library":
        install = info.get("install", {})
        install_cmd = ([install["command"]] + install.get("args", [])) if install else []
        install_out = ""
        if install_cmd:
            try:
                r = subprocess.run(install_cmd, capture_output=True, text=True, timeout=120,
                                  encoding='utf-8', errors='replace')
                install_out = "✅ 安装完成" if r.returncode == 0 else f"⚠ 安装返回码 {r.returncode}: {(r.stderr or r.stdout)[:120]}"
            except Exception as e:
                install_out = f"⚠ 安装失败: {e}"
        note = info.get("note", "")
        return (f"=== {info['name']} ===\n{info['description']}\n\n"
                f"{install_out}\n\n"
                f"📋 使用说明:\n{note}\n\n"
                f"(此条目为 Python 库/CLI，非标准 MCP server，无法通过 JSON-RPC 列出工具)")
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
