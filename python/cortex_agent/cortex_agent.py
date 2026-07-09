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
  FS_READ / FS_WRITE / DB_READ / SHELL / PYTHON / NET_HTTP / NET_SEARCH / MCP / BROWSER

核心安全保证:
  - 完整中介: 所有工具调用必经 PolicyEngine.audit()
  - SSRF 防护: 8 段 CIDR 内网 IP 拦截
  - SQL 注入防护: 词边界正则 + 仅 SELECT
  - Python 沙箱: 子进程隔离 + builtins 清洗
  - 路径穿越防护: 工作目录归一化 + 越权检测
  - share-nothing 实例隔离: 多 Agent 并行不串扰

默认配置: deepseek-v4-flash + thinking=max 思考模式
"""

import os, re, sys, json, time, inspect, shlex, sqlite3, platform, datetime
import subprocess, urllib.parse, urllib.request, urllib.error, ipaddress
from typing import List, Dict, Callable, Optional, Any, Tuple, Set, get_type_hints, TYPE_CHECKING

if TYPE_CHECKING:
    from .terminal import Terminal
from dataclasses import dataclass, field
from enum import Enum

import httpx
from openai import OpenAI

from .hooks import HookContext


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

PERMISSION_MODES = ("standard", "auto", "yolo")

class Capability(Enum):
    """能力令牌"""
    FS_READ = "fs:read"; FS_WRITE = "fs:write"; DB_READ = "db:read"
    SHELL = "shell"; PYTHON = "python"
    NET_HTTP = "net:http"; NET_SEARCH = "net:search"
    MCP = "mcp"; BROWSER = "browser"

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
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("fc00::/7"), ipaddress.ip_network("fe80::/10"),
]
# 注意：127.0.0.0/8 和 ::1/128 已移除 — 允许 localhost 开发访问

def check_ssrf(host_or_url: str) -> Tuple[bool, str]:
    """Reusable SSRF check. Resolves host to IP, checks against blocked nets.
    Called at Guard time AND at Act time for DNS-rebinding protection.
    DNS 失败时放行 — 让 HTTP 层自行处理（企业 DNS/VPN 环境兼容）。"""
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
            # DNS 失败 — 放行，让 HTTP 层自行处理
            return True, ""
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
    """工具执行器 — 隔离执行 + 智能结果截断。

    截断策略（参考 Claude Code tool result handling）:
      - 默认截断到 10000 字符（可在 settings.json 中通过 max_result_chars 自定义）
      - 保留首尾内容，中间用省略标记
      - Python 沙箱输出单独截断
    """
    MAX_RESULT_CHARS = 10000  # 类常量保留作为默认值和向后兼容

    def __init__(self, registry: 'ToolRegistry', work_dir: str, timeout: int = 0, max_result_chars: int = 0):
        self.reg = registry; self.work_dir = work_dir; self.timeout = timeout
        self.max_result_chars = max_result_chars if max_result_chars > 0 else ToolExecutor.MAX_RESULT_CHARS

    # camelCase → snake_case 别名映射，使 Python 端兼容 TS 风格的参数名
    _CAMEL_ALIASES = {
        "filePath": "path", "dirPath": "path", "outPath": "out_path",
        "oldString": "old_string", "newString": "new_string",
        "fileA": "file_a", "fileB": "file_b", "globFilter": "glob_filter",
        "maxResults": "max_results", "maxChars": "max_chars",
        "allowedDomains": "allowed_domains", "blockedDomains": "blocked_domains",
        "branchName": "branch_name", "taskId": "task_id",
    }

    def execute(self, name: str, args: dict) -> str:
        fn = self.reg.get(name)
        if not fn: return f"(x) 未知工具: {name}"
        try:
            clean = {k: v for k, v in args.items() if k != "work_dir"}
            # camelCase 别名归一化：接受 TS 风格参数名，转为本工具的 snake_case
            clean = {self._CAMEL_ALIASES.get(k, k): v for k, v in clean.items()}
            result = fn(self.work_dir, **clean)
            result = str(result) if not isinstance(result, str) else result
            return self._truncate(result)
        except PermissionError as e: return f"(x) 权限错误: {e}"
        except Exception as e: return f"(x) {e}"

    def _truncate(self, result: str) -> str:
        """智能截断：保留首尾，中间省略。"""
        limit = self.max_result_chars
        if len(result) <= limit:
            return result
        head = limit * 2 // 3
        tail = limit // 3
        omitted = len(result) - head - tail
        return f"{result[:head]}\n\n[...已截断，省略 {omitted} 字符...]\n\n{result[-tail:]}"

# ══════════════════════════════════════════════════════════════

DEFAULT_SYSTEM = (
    "你是 Cortex Agent，一个具备工具调用能力的 AI 助手，专为企业级大型项目连续开发而设计。\n\n"
    "== 最高优先级规则：判断是否需要工具 ==\n"
    "在收到用户输入后，你首先必须判断：这个请求是否需要调用工具？\n\n"
    "  【不需要工具 → 直接回复】以下情况，不要调用任何工具，直接用文字回复用户：\n"
    "  - 问候、闲聊（如「你好」「谢谢」「你是谁」）\n"
    "  - 你已具备知识可以直接回答的问题（如「Python 怎么读文件」「HTTP 状态码 404 是什么意思」）\n"
    "  - 对之前工作的简单询问（如「你刚才做了什么」「总结一下进度」）\n\n"
    "  【需要工具 → 进入工作循环】以下情况，使用工具完成任务：\n"
    "  - 需要读取/写入/修改文件\n"
    "  - 需要执行 shell 命令\n"
    "  - 需要搜索网络获取实时信息\n"
    "  - 需要操作浏览器、数据库等外部系统\n\n"
    "  ⚠ 重要：用户没有明确要求「继续之前的任务」时，不要因为上下文中有历史操作记录就自行继续旧任务。\n"
    "  每次用户输入都是一个新的请求，请根据当前输入的内容判断意图。\n\n"
    "== 核心工作循环（需要工具时遵守）==\n"
    "当用户的请求需要使用工具时，你必须遵循以下循环：\n\n"
    "  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐\n"
    "  │  思考    │ →  │  调用工具 │ →  │  反思    │ →  │  继续/完成 │\n"
    "  │ (Think)  │     │  (Act)   │     │(Reflect) │     │(Loop/Done)│\n"
    "  └─────────┘     └─────────┘     └─────────┘     └─────────┘\n\n"
    "**第一步：思考（必须）**\n"
    "  在调用任何工具之前，你必须先思考：\n"
    "  - 用户想要什么？当前任务的目标是什么？\n"
    "  - 我已经知道什么？还缺少什么信息？\n"
    "  - 下一步应该做什么？为什么选择这个方案？\n"
    "  - 不要跳过思考直接调用工具。先想清楚再行动。\n\n"
    "**第二步：调用工具**\n"
    "  经过思考后，如果需要使用工具来完成当前步骤：\n"
    "  - 调用最合适的工具（优先专用工具，如 edit_file 而非 shell）\n"
    "  - 每次只调用当前步骤需要的工具，不要一次调用过多工具\n\n"
    "**第三步：反思（必须）**\n"
    "  拿到工具返回结果后，你必须反思：\n"
    "  - 工具执行成功了吗？结果是否符合预期？\n"
    "  - 当前任务完成了吗？还有哪些步骤没做？\n"
    "  - 如果有错误，根因是什么？如何修复？\n"
    "  - 如果任务完成，直接给出最终回答（不再调用工具）\n"
    "  - 如果任务未完成，继续下一轮思考→调用→反思\n\n"
    "**第四步：完成判断**\n"
    "  当所有步骤都完成后，给出清晰的最终回答。\n"
    "  不要在任务完成后继续调用不必要的工具。\n"
    "  最终回答应该总结你完成的工作和关键结果。\n\n"
    "== 安全边界 ==\n"
    "1. 不得执行可能危害系统安全、泄露数据或破坏系统完整性的操作。\n"
    "2. 不得修改系统配置或系统服务文件（如 C:\\Windows, /etc 等）。\n"
    "3. 不得将文件内容通过外部网络发送。\n"
    "4. 不得读取系统敏感文件（如 /etc/passwd、~/.ssh、SAM、注册表）。\n"
    "5. 不得使用编码命令或混淆方式执行 shell。\n"
    "6. 文件操作可以在用户目录范围内自由进行（桌面、文档、工作目录等）。\n\n"
    "== 企业级大项目工程指引 ==\n"
    "你具备连续长时间工作的能力，可以完成 10 万行以上代码的大型项目。遵循以下原则：\n"
    "1. **任务分解**：复杂任务先用 write_file 创建 TASKS.md，分解为里程碑和子任务。\n"
    "2. **渐进式开发**：按依赖顺序逐个模块完成。每完成一个子任务更新 TASKS.md 标记 [x]。\n"
    "3. **即时验证**：写完代码文件后立即运行编译或语法检查，发现错误立即修复。\n"
    "4. **问题感知与自修复**：当工具返回错误时，仔细阅读错误信息，定位根因，使用 edit_file 修复后重新验证。\n"
    "5. **上下文管理**：当上下文被压缩时，通过读取 TASKS.md 和已有代码文件恢复进度感知。\n"
    "6. **最终验证**：所有模块完成后运行完整构建和测试，确保零错误。\n\n"
    "== 服务器启动与验证指引 ==\n"
    "当需要启动开发服务器（Flask/Django/Express/Vite 等）进行端到端验证时：\n"
    "  1. **使用 run_background_command** 在后台启动服务器，不要用 run_shell_command（会被阻塞检测拦截）\n"
    "  2. **等待 2-3 秒** 让服务器完成启动（可以先做其他操作）\n"
    "  3. **使用 check_server_status** 发送 HTTP 请求验证服务是否正常响应\n"
    "  4. **验证完成后** 使用 stop_background_process 停止后台进程\n"
    "  示例流程：\n"
    "    run_background_command(command='python app.py')  → 返回 PID\n"
    "    check_server_status(url='http://localhost:5000/api/health')  → 验证服务\n"
    "    stop_background_process(pid=12345)  → 清理进程\n\n"
    "联网搜索或查询实时信息前，先调用 get_current_time 获取当前时间以确保时效性。\n"
    "搜索时务必将获取到的具体年份和月份直接写入搜索关键词中。"
)

class ContextGovernor:
    """上下文治理器 — token 体积感知 + 工具结果自动压缩。

    设计哲学（参考 Claude Code context window 管理）:
      - 不只按消息条数裁剪，更按 token 体积裁剪
      - tool result 超长时自动压缩为摘要（保留首尾 + 中间省略）
      - 保留最近一轮 tool_call + tool_result 完整配对
      - system prompt 永不裁剪

    三级输入压力预警:
      80% max_input_tokens → WARN  (压缩超长 tool result)
      90% max_input_tokens → FORCE (丢弃最早非 system 消息)
      100% max_input_tokens → HARD  (只保留 system + 最近3条)
    """
    TOKENS_PER_CHAR = 0.4  # 混合中英文经验值
    CONTEXT_LIMIT_TOKENS = 1_000_000
    # 工具结果压缩阈值（字符数）
    COMPRESS_THRESHOLD = 1500
    COMPRESS_HEAD = 600
    COMPRESS_TAIL = 400
    # 安全余量：预留给 tokenizer 估算误差 + tool schema 开销
    SAFETY_MARGIN = 4096
    # 输入 token 预警线（占 max_input_tokens 的百分比）
    INPUT_WARN_PCT = 80
    INPUT_FORCE_PCT = 90

    def __init__(self, system: str = "", work_dir: str = "", max_msgs: int = 24,
                 memory_context: str = "", history_summary: str = "",
                 kb_context: str = "", context_limit: int = 1_000_000,
                 max_input_tokens: int = 0, max_tokens: int = 16384,
                 compress_threshold: int = 0, compress_head: int = 0,
                 compress_tail: int = 0, safety_margin: int = 0,
                 input_warn_pct: int = 0, input_force_pct: int = 0):
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
        self.max_tokens = max_tokens
        # 可调参数：使用传入值或回退到类常量默认值
        self.compress_threshold = compress_threshold or ContextGovernor.COMPRESS_THRESHOLD
        self.compress_head = compress_head or ContextGovernor.COMPRESS_HEAD
        self.compress_tail = compress_tail or ContextGovernor.COMPRESS_TAIL
        self.safety_margin = safety_margin or ContextGovernor.SAFETY_MARGIN
        self.input_warn_pct = input_warn_pct or ContextGovernor.INPUT_WARN_PCT
        self.input_force_pct = input_force_pct or ContextGovernor.INPUT_FORCE_PCT
        # max_input_tokens: 0 = 自动计算 (context_limit - max_tokens - safety_margin)
        if max_input_tokens and max_input_tokens > 0:
            self.max_input_tokens = max_input_tokens
        else:
            self.max_input_tokens = max(context_limit - max_tokens - self.safety_margin, 16000)
        self._kb_context = kb_context

    @staticmethod
    def estimate_tokens(msgs: list) -> int:
        """估算消息列表的总 token 数（混合中英文经验值）。"""
        total = 0
        for m in msgs:
            content = m.get("content", "") or ""
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
        if limit <= 0:
            return 0
        est = ContextGovernor.estimate_tokens(msgs)
        return min(int(est / limit * 100), 100)

    def _compress_result(self, text: str) -> str:
        """压缩超长工具结果：保留首尾，中间用省略标记替代。"""
        if len(text) <= self.compress_threshold:
            return text
        head = text[:self.compress_head]
        tail = text[-self.compress_tail:]
        omitted = len(text) - self.compress_head - self.compress_tail
        return f"{head}\n\n[...已压缩，省略 {omitted} 字符...]\n\n{tail}"

    @staticmethod
    def _load_kb(project_dir: str) -> str:
        """加载项目知识库 CORTEX.md（参考 Claude Code CLAUDE.md）。"""
        import os as _os
        kb_path = _os.path.join(project_dir, "CORTEX.md")
        if _os.path.isfile(kb_path):
            try:
                with open(kb_path, "r", encoding="utf-8") as f:
                    content = f.read()
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
        """三重裁剪：条数裁剪 + tool result 压缩 + 输入 token 体积管控。

        裁剪策略（参考 Claude Code 的 context window 管理）:
          1. 按条数裁剪到 max_msgs，保留最近一轮 tool_call+result 配对
          2. 遍历保留的消息，对超长 tool result 执行首尾压缩
          3. 输入 token 三级预警:
             ≥80% max_input_tokens → 压缩所有 tool result（即使未超 COMPRESS_THRESHOLD 的也强制压缩）
             ≥90% max_input_tokens → 丢弃最早的非 system 消息
             ≥100% max_input_tokens → 只保留 system + 最近 3 条
        """
        # Step 1: 条数裁剪
        if len(msgs) <= self.max_msgs:
            result = list(msgs)
        else:
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
            result = [msgs[0]] + kept

        # Step 2: 压缩超长 tool result
        for m in result:
            if m.get("role") == "tool":
                content = m.get("content", "")
                if isinstance(content, str) and len(content) > self.compress_threshold:
                    m["content"] = self._compress_result(content)

        # Step 3: 输入 token 体积管控（三级预警）
        input_tokens = self.estimate_tokens(result)
        warn_threshold = int(self.max_input_tokens * self.input_warn_pct / 100)
        force_threshold = int(self.max_input_tokens * self.input_force_pct / 100)

        if input_tokens >= self.max_input_tokens:
            # HARD: 只保留 system + 最近 3 条
            if len(result) > 4:
                result = [result[0]] + result[-3:]
        elif input_tokens >= force_threshold:
            # FORCE: 逐步丢弃最早的非 system 消息，直到降到 force_threshold 以下
            while len(result) > 4 and self.estimate_tokens(result) >= force_threshold:
                result.pop(1)
            # 压缩标记
            result.insert(1, {"role": "system", "content": "[上下文压力过高，已强制裁剪历史]"})
        elif input_tokens >= warn_threshold:
            # WARN: 强制压缩所有 tool result（包括未超阈值的）
            for m in result:
                if m.get("role") == "tool":
                    content = m.get("content", "")
                    if isinstance(content, str) and len(content) > 200:
                        m["content"] = self._compress_result(content)

        # Step 4: 修复 tool_calls/tool 配对完整性
        # 裁剪可能打破 assistant(tool_calls) → tool(result) 的配对关系
        # 导致 LLM API 报错: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
        result = self._fix_tool_pairing(result)

        return result

    @staticmethod
    def _fix_tool_pairing(msgs: list) -> list:
        """修复 tool_calls/tool 配对完整性。

        规则:
          1. 如果 assistant 消息有 tool_calls，但其后缺少对应的 tool 结果，
             则移除该 assistant 消息的 tool_calls（保留 content 作为普通回复）
          2. 如果 tool 消息的前一条不是带 tool_calls 的 assistant 消息，
             则移除该孤立的 tool 消息
          3. 如果 assistant 有多个 tool_calls 但只有部分有 tool 结果，
             只保留有结果的部分
          4. 只保留 tool_call_id 在 tool_calls 中的 tool 结果，过滤孤立的
        """
        if not msgs:
            return msgs
        fixed = []
        i = 0
        while i < len(msgs):
            m = msgs[i]
            if m.get("role") == "assistant" and m.get("tool_calls"):
                # 收集这个 assistant 消息之后所有连续的 tool 结果
                tc_ids = {tc.get("id") for tc in m["tool_calls"]}
                tool_results = []
                j = i + 1
                while j < len(msgs) and msgs[j].get("role") == "tool":
                    tool_results.append(msgs[j])
                    j += 1
                # 只保留 tool_call_id 在 tc_ids 中的 tool 结果（过滤孤立结果）
                matched_results = [tr for tr in tool_results if tr.get("tool_call_id") in tc_ids]
                matched_ids = {tr.get("tool_call_id") for tr in matched_results}
                if matched_ids:
                    # 有匹配的 tool 结果 → 只保留有结果的 tool_calls
                    kept_tcs = [tc for tc in m["tool_calls"] if tc.get("id") in matched_ids]
                    new_m = dict(m)
                    new_m["tool_calls"] = kept_tcs
                    fixed.append(new_m)
                    fixed.extend(matched_results)
                else:
                    # 没有任何匹配的 tool 结果 → 移除 tool_calls，保留 content
                    new_m = dict(m)
                    del new_m["tool_calls"]
                    if new_m.get("content"):
                        fixed.append(new_m)
                    # content 也为空则跳过
                i = j
            elif m.get("role") == "tool":
                # 孤立的 tool 消息（前面没有带 tool_calls 的 assistant）
                # 直接跳过
                i += 1
            else:
                fixed.append(m)
                i += 1
        return fixed

    def input_tokens_pct(self, msgs: list) -> int:
        """当前输入 token 占 max_input_tokens 的百分比。"""
        if self.max_input_tokens <= 0:
            return 0
        est = self.estimate_tokens(msgs)
        return min(int(est / self.max_input_tokens * 100), 100)

    def compact(self, msgs: list, keep_recent: int = 10) -> list:
        """上下文压缩 — 将旧消息摘要为单条 system 消息，保留最近 N 条。

        与 govern() 的区别：
          - govern() 做细粒度裁剪（条数+token+压缩 tool result）
          - compact() 做粗粒度摘要（把几十条旧对话压缩成一段文字）

        策略：
          1. 保留 system[0] + 最近 keep_recent 条消息
          2. 中间消息提取关键信息（工具调用名、文件操作、用户请求）压缩为摘要
          3. 修复 tool 配对
        """
        if len(msgs) <= keep_recent + 1:
            return msgs
        system = msgs[0] if msgs and msgs[0].get("role") == "system" else None
        recent = msgs[-keep_recent:]
        old = msgs[1:-keep_recent] if system else msgs[:-keep_recent]

        # 提取关键信息
        summary_parts = []
        tool_calls_seen = []
        files_touched = set()
        for m in old:
            role = m.get("role", "")
            if role == "user":
                content = (m.get("content") or "")[:120]
                if content.strip():
                    summary_parts.append(f"用户请求: {content}")
            elif role == "assistant":
                tcs = m.get("tool_calls", [])
                for tc in tcs:
                    fn = tc.get("function", {})
                    name = fn.get("name", "")
                    tool_calls_seen.append(name)
                    args = fn.get("arguments", "{}")
                    # 提取文件路径
                    try:
                        args_dict = json.loads(args) if isinstance(args, str) else args
                        for v in args_dict.values():
                            if isinstance(v, str) and ("/" in v or "\\" in v or v.endswith((".py", ".ts", ".js", ".html", ".css", ".json", ".md"))):
                                files_touched.add(v[:80])
                    except (json.JSONDecodeError, TypeError):
                        pass
                content = (m.get("content") or "")[:80]
                if content.strip():
                    summary_parts.append(f"Agent: {content}")
            elif role == "tool":
                content = m.get("content", "")
                if isinstance(content, str) and len(content) > 100:
                    summary_parts.append(f"  → 结果({len(content)}字符): {content[:80]}...")

        # 构建压缩摘要
        compact_text = f"[上下文压缩 — {len(old)}条消息已摘要]\n"
        if tool_calls_seen:
            # 统计工具使用频率
            from collections import Counter
            freq = Counter(tool_calls_seen)
            tools_summary = ", ".join(f"{name}×{cnt}" for name, cnt in freq.most_common(8))
            compact_text += f"工具调用: {tools_summary}\n"
        if files_touched:
            compact_text += f"涉及文件: {', '.join(list(files_touched)[:10])}\n"
        if summary_parts:
            # 限制摘要长度
            compact_body = "\n".join(summary_parts[-20:])  # 最多 20 条摘要
            if len(compact_body) > 2000:
                compact_body = compact_body[:2000] + "..."
            compact_text += f"对话摘要:\n{compact_body}\n"

        result = []
        if system:
            result.append(system)
        result.append({"role": "system", "content": compact_text})
        result.extend(recent)
        # 修复可能的 tool 配对断裂
        return self._fix_tool_pairing(result)


# ══════════════════════════════════════════════════════════════
# AgentConfig
# ══════════════════════════════════════════════════════════════

@dataclass
class AgentConfig:
    api_key: str = ""
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-v4-flash"
    work_dir: str = field(default_factory=lambda: os.path.join(os.path.expanduser("~"), ".cortx", "workspace"))
    max_steps: int = 0               # 0=无限（不限制步数，agent 自主决定何时完成）
    tool_timeout: int = 30           # 工具执行超时（秒），0=无超时（默认 30s，避免阻塞命令挂起）
    system_prompt: str = ""
    max_context_msgs: int = 50
    loop_timeout: float = 0.0        # 0=无超时（支持 24h 连续运行）
    think_timeout: float = 600.0     # 单次 LLM 调用超时（10 分钟，复杂推理足够）
    # ── 长时运行参数 ──
    max_rounds: int = 0              # 0=无限续行; >0=最多续行 N 轮
    checkpoint_interval: int = 5     # 每 N 步自动保存检查点
    retry_max: int = 5               # 瞬态错误重试次数（增强长时运行韧性）
    retry_base_delay: float = 2.0    # 指数退避基础延迟（秒）
    compact_threshold: int = 60      # 上下文消息数超过此值时触发压缩
    memory_dir: str = ""
    sessions_dir: str = ""
    skills_dir: str = ""
    auto_extract_memory: bool = True
    memory_enabled: bool = True
    sessions_enabled: bool = True
    # ── Permission model ──
    permission_mode: str = "standard"   # standard | auto | yolo
    permission_remember: bool = True    # 记住用户在会话中的决策
    workspace_only: bool = False        # True=回退到旧沙箱模式
    context_limit: int = 0              # 0=自动从模型能力注册表解析
    max_tokens: int = 0                # 0=自动从模型能力注册表解析
    max_input_tokens: int = 0          # 0=自动计算: context_limit - max_tokens - safety_margin
    # ── ContextGovernor 可调参数 (均可在 settings.json 中自定义) ──
    compress_threshold: int = 1500     # tool result 压缩阈值（字符数）
    compress_head: int = 600           # 压缩时保留的首部字符数
    compress_tail: int = 400           # 压缩时保留的尾部字符数
    safety_margin: int = 4096          # tokenizer 估算误差 + tool schema 开销的安全余量
    input_warn_pct: int = 80           # 输入 token 占比达此百分比时触发 WARN 压缩
    input_force_pct: int = 90          # 输入 token 占比达此百分比时触发 FORCE 裁剪
    # ── ToolExecutor 可调参数 ──
    max_result_chars: int = 10000      # 工具结果截断阈值（支持大代码文件查看）
    # ── Memory 注入控制 ──
    memory_inject_count: int = 30      # 注入 system prompt 的最大记忆条数


# ══════════════════════════════════════════════════════════════
# Cortex Agent（Agentic Loop）
# ══════════════════════════════════════════════════════════════

class CortexAgent:
    """Agentic Loop: Think(stream) → Guard → Act → Reflect"""

    def __init__(self, config: AgentConfig = None):
        self.config = config or AgentConfig()
        wd = os.path.realpath(self.config.work_dir)
        try:
            os.makedirs(wd, exist_ok=True)
        except PermissionError:
            # 回退到用户目录下的 workspace
            wd = os.path.realpath(os.path.join(os.path.expanduser('~'), '.cortx', 'workspace'))
            os.makedirs(wd, exist_ok=True)
            self.config.work_dir = wd
        self.policy = PolicyEngine(wd, self.config)
        # ── 同步 tool_timeout 到 tools.py 的模块级超时配置 ──
        from . import tools as _tools_module
        if self.config.tool_timeout > 0:
            _tools_module.set_tool_timeout(self.config.tool_timeout)
        self.executor = ToolExecutor(registry, wd, self.config.tool_timeout,
                                      max_result_chars=self.config.max_result_chars)
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
        skills_dir = self.config.skills_dir or os.path.join(cwd, '.cortx', 'skills')
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
        # ── Model capabilities auto-resolve ──
        # context_limit=0 或 max_tokens=0 时，从模型能力注册表自动解析
        resolved_model = LLMProvider.resolve(self.config.model)
        caps = LLMProvider.resolve_capabilities(resolved_model)
        if self.config.context_limit == 0:
            self.config.context_limit = caps["context_window"]
        if self.config.max_tokens == 0:
            self.config.max_tokens = caps["max_output_tokens"]
        self.llm = LLMProvider(self.config.api_key,
                               resolved_model, registry.schemas,
                               timeout=self.config.think_timeout,
                               max_tokens=self.config.max_tokens)
        self._ctx: List[Dict] = []; self._trace = None
        self._last_reasoning: str = None
        self._last_llm_error: str = ""
        self._term: Optional['Terminal'] = None  # 终端显示回调
        self._label_done = False
        # ── Permission decision memory (session-scoped) ──
        self._permission_decisions: Dict[str, bool] = {}
        # ── Hooks system ──
        from .hooks import HookManager, HookContext
        self._hooks = HookManager()
        # ── Tool whitelist/blacklist ──
        self._allowed_tools: Optional[set] = None
        self._disallowed_tools: Optional[set] = None
        # ── Non-interactive mode (pipe/CI) ──
        self._non_interactive: bool = False
        # ── Setup tool context ──
        self._setup_tool_context()

    def _make_governor(self, summary_sid: str = None) -> ContextGovernor:
        """构建 ContextGovernor，注入知识库+记忆+历史摘要+上下文窗口配置。

        Args:
            summary_sid: 可选，指定从哪个会话提取历史摘要（用于新会话时引用上一次会话）。
        """
        kb_ctx = self._load_kb()
        # 动态记忆注入：根据记忆条数和上下文预算决定注入量
        memory_ctx = ""
        if self.memory:
            total = self.memory.count()
            inject_n = min(total, self.config.memory_inject_count) if total > self.config.memory_inject_count else total
            memory_ctx = self.memory.to_system_context(max_entries=inject_n)
        sid = summary_sid or self._session_id
        history_summary = ""
        if self.sessions and sid:
            history_summary = self.sessions.get_history_summary(sid) or ""
        return ContextGovernor(self.config.system_prompt,
                               self._work_dir_path(), self.config.max_context_msgs,
                               memory_context=memory_ctx, history_summary=history_summary,
                               kb_context=kb_ctx, context_limit=self.config.context_limit,
                               max_input_tokens=self.config.max_input_tokens,
                               max_tokens=self.config.max_tokens,
                               compress_threshold=self.config.compress_threshold,
                               compress_head=self.config.compress_head,
                               compress_tail=self.config.compress_tail,
                               safety_margin=self.config.safety_margin,
                               input_warn_pct=self.config.input_warn_pct,
                               input_force_pct=self.config.input_force_pct)

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
    def max_input_tokens(self) -> int:
        return self.governor.max_input_tokens

    @property
    def max_tokens(self) -> int:
        return self.config.max_tokens

    @property
    def input_tokens_pct(self) -> int:
        """当前输入 token 占 max_input_tokens 的百分比。"""
        return self.governor.input_tokens_pct(self._ctx)

    @property
    def cache_stats(self) -> dict:
        """缓存命中率统计（基于 LLM API 响应）。"""
        return self.llm.cache_stats

    def set_term(self, term: 'Terminal'):
        self._term = term

    def switch_model(self, alias: str):
        self.llm.switch(alias); self.config.model = self.llm.model
        # 重新解析模型能力，更新 context_limit 和 max_tokens
        caps = LLMProvider.resolve_capabilities(self.llm.model)
        self.config.context_limit = caps["context_window"]
        self.config.max_tokens = caps["max_output_tokens"]
        self.llm.max_tokens = self.config.max_tokens
        # 重建 governor 以应用新的上下文窗口
        self.governor = self._make_governor()

    def switch_permission_mode(self, mode: str) -> str:
        """运行时切换权限模式。返回新模式的描述。
        
        模式说明（参考 Claude Code / Codex 设计）:
          standard  — 默认模式，文件操作全路径放行，SYSTEM 工作区内放行
          auto — 自动批准文件编辑，SYSTEM 自动放行
          yolo      — 全部放行，CI/CD 场景
        """
        mode = mode.lower().strip()
        if mode in ("s", "std", "standard"):
            self.config.permission_mode = "standard"
            return "standard — 文件操作全路径放行 / SYSTEM区内放行"
        elif mode in ("a", "auto", "auto-edit", "edit"):
            self.config.permission_mode = "auto"
            return "auto — 自动批准编辑 + SYSTEM放行"
        elif mode in ("y", "yolo", "full", "bypass"):
            self.config.permission_mode = "yolo"
            return "yolo — 全部放行（⚠️ 路径穿越不设防）"
        else:
            return f"(x) 未知模式: {mode}\n可用: standard | auto | yolo"

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
            last_sid = self.sessions.get_last_session() if self.sessions else ""
            sid = session_id or (self.sessions.generate_id() if self.sessions else "default")
            self._session_id = sid; self._query_count = 0; self._step_count_total = 0; self._ctx = []
            # 新会话：不从上次会话加载完整上下文，但注入历史摘要以保留回顾信息
            summary_sid = last_sid if (last_sid and last_sid != sid) else None
            self.governor = self._make_governor(summary_sid)
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

    def run_long(self, query: str, max_rounds: int = None) -> str:
        """长时运行模式 — 自动续行直到任务完成或达到最大轮数。

        每轮调用 run() 执行 max_steps 步。当步数耗尽但任务未完成时：
          1. 保存当前会话（检查点）
          2. 压缩上下文（保留最近上下文 + 进度摘要）
          3. 注入续行提示，自动开始下一轮

        与 Claude Code 的行为对齐：agent 持续工作直到用户中断或任务完成。

        Args:
            query: 初始任务描述
            max_rounds: 最大续行轮数（0=无限，None=使用配置值）
        Returns:
            最终回答文本
        """
        rounds = max_rounds if max_rounds is not None else self.config.max_rounds
        # 0 = 真正无限续行（用户可通过 Ctrl+C 中断）
        unlimited = (rounds == 0)

        full_result = ""
        round_no = 0
        while True:
            round_no += 1
            if not unlimited and round_no > rounds:
                break
            if self._term:
                display = f"{rounds}" if not unlimited else "∞"
                self._term._w(f"\n  {self._term.CYAN}═══ 轮次 {round_no}/{display} | 总步数 {self._step_count_total} ═══{self._term.RESET}\n")

            # 执行一轮：首轮用 run()，后续轮直接调用 _loop（续行提示已在 ctx 中）
            if round_no == 1:
                result = self.run(query, keep_history=True)
            else:
                result = self._loop(self.config.max_steps)
                self._query_count += 1
                self._step_count_total += len(self._trace.steps) if self._trace else 0
                self._auto_save()

            # 检查是否完成（trace 没有 step_limit_reached 说明 LLM 自然结束）
            if self._trace and not self._trace.step_limit_reached:
                # 任务自然完成
                full_result = result
                break

            # 步数耗尽但未完成 → 检查是否有错误
            if self._trace and self._trace.error:
                # LLM 调用失败 → 保存检查点后退出
                if self._term:
                    self._term._w(f"\n  {self._term.RED}[轮次 {round_no} 失败: {self._trace.error}]{self._term.RESET}\n")
                full_result = result
                break

            # 保存检查点
            if self._session_id and self.sessions:
                self._auto_save()
                if self._term:
                    self._term._w(f"\n  {self._term.GRAY}[检查点已保存]{self._term.RESET}\n")

            # 上下文压缩
            if len(self._ctx) > self.config.compact_threshold:
                self._ctx = self.governor.compact(self._ctx, keep_recent=12)
                if self._term:
                    self._term._w(f"  {self._term.GRAY}[上下文已压缩: {len(self._ctx)}条]{self._term.RESET}\n")

            # 读取 TASKS.md 进度，注入进度感知的续行提示
            cont_content = self._build_continuation_prompt()
            self._ctx.append({"role": "user", "content": cont_content})

            full_result = result

        return full_result

    # ── TASKS.md 进度追踪 ──

    def _tasks_path(self) -> str:
        return os.path.join(self._work_dir_path(), "TASKS.md")

    def _read_tasks(self) -> str:
        """读取 TASKS.md 内容。不存在则返回空串。"""
        p = self._tasks_path()
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                return ""
        return ""

    @staticmethod
    def _count_task_progress(tasks_text: str) -> dict:
        """解析 TASKS.md，返回进度统计。"""
        done = tasks_text.count("[x]")
        todo = tasks_text.count("[ ]")
        total = done + todo
        pct = int(done / total * 100) if total > 0 else 0
        return {"done": done, "todo": todo, "total": total, "pct": pct}

    def _build_continuation_prompt(self) -> str:
        """构建进度感知的续行提示。读取 TASKS.md 并注入到提示中。"""
        tasks = self._read_tasks()
        # 检查最近的工具调用是否有错误
        recent_errors = []
        if self._trace and self._trace.steps:
            for step in self._trace.steps[-5:]:
                if not step.success:
                    recent_errors.append(f"  - [{step.tool_name}] {step.result_preview[:200]}")
        error_hint = ""
        if recent_errors:
            error_hint = (
                "\n\n== 最近错误（需要优先修复）==\n"
                + "\n".join(recent_errors)
                + "\n请优先分析并修复以上错误，再继续新任务。"
            )
        if not tasks:
            return (
                "请继续之前的工作。如果任务已完成，请直接给出最终总结。"
                "如果还有未完成的步骤，请继续执行。\n"
                "提示：如果你还没有创建 TASKS.md 来跟踪进度，请先创建一个。"
                + error_hint
            )
        prog = self._count_task_progress(tasks)
        # 截取 TASKS.md 内容（避免注入过长）
        tasks_preview = tasks[:2000]
        if len(tasks) > 2000:
            tasks_preview += "\n...(TASKS.md 已截断)"
        return (
            f"请继续之前的工作。当前进度：{prog['done']}/{prog['total']} 完成（{prog['pct']}%）。\n\n"
            f"== TASKS.md 当前内容 ==\n{tasks_preview}\n\n"
            "请根据以上进度：\n"
            "- 如果有未完成的 [ ] 任务，继续执行下一个。\n"
            "- 如果所有任务都已完成 [x]，请运行最终构建和测试验证，然后给出最终总结。\n"
            "- 如果发现已完成的部分有错误，优先修复。"
            + error_hint
        )

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

    def _setup_tool_context(self):
        """设置工具上下文（供 ask_user, spawn_subagent 等工具使用）"""
        from .tool_context import set_tool_context
        import threading

        def ask_user_handler(question: str) -> str:
            if self._non_interactive or not self._term:
                return f"[非交互模式] {question}"
            self._term._end_reasoning()
            print(f"\n  {self._term.CYAN}💬 Agent 提问:{self._term.RESET} {question}")
            try:
                print(f"  {self._term.GRAY}> {self._term.RESET}", end="", flush=True)
                ans = input()
                return ans.strip() or "(用户未输入)"
            except Exception:
                return "(用户未响应)"

        def spawn_subagent_handler(task: str, model: str = "") -> str:
            sub_config = AgentConfig(
                api_key=self.config.api_key,
                base_url=self.config.base_url,
                model=model or self.config.model,
                work_dir=self.config.work_dir,
                max_steps=20,
                max_rounds=1,
            )
            sub_agent = CortexAgent(sub_config)
            sub_agent._non_interactive = True
            sub_agent._hooks = self._hooks
            sub_agent._allowed_tools = self._allowed_tools
            sub_agent._disallowed_tools = self._disallowed_tools
            sub_agent._setup_tool_context()
            return sub_agent.run(task)

        set_tool_context({
            "workDir": self.config.work_dir,
            "nonInteractive": self._non_interactive,
            "askUser": ask_user_handler,
            "spawnSubagent": spawn_subagent_handler,
        })

    def set_non_interactive(self, v: bool):
        """设置非交互模式（管道/CI）"""
        self._non_interactive = v
        self._setup_tool_context()

    def set_tool_filter(self, allowed: list = None, disallowed: list = None):
        """设置工具白名单/黑名单"""
        self._allowed_tools = set(allowed) if allowed else None
        self._disallowed_tools = set(disallowed) if disallowed else None

    @property
    def hooks(self):
        """获取 HookManager"""
        return self._hooks

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
        """Auto-extract key facts from each query for cross-session recall.

        记忆永久保留，不自动删除。只控制注入到 system prompt 的条数。
        """
        if not self.memory:
            return
        steps = self._trace.steps if self._trace else []
        tool_names = [s.tool_name for s in steps]
        if "remember_fact" not in tool_names:
            summary = user_query[:80].replace("\n", " ").strip()
            self.memory.append(f"查询: {summary}")
        for step in steps:
            if step.tool_name == "web_search" and step.success:
                result = step.result_preview
                m = re.search(r'\[1\]\s*(.*?)(?:\n|$)', result)
                if m:
                    first_result = m.group(1).strip()[:100]
                    self.memory.append(f"搜索到: {first_result}")
            if step.tool_name == "web_fetch" and step.success and "--- " in step.result_preview:
                m = re.search(r'---\s*(https?://\S+)', step.result_preview)
                if m:
                    self.memory.append(f"抓取: {m.group(1)}")

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    def _loop(self, max_steps: int) -> str:
        trace = self.observer.create_trace(self._ctx[-1]["content"] if self._ctx else "")
        self._trace = trace; self._label_done = False
        if self._term:
            self._term.next_round()
        # max_steps=0 → 无限步数（支持 24h 连续运行）
        unlimited = (max_steps == 0)
        step_no = 0
        while True:
            step_no += 1
            if not unlimited and step_no > max_steps:
                break
            # ── 心跳日志：每 20 步打印进度（长时运行可观测性） ──
            if step_no % 20 == 0 and self._term:
                elapsed = time.time() - trace.start_time
                ctx_pct = self.context_pct
                cs = self.cache_stats
                cache_str = f" | 缓存 {cs['hit_rate']:.0f}%" if cs["calls"] > 0 else ""
                self._term._w(f"\n  {self._term.GRAY}[心跳] 步骤 {step_no} | 耗时 {elapsed:.0f}s | 上下文 {ctx_pct}%{cache_str} | 消息 {len(self._ctx)} 条 | 工具调用 {len(trace.steps)} 次{self._term.RESET}\n")
            self._ctx = self.governor.govern(self._ctx)
            content, tool_calls = self._think()
            if content is None and not tool_calls:
                err = self._last_llm_error or "未知错误"
                trace.error = f"LLM 调用失败: {err}"
                if self._term:
                    self._term._w(f"\n{trace.error}\n")
                    return ""
                return trace.error
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
                # ── 工具白名单/黑名单过滤 ──
                if self._allowed_tools and name not in self._allowed_tools:
                    ok, reason = False, f"工具 {name} 不在白名单中"
                elif self._disallowed_tools and name in self._disallowed_tools:
                    ok, reason = False, f"工具 {name} 已被黑名单禁止"
                elif cap and cap in self._suspended_capabilities and self.config.permission_mode != "yolo":
                    ok, reason = False, f"能力 {cap.value} 已被暂停"
                else:
                    ok, reason = self.policy.audit(name, args)
                # ── CONFIRM → 根据权限模式决定 ──
                if not ok and reason == "confirm":
                    if self.config.permission_mode in ("yolo", "auto"):
                        ok = True; reason = ""
                    elif self._term:
                        ok = self._request_confirmation(name, args, cap_str)
                        reason = "用户授权" if ok else "用户拒绝"
                    else:
                        ok = False; reason = "用户拒绝"
                # ── Adaptive Guard: track rejections ──
                if not ok:
                    if cap and "用户" not in reason:
                        # yolo 模式不累计拒绝计数，不暂停能力
                        if self.config.permission_mode != "yolo":
                            self._rejection_counts[cap] = self._rejection_counts.get(cap, 0) + 1
                            cnt = self._rejection_counts[cap]
                            if cnt >= 5:
                                self._suspended_capabilities.add(cap)
                                result = f"(x) [Policy 拦截] {cap.value} 能力已被暂停（连续 {cnt} 次违规），本次会话中不可用。"
                            else:
                                result = f"(x) [Policy 拦截] {reason}"
                        else:
                            result = f"(x) [Policy 拦截] {reason}"
                    else:
                        result = f"(x) [Policy 拦截] {reason}"
                elif reason.startswith(PolicyEngine.WARN_PREFIX):
                    # ── PreToolUse 钩子 ──
                    pre_hook = self._hooks.run_pre_tool_use(
                        HookContext(name, args, self.config.work_dir))
                    if pre_hook.block:
                        ok = False
                        result = pre_hook.message
                    else:
                        # ── 代码写入打字机效果：在 write_file/edit_file 执行前流式显示代码 ──
                        if self._term and name in ("write_file", "edit_file"):
                            content = args.get("content") or args.get("newString") or args.get("new_string") or ""
                            file_path = args.get("path") or args.get("filePath") or args.get("file_path") or ""
                            if content and len(content) >= 30:
                                self._term.code_stream(file_path, content)
                        # WARN tier: execute but annotate
                        warn_msg = reason[len(PolicyEngine.WARN_PREFIX):]
                        # ── 工具执行：心跳 + Ctrl+C 中断支持 ──
                        result = self._execute_with_heartbeat(name, args)
                        result = f"[注意: {warn_msg}]\n{result}"
                        # ── PostToolUse 钩子 ──
                        post_hook = self._hooks.run_post_tool_use(
                            HookContext(name, args, self.config.work_dir, result))
                        if pre_hook.append: result += f"\n{pre_hook.append}"
                        if post_hook.append: result += f"\n{post_hook.append}"
                else:
                    # ── PreToolUse 钩子 ──
                    pre_hook = self._hooks.run_pre_tool_use(
                        HookContext(name, args, self.config.work_dir))
                    if pre_hook.block:
                        ok = False
                        result = pre_hook.message
                    else:
                        # ── 代码写入打字机效果：在 write_file/edit_file 执行前流式显示代码 ──
                        if self._term and name in ("write_file", "edit_file"):
                            content = args.get("content") or args.get("newString") or args.get("new_string") or ""
                            file_path = args.get("path") or args.get("filePath") or args.get("file_path") or ""
                            if content and len(content) >= 30:
                                self._term.code_stream(file_path, content)
                        # ── 工具执行：心跳 + Ctrl+C 中断支持 ──
                        result = self._execute_with_heartbeat(name, args)
                        # ── PostToolUse 钩子 ──
                        post_hook = self._hooks.run_post_tool_use(
                            HookContext(name, args, self.config.work_dir, result))
                        if pre_hook.append: result += f"\n{pre_hook.append}"
                        if post_hook.append: result += f"\n{post_hook.append}"
                latency = (time.time() - t0) * 1000
                self.observer.record(trace, step_no, name, args, result, ok, cap_str, latency)
                if self._term:
                    self._term.tool_done(ok, latency, result)
                self._ctx.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
            # ── Checkpoint: 每 N 步自动保存 ──
            if (self.config.checkpoint_interval > 0 and
                step_no % self.config.checkpoint_interval == 0 and
                self._session_id and self.sessions):
                self._auto_save()
            # ── Context compaction: 消息数超阈值时压缩 ──
            if (self.config.compact_threshold > 0 and
                len(self._ctx) > self.config.compact_threshold):
                self._ctx = self.governor.compact(self._ctx, keep_recent=12)
                if self._term:
                    self._term._w(f"\n  {self._term.GRAY}[上下文已压缩: {len(self._ctx)}条]{self._term.RESET}\n")
            # ── Reflect: 仅在有步数限制时检查收敛 ──
            if not unlimited:
                result = self._reflect(trace, step_no, max_steps)
                if result is not None: return result
            self._last_reasoning = None
        # 仅在有步数限制时标记步数耗尽（无限模式不会到达此处）
        if not unlimited:
            trace.step_limit_reached = True
        msg = "[超步数] 未能完成"
        if self._term:
            self._term._w(f"\n{msg}\n")
            return ""
        return msg

    def _execute_with_heartbeat(self, name: str, args: dict) -> str:
        """执行工具，显示心跳（每 5 秒），支持 Ctrl+C 中断"""
        import threading
        heartbeat_stop = threading.Event()
        start_time = time.time()

        def heartbeat():
            """后台线程：每 5 秒显示执行时间"""
            while not heartbeat_stop.wait(5.0):
                elapsed = int(time.time() - start_time)
                if self._term:
                    self._term.tool_heartbeat(elapsed)

        # 启动心跳线程
        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        heartbeat_thread.start()

        try:
            result = self.executor.execute(name, args)
            return result
        except KeyboardInterrupt:
            if self._term:
                self._term.tool_interrupted()
            return "(x) 用户中断 (Ctrl+C)"
        finally:
            heartbeat_stop.set()  # 停止心跳线程
            heartbeat_thread.join(timeout=0.5)

    def _reflect(self, trace, step_no, max_steps) -> Optional[str]:
        """结构性收敛：仅在达到最大步数时给予一次最终回答机会。"""
        if step_no == max_steps:
            # 标记步数已耗尽（run_long 依赖此标记决定是否续行）
            trace.step_limit_reached = True
            final, tcs = self._think()
            if final:
                trace.final_answer = final
                if tcs:
                    # Text was streamed, but the suffix is not — print to terminal
                    if self._term:
                        self._term._w("\n\n[已达最大步数，工具调用未执行]")
                        return ""
                    return final + "\n\n[已达最大步数，工具调用未执行]"
                # Text was already streamed — return "" for terminal mode
                return "" if self._term else final
            # LLM failed (API error after retries) — display fallback to terminal
            fallback = "[达到最大步数]"
            if self._term:
                self._term._w(f"\n{fallback}\n")
                return ""
            return fallback
        return None

    def _think(self) -> Tuple[Optional[str], Optional[List[Dict]]]:
        """Think 阶段 — 调用 LLM，带输入压力感知的渐进降级恢复。

        4 级降级策略（每级改变策略+减少输入压力）:
          Level 1: thinking=True  — 正常推理模式
          Level 2: thinking=False — 关闭推理，全部 token 留给 content/tool_calls
          Level 3: thinking=False + 强制 govern — 压缩历史 tool result 后重试
          Level 4: thinking=False + nudge — 注入提示消息强制生成回答

        所有异常被捕获并记录到 self._last_llm_error，不静默吞掉。
        """
        term = self._term
        self._last_llm_error = ""

        def _do_call(thinking: bool = True, ctx_override: list = None):
            ctx = ctx_override if ctx_override is not None else self._ctx
            if term:
                return self.llm.call_stream(
                    ctx,
                    on_text=term.think_token,
                    on_answer=term.answer_token,
                    on_tool=self._tool_labeled(),
                    thinking=thinking)
            else:
                return self.llm.call(ctx, thinking=thinking)

        def _is_transient(err: Exception) -> bool:
            """判断是否为可重试的瞬态错误（429/500/502/503/timeout/connection）。"""
            msg = str(err).lower()
            transient_markers = ["429", "500", "502", "503", "timeout", "timed out",
                                 "connection", "temporar", "overload", "rate limit",
                                 "service unavailable", "bad gateway", "internal server error"]
            return any(m in msg for m in transient_markers)

        def _do_call_with_retry(thinking: bool = True, ctx_override: list = None):
            """带指数退避重试的 LLM 调用。仅在瞬态错误时重试。"""
            last_err = None
            for attempt in range(self.config.retry_max + 1):
                try:
                    return _do_call(thinking=thinking, ctx_override=ctx_override)
                except Exception as e:
                    last_err = e
                    if not _is_transient(e) or attempt >= self.config.retry_max:
                        raise
                    delay = self.config.retry_base_delay * (2 ** attempt)
                    if term:
                        term._w(f"\n  {term.YELLOW}[重试 {attempt+1}/{self.config.retry_max}] {delay:.0f}s 后重试: {e}{term.RESET}")
                    time.sleep(delay)
            raise last_err  # type: ignore

        # ── Level 1: 正常推理模式（含瞬态错误重试） ──
        try:
            text, tcs, reasoning, finish_reason = _do_call_with_retry(thinking=True)
            if reasoning: self._last_reasoning = reasoning
            if text or tcs:
                return text, tcs
        except Exception as e:
            self._last_llm_error = f"[L1] {e}"

        # ── Level 2: 关闭推理模式（解决 finish_reason=length） ──
        time.sleep(0.5)
        try:
            text, tcs, reasoning, finish_reason = _do_call(thinking=False)
            if text or tcs:
                return text, tcs
        except Exception as e:
            self._last_llm_error = f"[L2] {e}"

        # ── Level 3: 压缩上下文后重试（减少输入 token 压力） ──
        time.sleep(0.5)
        compressed_ctx = self.governor.govern(list(self._ctx))  # 强制再压缩一轮
        try:
            text, tcs, reasoning, finish_reason = _do_call(thinking=False, ctx_override=compressed_ctx)
            if text or tcs:
                return text, tcs
        except Exception as e:
            self._last_llm_error = f"[L3] {e}"

        # ── Level 4: 关闭推理 + 注入 nudge ──
        time.sleep(0.5)
        nudge = {"role": "user",
                 "content": "请根据以上工具返回的信息，直接给出你的回答。"}
        self._ctx.append(nudge)
        try:
            text, tcs, reasoning, _ = _do_call(thinking=False)
            if reasoning: self._last_reasoning = reasoning
        except Exception as e:
            self._last_llm_error = f"[L4] {e}"
            text, tcs = None, None
        finally:
            if self._ctx and self._ctx[-1] is nudge:
                self._ctx.pop()
        if text or tcs:
            return text, tcs

        return None, None

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
