"""
Cortex Agent — Harness Agent 架构 + Agentic Loop 引擎
═══════════════════════════════════════════════════════════════

设计哲学：
  「Harness Agent」是一套安全可控的 AI Agent 运行时框架。
  所有工具调用都必须经过 PolicyEngine（完整中介），
  每个 Agent 实例持有独立的 work_dir / executor / observer（share-nothing）。

Agentic Loop（每轮）:
  Think  (LLM 流式推理，reasoning 折叠后可见)
  → Guard (PolicyEngine 按 capability 审计)
  → Act   (隔离执行)
  → Reflect (熔断 / 原地打转检测 / 步数限制)

工具体系（Capability Token）:
  FS_READ / FS_WRITE / DB_READ / SHELL / PYTHON / NET_HTTP / NET_SEARCH

核心安全保证:
  - 完整中介: 所有工具调用必经 PolicyEngine.audit()
  - SSRF 防护: 10 段 CIDR 内网 IP 拦截
  - SQL 注入防护: 词边界正则 + 仅 SELECT
  - Python 沙箱: 子进程隔离 + builtins 清洗
  - 路径穿越防护: 工作目录归一化 + 越权检测
  - share-nothing 实例隔离: 多 Agent 并行不串扰

默认配置: deepseek-v4-flash + thinking=max 思考模式
"""

import os, re, sys, json, time, inspect, shlex, sqlite3, platform, datetime
import subprocess, urllib.parse, urllib.request, urllib.error, ipaddress
from typing import List, Dict, Callable, Optional, Any, Tuple, Set, get_type_hints
from dataclasses import dataclass, field
from enum import Enum

import httpx
from openai import OpenAI


# ══════════════════════════════════════════════════════════════
# 核心类型
# ══════════════════════════════════════════════════════════════

class RiskLevel(Enum):
    SAFE = 0; WRITE = 1; SYSTEM = 2

class AuditVerdict(Enum):
    """PolicyEngine audit 返回的4级判决"""
    ALLOW = "allow"       # 直接执行
    WARN = "warn"         # 执行但记录警告
    CONFIRM = "confirm"   # 暂停等待用户确认
    DENY = "deny"         # 直接拒绝

PERMISSION_MODES = ("standard", "auto-edit", "yolo")

class Capability(Enum):
    """能力令牌"""
    FS_READ = "fs:read"; FS_WRITE = "fs:write"; DB_READ = "db:read"
    SHELL = "shell"; PYTHON = "python"
    NET_HTTP = "net:http"; NET_SEARCH = "net:search"

@dataclass
class StepRecord:
    step: int; timestamp: float; tool_name: str
    tool_args: dict; result_preview: str; success: bool
    risk_level: str = ""; capability: str = ""; latency_ms: float = 0

@dataclass
class RunTrace:
    query: str; steps: List[StepRecord] = field(default_factory=list)
    start_time: float = field(default_factory=time.time)
    final_answer: str = ""; step_limit_reached: bool = False; error: str = ""


# ══════════════════════════════════════════════════════════════
# 模块级 SSRF / DNS 重绑定防护
# ══════════════════════════════════════════════════════════════

_SSRF_BLOCKED_NETS = [
    ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"), ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("224.0.0.0/4"), ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"), ipaddress.ip_network("fe80::/10"),
]

def check_ssrf(host_or_url: str) -> Tuple[bool, str]:
    """Reusable SSRF check. Resolves host to IP, checks against blocked nets.
    Called at Guard time AND at Act time for DNS-rebinding protection.
    Default-deny on DNS failure to prevent rebinding attacks."""
    import socket
    host = host_or_url
    m = re.match(r'https?://(?:\[([^\]]+)\]|([^/:]+))', host_or_url)
    if m:
        host = (m.group(1) or m.group(2)).lower()
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        try:
            addr = ipaddress.ip_address(socket.getaddrinfo(host, 80)[0][4][0])
        except Exception:
            return False, f"SSRF 防护: 无法解析 {host} (DNS失败，默认拒绝)"
    # IPv4-mapped IPv6 → extract IPv4 part
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    for net in _SSRF_BLOCKED_NETS:
        if addr in net:
            return False, f"SSRF 防护: {host} 在禁访范围 {net}"
    return True, ""


# ══════════════════════════════════════════════════════════════
# 工具注册表
# ══════════════════════════════════════════════════════════════

class ToolRegistry:
    """装饰器注册 + 自动 OpenAI Function Schema 生成 + 元数据标注"""
    TYPE_MAP = {str: "string", int: "integer", float: "number", bool: "boolean"}

    def __init__(self):
        self._impl: Dict[str, Callable] = {}
        self._meta: Dict[str, dict] = {}
        self.schemas: List[Dict] = []

    def register(self, description: str, *,
                 risk: RiskLevel = RiskLevel.SAFE,
                 capability: Capability = Capability.FS_READ):
        def deco(fn):
            name = fn.__name__
            self._impl[name] = fn
            self._meta[name] = {"description": description, "risk": risk, "capability": capability}
            sig = inspect.signature(fn); hints = get_type_hints(fn)
            props, required = {}, []
            for pn, p in sig.parameters.items():
                jt = self.TYPE_MAP.get(hints.get(pn, str), "string")
                props[pn] = {"type": jt, "description": pn}
                if p.default is inspect.Parameter.empty: required.append(pn)
            self.schemas.append({
                "type": "function", "function": {
                    "name": name, "description": description,
                    "parameters": {"type": "object", "properties": props, "required": required}}})
            return fn
        return deco

    def get(self, name: str) -> Optional[Callable]: return self._impl.get(name)
    def meta(self, name: str) -> Optional[dict]: return self._meta.get(name)


registry = ToolRegistry()


# ══════════════════════════════════════════════════════════════
# 审计观察者
# ══════════════════════════════════════════════════════════════

class Observer:
    def __init__(self): self.traces: List[RunTrace] = []
    def create_trace(self, query: str) -> RunTrace:
        t = RunTrace(query=query); self.traces.append(t); return t
    def record(self, trace: RunTrace, step: int, name: str, args: dict,
               result: str, success: bool, cap: str, latency_ms: float):
        trace.steps.append(StepRecord(step=step, timestamp=time.time(), tool_name=name,
                                      tool_args=args, result_preview=result[:200],
                                      success=success, capability=str(cap), latency_ms=latency_ms))


# ══════════════════════════════════════════════════════════════
# 上下文治理器

# ══════════════════════════════════════════════════════════════
# 工具执行器
# ══════════════════════════════════════════════════════════════

class ToolExecutor:
    MAX_RESULT_CHARS = 3000

    def __init__(self, registry: 'ToolRegistry', work_dir: str, timeout: int = 10):
        self.reg = registry; self.work_dir = work_dir; self.timeout = timeout

    def execute(self, name: str, args: dict) -> str:
        fn = self.reg.get(name)
        if not fn: return f"(x) 未知工具: {name}"
        meta = self.reg.meta(name)
        if meta and meta["capability"] == Capability.PYTHON:
            return self._exec_python_isolated(args.get("code", ""))
        try:
            clean = {k: v for k, v in args.items() if k != "work_dir"}
            result = fn(self.work_dir, **clean)
            result = str(result) if not isinstance(result, str) else result
            if len(result) > self.MAX_RESULT_CHARS:
                result = result[:self.MAX_RESULT_CHARS] + f"\n\n[...已截断，原{len(result)}字符]"
            return result
        except PermissionError as e: return f"(x) 权限错误: {e}"
        except Exception as e: return f"(x) {e}"

    def _exec_python_isolated(self, code: str) -> str:
        import tempfile, subprocess, sys as _sys, os as _os
        try:
            tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8")
            try:
                tmp.write(code); tmp.close()
                r = subprocess.run([_sys.executable, tmp.name], cwd=self.work_dir,
                                   capture_output=True, text=True, timeout=self.timeout,
                                   env={**_os.environ, "PYTHONPATH": "", "PATH": _os.environ.get("PATH", "")})
                out = (r.stdout + r.stderr).strip()[:3000] or "(无输出)"
                return f"exit={r.returncode}\n{out}"
            finally: _os.unlink(tmp.name)
        except subprocess.TimeoutExpired: return f"(x) Python 超时 (>{self.timeout}s)"
        except Exception as e: return f"(x) Python 沙箱异常: {e}"

# ══════════════════════════════════════════════════════════════

DEFAULT_SYSTEM = (
    "你是 Cortex Agent，一个具备工具调用能力的 AI 助手。\n\n"
    "== 安全边界 ==\n"
    "1. 不得执行可能危害系统安全、泄露数据或破坏系统完整性的操作。\n"
    "2. 文件操作限于工作目录，不得修改系统配置或系统服务。\n"
    "3. 不得将文件内容通过外部网络发送。\n"
    "4. 不得读取系统敏感文件（如 /etc/passwd、~/.ssh、SAM、注册表）。\n"
    "5. 不得使用编码命令或混淆方式执行 shell。\n\n"
    "你有多种工具可用——文件读写、代码执行、网络搜索、数据库查询等。\n"
    "每次行动前先思考需要什么信息、哪个工具最合适。\n"
    "观察工具返回的结果（包括错误），据此调整后续行动，无需等待指令。"
)

class ContextGovernor:
    # Token 估算常量（中文 ≈1.5 token/字，英文 ≈0.75 token/字）
    TOKENS_PER_CHAR = 0.4  # 混合中英文的经验值
    CONTEXT_LIMIT_TOKENS = 1_000_000  # DeepSeek V4 默认 1M，可通过 settings.json 自定义

    def __init__(self, system: str = "", work_dir: str = "", max_msgs: int = 24,
                 memory_context: str = "", history_summary: str = "",
                 kb_context: str = "", context_limit: int = 1_000_000):
        parts = [system or DEFAULT_SYSTEM]
        if kb_context:
            parts.append(f"\n[项目知识库]\n{kb_context}")
        if memory_context:
            parts.append(f"\n{memory_context}")
        if history_summary:
            parts.append(f"\n{history_summary}")
        if work_dir:
            parts.append(f"\n工作目录: {work_dir}")
        content = "\n".join(parts)
        self.system = {"role": "system", "content": content}
        self.max_msgs = max_msgs
        self.context_limit = context_limit
        self._kb_context = kb_context

    @staticmethod
    def estimate_tokens(msgs: list) -> int:
        """估算消息列表的总 token 数（混合中英文经验值）。"""
        total = 0
        for m in msgs:
            content = m.get("content", "") or ""
            # 工具调用的 function 字段
            if m.get("tool_calls"):
                import json as _j
                for tc in m["tool_calls"]:
                    content += _j.dumps(tc.get("function", {}), ensure_ascii=False)
            if isinstance(content, str):
                total += int(len(content) * ContextGovernor.TOKENS_PER_CHAR)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        total += int(len(part["text"]) * ContextGovernor.TOKENS_PER_CHAR)
        return max(total, 1)

    @staticmethod
    def context_pct(msgs: list, limit: int = 1_000_000) -> int:
        """当前上下文窗口使用百分比。"""
        est = ContextGovernor.estimate_tokens(msgs)
        return min(int(est / limit * 100), 99)

    @staticmethod
    def _load_kb(project_dir: str) -> str:
        """加载项目知识库 CORTEX.md（参考 Claude Code CLAUDE.md）。"""
        import os as _os
        kb_path = _os.path.join(project_dir, "CORTEX.md")
        if _os.path.isfile(kb_path):
            try:
                with open(kb_path, "r", encoding="utf-8") as f:
                    content = f.read()
                # 处理 @import 指令
                import re as _re
                def _resolve_imports(text, base_dir, depth=0):
                    if depth > 3:
                        return text
                    def _replace(m):
                        imp_path = m.group(1).strip()
                        full = _os.path.join(base_dir, imp_path)
                        if _os.path.isfile(full):
                            try:
                                with open(full, "r", encoding="utf-8") as f2:
                                    return f2.read()
                            except Exception:
                                return f"(无法读取: {imp_path})"
                        return f"(文件不存在: {imp_path})"
                    return _re.sub(r'@import\s+(\S+)', _replace, text)
                return _resolve_imports(content, _os.path.dirname(kb_path))
            except Exception:
                pass
        return ""

    def init(self, query: str) -> List[Dict]:
        return [self.system, {"role": "user", "content": query}]

    def append_user(self, ctx: List[Dict], query: str) -> List[Dict]:
        ctx.append({"role": "user", "content": query}); return ctx

    def govern(self, msgs: List[Dict]) -> List[Dict]:
        if len(msgs) <= self.max_msgs: return msgs
        limit = self.max_msgs - 1; reserve = set(); has_pair = False
        for i in range(len(msgs) - 1, 1, -1):
            if msgs[i].get("role") == "tool" and msgs[i - 1].get("tool_calls"):
                reserve = {i - 1, i}; has_pair = True; limit -= 2; break
        kept = []; i = len(msgs) - 1
        while i > 0 and len(kept) < max(limit, 0):
            if i in reserve: i -= 1; continue
            kept.append(msgs[i]); i -= 1
        kept.reverse()
        if has_pair:
            a, t = sorted(reserve)
            kept.append(msgs[a]); kept.append(msgs[t])
        trimmed = len(msgs) - 1 - len(kept)
        if trimmed > 0:
            kept.insert(0, {"role": "system", "content": f"[{trimmed}条历史已压缩]"})
            while len(kept) > self.max_msgs - 1: kept.pop(1 if len(kept) > 1 else 0)
        return [msgs[0]] + kept


# ══════════════════════════════════════════════════════════════
# AgentConfig
# ══════════════════════════════════════════════════════════════

@dataclass
class AgentConfig:
    api_key: str = ""
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-v4-flash"
    work_dir: str = field(default_factory=lambda: os.path.abspath("./cortex_workspace"))
    max_steps: int = 10
    tool_timeout: int = 10
    system_prompt: str = ""
    max_context_msgs: int = 24
    loop_timeout: float = 120.0
    think_timeout: float = 60.0
    memory_dir: str = ""
    sessions_dir: str = ""
    skills_dir: str = ""
    auto_extract_memory: bool = True
    memory_enabled: bool = True
    sessions_enabled: bool = True
    # ── Permission model ──
    permission_mode: str = "standard"   # standard | auto-edit | yolo
    permission_remember: bool = True    # 记住用户在会话中的决策
    workspace_only: bool = False        # True=回退到旧沙箱模式
    context_limit: int = 1_000_000     # DeepSeek V4 上下文窗口 (1M tokens)


# ══════════════════════════════════════════════════════════════
# Cortex Agent（Agentic Loop）
# ══════════════════════════════════════════════════════════════

class CortexAgent:
    """Agentic Loop: Think(stream) → Guard → Act → Reflect"""

    def __init__(self, config: AgentConfig = None):
        self.config = config or AgentConfig()
        wd = os.path.realpath(self.config.work_dir)
        os.makedirs(wd, exist_ok=True)
        with open(os.path.join(wd, '.gitkeep'), 'w') as f: f.write('')
        self.policy = PolicyEngine(wd, self.config)
        self.executor = ToolExecutor(registry, wd, self.config.tool_timeout)
        # ── Runtime state (工作区 = 运行时产物) ──
        from . import memory as mem_module
        cwd = os.getcwd()
        # 记忆/会话/目标 → cortex_workspace/ (运行时产物)
        memory_path = self.config.memory_dir or os.path.join(wd, 'memory.md')
        sessions_dir = self.config.sessions_dir or os.path.join(wd, 'sessions')
        setattr(sys.modules[__name__], '_project_memory_path', memory_path)
        setattr(sys.modules[__name__], '_project_sessions_dir', sessions_dir)
        self.memory = mem_module.MemoryStore(memory_path) if self.config.memory_enabled else None
        self.sessions = mem_module.SessionStore(sessions_dir) if self.config.sessions_enabled else None
        # 技能/配置 → .cortex/ (项目配置, Git 追踪)
        from . import skills as _skills
        skills_dir = self.config.skills_dir or os.path.join(cwd, '.cortex', 'skills')
        self.skill_mgr = _skills.SkillManager()
        self.skill_mgr.SKILLS_DIR = skills_dir
        self.skill_mgr.reload()
        # ── Session identity ──
        self._session_id: Optional[str] = None
        self._query_count: int = 0
        self._step_count_total: int = 0
        self._total_traces = 0
        # Build governor with memory injected
        self.governor = self._make_governor()
        self.observer = Observer()
        # ── Adaptive Guard: cumulative rejection tracking ──
        self._rejection_counts: Dict[Capability, int] = {}
        self._suspended_capabilities: Set[Capability] = set()
        self.llm = LLMProvider(self.config.api_key,
                               LLMProvider.resolve(self.config.model), registry.schemas,
                               timeout=self.config.think_timeout)
        self._ctx: List[Dict] = []; self._trace = None
        self._last_reasoning: str = None
        self._term: Optional['Terminal'] = None  # 终端显示回调
        self._label_done = False
        # ── Permission decision memory (session-scoped) ──
        self._permission_decisions: Dict[str, bool] = {}

    def _make_governor(self) -> ContextGovernor:
        """构建 ContextGovernor，注入知识库+记忆+历史摘要+上下文窗口配置。"""
        kb_ctx = self._load_kb()
        memory_ctx = self.memory.to_system_context() if self.memory else ""
        history_summary = ""
        if self.sessions and self._session_id:
            history_summary = self.sessions.get_history_summary(self._session_id) or ""
        return ContextGovernor(self.config.system_prompt,
            self._work_dir_path(), self.config.max_context_msgs,
            memory_context=memory_ctx, history_summary=history_summary,
            kb_context=kb_ctx, context_limit=self.config.context_limit)

    def _load_kb(self) -> str:
        """加载项目知识库 CORTEX.md。"""
        return ContextGovernor._load_kb(self._project_dir())

    def _work_dir_path(self) -> str:
        return os.path.realpath(self.config.work_dir)

    def _project_dir(self) -> str:
        """项目根目录（.cortex/ 配置存储位置），与 memory/sessions/skills 一致。"""
        return os.getcwd()

    @property
    def model(self) -> str: return self.llm.model
    @property
    def work_dir(self) -> str: return self.config.work_dir

    @property
    def context_pct(self) -> int:
        """当前上下文窗口使用百分比。"""
        limit = self.governor.context_limit if hasattr(self.governor, 'context_limit') else self.config.context_limit
        return ContextGovernor.context_pct(self._ctx, limit)

    @property
    def context_tokens(self) -> int:
        """当前上下文估算 token 数。"""
        return ContextGovernor.estimate_tokens(self._ctx)

    @property
    def context_limit(self) -> int:
        return self.config.context_limit

    @property
    def cache_stats(self) -> dict:
        """缓存命中率统计（基于 LLM API 响应）。"""
        return self.llm.cache_stats

    def set_term(self, term: 'Terminal'):
        self._term = term

    def switch_model(self, alias: str):
        self.llm.switch(alias); self.config.model = self.llm.model

    def switch_permission_mode(self, mode: str) -> str:
        """运行时切换权限模式。返回新模式的描述。
        
        模式说明（参考 Claude Code / Codex 设计）:
          standard  — 默认模式，SAFE 工具自动放行，WRITE 工作区内放行，SYSTEM 需确认
          auto-edit — 自动批准文件编辑，SYSTEM 自动放行
          yolo      — 全部放行（含路径穿越），CI/CD 场景
        """
        mode = mode.lower().strip()
        if mode in ("s", "std", "standard"):
            self.config.permission_mode = "standard"
            return "standard — SAFE自动 / WRITE区内 / SYSTEM需确认"
        elif mode in ("a", "auto", "auto-edit", "edit"):
            self.config.permission_mode = "auto-edit"
            return "auto-edit — 自动批准编辑 + SYSTEM放行"
        elif mode in ("y", "yolo", "full", "bypass"):
            self.config.permission_mode = "yolo"
            return "yolo — 全部放行（⚠️ 路径穿越不设防）"
        else:
            return f"(x) 未知模式: {mode}\n可用: standard | auto-edit | yolo"

    # ── Agentic Loop ──

    def init_session(self, session_id: str = None, resume: bool = False) -> str:
        """初始化或恢复会话。返回 session_id。"""
        # 重建 governor（含历史摘要 + 记忆）— 提前构建以便恢复时注入 system prompt
        self.governor = self._make_governor()
        if resume and self.sessions:
            sid = session_id or self.sessions.get_last_session()
            if sid:
                try:
                    saved_ctx, meta = self.sessions.load(sid)
                    # 恢复后注入 system prompt（save 跳过 ctx[0]，恢复时重新插入）
                    if saved_ctx and saved_ctx[0].get("role") != "system":
                        saved_ctx.insert(0, self.governor.system)
                    self._ctx = saved_ctx
                    self._session_id = sid
                    self._query_count = meta.get("query_count", 0)
                    self._step_count_total = meta.get("step_count", 0)
                except (FileNotFoundError, ValueError):
                    sid = None
            if sid is None:
                sid = session_id or self.sessions.generate_id()
                self._session_id = sid; self._query_count = 0; self._step_count_total = 0; self._ctx = []
        else:
            sid = session_id or (self.sessions.generate_id() if self.sessions else "default")
            self._session_id = sid; self._query_count = 0; self._step_count_total = 0; self._ctx = []
        # governor 已在方法开头构建
        return sid

    def run(self, query: str, max_steps: int = None, keep_history: bool = False) -> str:
        if not keep_history or not self._ctx:
            self._ctx = self.governor.init(query)
        else:
            self._ctx = self.governor.append_user(self._ctx, query)
        result = self._loop(max_steps or self.config.max_steps)
        # ── Post-loop: auto-save + auto-extract ──
        self._query_count += 1
        self._step_count_total += len(self._trace.steps) if self._trace else 0
        self._auto_save()
        if self.config.auto_extract_memory and self.memory:
            self._auto_extract_facts(query)
        return result

    def chat(self, query: str, max_steps: int = None) -> str:
        return self.run(query, max_steps, keep_history=True)

    def save_session(self, label: str = None) -> str:
        """手动保存当前会话。返回 session_id。"""
        if not self.sessions or not self._session_id:
            return ""
        meta = {"session_id": self._session_id, "label": label or "",
                "last_active": datetime.datetime.now().isoformat(),
                "model": self.config.model, "query_count": self._query_count,
                "step_count": self._step_count_total,
                "work_dir": self.config.work_dir}
        self.sessions.save(self._session_id, self._ctx, meta)
        return self._session_id

    def reset(self):
        """完整重置：上下文 + 拒绝计数 + 暂停状态 + trace + 权限决策。"""
        self._ctx = []
        self._rejection_counts.clear()
        self._suspended_capabilities.clear()
        self._permission_decisions.clear()
        self._trace = None
        self._last_reasoning = None

    def _request_confirmation(self, tool_name: str, args: dict, capability: str) -> bool:
        """向用户请求工具执行授权。返回 True=允许, False=拒绝。"""
        # 使用完整参数生成缓存 key（排除 work_dir）
        safe_args = {k: v for k, v in args.items() if k != "work_dir"}
        key = f"{tool_name}:{str(sorted(safe_args.items()))}"
        if self.config.permission_remember and key in self._permission_decisions:
            return self._permission_decisions[key]
        if not self._term:
            return False  # 非交互模式默认拒绝
        self._term._end_reasoning()
        desc = f"  {self._term.CYAN}▸ {tool_name}{self._term.RESET} [{capability}]"
        path = args.get("path") or args.get("url") or args.get("command", "")[:40]
        self._term._w(f"\n  {self._term.YELLOW}⚠ 需要授权:{self._term.RESET} {desc}\n")
        self._term._w(f"     {self._term.GRAY}{path}{self._term.RESET}\n")
        self._term._w(f"     [{self._term.GREEN}Y{self._term.RESET}/{self._term.RED}n{self._term.RESET}/{self._term.GREEN}always{self._term.RESET}/{self._term.RED}deny{self._term.RESET}] ")
        try:
            ans = input().strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False
        if ans in ("y", "yes", "always"):
            if ans == "always":
                self._permission_decisions[key] = True
            return True
        if ans == "deny":
            self._permission_decisions[key] = False
        return False

    def _auto_save(self):
        """每轮后自动持久化会话。"""
        if not self.sessions or not self._session_id:
            return
        try:
            meta = {"session_id": self._session_id,
                    "last_active": datetime.datetime.now().isoformat(),
                    "model": self.config.model, "query_count": self._query_count,
                    "step_count": self._step_count_total,
                    "work_dir": self.config.work_dir}
            self.sessions.save(self._session_id, self._ctx, meta)
        except Exception as e:
            if self._term:
                self._term.error(f"会话保存失败: {e}")

    def _auto_extract_facts(self, user_query: str):
        """Agent 自行判断何时使用 remember_fact 工具——Harness 不注入提示。"""
        pass

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    def _loop(self, max_steps: int) -> str:
        trace = self.observer.create_trace(self._ctx[-1]["content"] if self._ctx else "")
        self._trace = trace; self._label_done = False
        if self._term:
            self._term.next_round()
        for step_no in range(1, max_steps + 1):
            self._ctx = self.governor.govern(self._ctx)
            content, tool_calls = self._think()
            if content is None and not tool_calls:
                trace.error = "LLM 调用失败"; return trace.error
            if not tool_calls:
                # push assistant reply into ctx so multi-turn remembers it
                self._ctx.append({"role": "assistant", "content": content})
                trace.final_answer = content
                return "" if self._term else content
            # tool calls — push the assistant message with tool_calls into ctx
            self._ctx.append({"role": "assistant", "content": content or "", "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": json.dumps(tc["args"], ensure_ascii=False)}}
                for tc in tool_calls
            ]})
            for tc in tool_calls:
                t0 = time.time(); name, args = tc["name"], tc["args"]
                meta = registry.meta(name)
                cap_str = meta["capability"].value if meta else "?"
                cap = meta["capability"] if meta else None
                if self._term:
                    self._term.tool_start(name, args)
                # ── Guard: capability suspension check ──
                if cap and cap in self._suspended_capabilities:
                    ok, reason = False, f"能力 {cap.value} 已被暂停"
                else:
                    ok, reason = self.policy.audit(name, args)
                # ── CONFIRM → 等待用户授权 ──
                if not ok and reason == "confirm":
                    ok = self._request_confirmation(name, args, cap_str)
                    reason = "用户授权" if ok else "用户拒绝"
                # ── Adaptive Guard: track rejections ──
                if not ok:
                    if cap and "用户" not in reason:
                        self._rejection_counts[cap] = self._rejection_counts.get(cap, 0) + 1
                        cnt = self._rejection_counts[cap]
                        if cnt >= 3:
                            self._suspended_capabilities.add(cap)
                            result = f"(x) [Policy 拦截] {cap.value} 能力已被暂停（连续 {cnt} 次违规），本次会话中不可用。"
                        else:
                            result = f"(x) [Policy 拦截] {reason}"
                    else:
                        result = f"(x) [Policy 拦截] {reason}"
                elif reason.startswith(PolicyEngine.WARN_PREFIX):
                    # WARN tier: execute but annotate
                    warn_msg = reason[len(PolicyEngine.WARN_PREFIX):]
                    result = self.executor.execute(name, args)
                    result = f"[注意: {warn_msg}]\n{result}"
                else:
                    result = self.executor.execute(name, args)
                latency = (time.time() - t0) * 1000
                self.observer.record(trace, step_no, name, args, result, ok, cap_str, latency)
                if self._term:
                    self._term.tool_done(ok, latency, result)
                self._ctx.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
            result = self._reflect(trace, step_no, max_steps)
            if result is not None: return result
            self._last_reasoning = None
        trace.step_limit_reached = True
        return "[超步数] 未能完成"

    def _reflect(self, trace, step_no, max_steps) -> Optional[str]:
        """结构性收敛：仅在达到最大步数时给予一次最终回答机会。"""
        if step_no == max_steps:
            final, tcs = self._think()
            if final:
                trace.final_answer = final
                return final if not tcs else final + "\n\n[已达最大步数，工具调用未执行]"
            return "[达到最大步数]"
        return None

    def _think(self) -> Tuple[Optional[str], Optional[List[Dict]]]:
        term = self._term
        for attempt in range(3):
            try:
                if term:
                    # terminal streaming path: deep reasoning + bright answer
                    text, tcs, reasoning = self.llm.call_stream(
                        self._ctx,
                        on_text=term.think_token,
                        on_answer=term.answer_token,
                        on_tool=self._tool_labeled())
                    if reasoning: self._last_reasoning = reasoning
                    return text, tcs
                else:
                    text, tcs, reasoning = self.llm.call(self._ctx)
                    if reasoning: self._last_reasoning = reasoning
                    return text, tcs
            except Exception as e:
                if attempt < 2: time.sleep(0.5 * (attempt + 1))
        return None, None  # 失败返回 None，让 _loop 正确处理

    def _tool_labeled(self):
        """on_tool 回调 — 哨兵 name=\"\" 时关闭推理颜色"""
        def cb(name: str, args: dict):
            if not name and self._term:
                self._term.close_thinking()
        return cb

    def last_trace(self) -> Optional[RunTrace]: return self._trace

    # ── Goal 管理（参考 Claude Code /goal）──
    
    @property
    def goal(self) -> str:
        """读取持久化目标（存储在 cortex_workspace/GOAL.txt）。"""
        goal_file = os.path.join(self._work_dir_path(), 'GOAL.txt')
        if os.path.isfile(goal_file):
            try:
                with open(goal_file, 'r', encoding='utf-8') as f:
                    return f.read().strip()
            except Exception:
                return ""
        return ""

    def set_goal(self, text: str) -> str:
        """设置持久化目标。空文本=清除。"""
        goal_file = os.path.join(self._work_dir_path(), 'GOAL.txt')
        if text.strip():
            with open(goal_file, 'w', encoding='utf-8') as f:
                f.write(text.strip())
            # 注入目标到系统消息
            self._ctx.append({"role": "user", "content": f"[目标] {text.strip()}"})
            return text.strip()
        else:
            if os.path.isfile(goal_file):
                os.remove(goal_file)
            return ""

# ── 延迟导入（避免循环依赖）──
from .policy import PolicyEngine
from .llm import LLMProvider
