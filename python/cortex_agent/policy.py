"""
Cortex Agent 安全策略引擎 — PolicyEngine
══════════════════════════════════════════════

完整中介：所有工具调用必须通过 audit() 审计。
4 级判决：ALLOW / WARN / CONFIRM / DENY
SSRF 防护 / SQL 注入防护 / Shell 命令分级 / Python 沙箱检测 / 路径穿越检测
"""

import os, re, ipaddress
from typing import Tuple, TYPE_CHECKING
from .cortex_agent import RiskLevel, Capability, AuditVerdict, registry, check_ssrf

if TYPE_CHECKING:
    from .cortex_agent import AgentConfig


# ══════════════════════════════════════════════════════════════
# 安全策略引擎
# ══════════════════════════════════════════════════════════════

class PolicyEngine:
    """完整中介：所有工具调用必须通过 audit()"""

    FORBIDDEN_EXTS = {".sh", ".bat", ".exe", ".ps1", ".com", ".scr", ".vbs",
                      ".cmd", ".psm1", ".psd1", ".vbe", ".jse", ".wsf", ".wsh",
                      ".hta", ".msi", ".msp", ".cpl", ".scf"}
    WARN_PREFIX = "[WARN] "

    # Tier 1: BLOCK — hard deny (substrings, case-insensitive)
    # 仅拦截真正危险的系统级操作，不拦截开发常用命令
    SHELL_BLOCK_SUBSTR = [
        # System destruction
        "rm -rf /", "rm -rf --no-preserve-root", "del /f /s /q c:",
        "format ", "diskpart", "mkfs", "fdisk", "dd if=/dev/",
        "shutdown", "reboot", "stop-computer", "restart-computer",
        # Privilege escalation (仅真正的提权命令)
        "runas /user:",
        # Data exfiltration vectors (非 localhost)
        "nc ", "ncat ", "netcat ",
        # System config modification
        "reg add", "reg delete", "reg import",
        "sc create", "sc delete", "sc config",
        "schtasks /create", "schtasks /delete",
        "new-service", "remove-service",
        "bcdedit", "netsh ", "set-executionpolicy",
        # PowerShell obfuscation (仅真正的混淆)
        "-encodedcommand", "-enc ",
        # Registry access
        "hklm:", "hkcu:", "hkey_",
    ]

    # Tier 1 regex patterns — context-sensitive detection
    SHELL_BLOCK_RE = [
        # 仅拦截 PowerShell 编码命令（powershell/pwsh 上下文中的 -enc/-encodedcommand）
        # 不再拦截 node -e / python -e 等开发常用命令
        (re.compile(r'(?:powershell|pwsh)[\s\.\-].*(?:-(?:enc|encodedcommand)\s)', re.I),
                                                          "禁止 PowerShell 编码命令 (-EncodedCommand)"),
        # 仅拦截针对根目录的批量静默删除
        (re.compile(r'del\s+/[a-z]*s[a-z]*\s+/q\s+[a-z]:\\?\s*$', re.I),  "禁止批量静默删除根目录"),
    ]

    # Tier 2: WARN — allow execution but inject warning to LLM context
    # 仅警告，不拦截
    SHELL_WARN_SUBSTR = [
        # Network tools (allowed but logged — SSRF check still applies)
        "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
        # Permissions
        "chmod 777", "chmod -R",
        # System info gathering
        "net user", "net localgroup", "net share",
        "get-eventlog", "get-wmiobject",
    ]
    SQL_DENY = {"drop", "delete", "update", "insert", "alter",
                "create", "truncate", "grant", "revoke", "exec", "execute",
                "union", "attach", "detach", "pragma", "replace", "into"}
    PYTHON_DENY = [(re.compile(r, re.I), m) for r, m in [
        # 仅拦截沙箱逃逸路径，不拦截标准库模块
        (r'__\s*import\s*__', "禁止 __import__ 逃逸"),
        (r'\bexec\s*\(', "禁止 exec"),
        (r'\beval\s*\(', "禁止 eval"),
        (r'\bcompile\s*\(', "禁止 compile"),
        (r'\bctypes\b', "禁止 ctypes"),
        (r'\b__builtins__', "禁止 __builtins__"),
        (r'\b__class__', "禁止 __class__"),
        (r'\b__base__', "禁止 __base__"),
        (r'\b__subclasses__', "禁止 __subclasses__"),
        (r'\b__globals__', "禁止 __globals__"),
        (r'\b__getattribute__', "禁止 __getattribute__"),
        (r'\b__delattr__', "禁止 __delattr__"),
        (r'\b__setattr__', "禁止 __setattr__"),
    ]]

    def __init__(self, work_dir: str, config: 'AgentConfig' = None):
        self.work_dir = os.path.realpath(work_dir)
        self.config = config  # AgentConfig 引用，用于权限模式

    def is_outside_workspace(self, path: str) -> bool:
        """检查路径是否在工作区外。含 null byte 过滤。"""
        if '\x00' in path:
            return True  # null byte → 拒绝
        try:
            full = os.path.realpath(os.path.join(self.work_dir, path))
            return not (full.startswith(self.work_dir + os.sep) or full == self.work_dir)
        except Exception:
            return True

    def _check_permission(self, risk: RiskLevel, is_outside: bool = False) -> AuditVerdict:
        """根据权限模式决定判决级别。
        
        设计原则（v1.3.0 放宽）：
          - 内容审计已通过 = 命令不危险
          - 文件操作（SAFE/WRITE）在所有路径都放行 — 工作目录只是默认值，不是沙箱
          - standard 模式：SYSTEM 工作区内放行，工作区外需确认
          - auto 模式：全部放行
          - yolo 模式：全部放行（内容审计仍执行）
        """
        mode = getattr(self.config, 'permission_mode', 'standard') if self.config else 'standard'
        if mode == "yolo":
            return AuditVerdict.ALLOW
        if risk == RiskLevel.SAFE:
            # 文件读取操作在所有路径都放行 — 桌面、文档等用户目录都是合法的访问范围
            return AuditVerdict.ALLOW
        if risk == RiskLevel.WRITE:
            # 文件写操作在所有路径都放行 — 桌面、文档等用户目录都是合法的写入范围
            # 危险文件扩展名已在内容审计中拦截
            return AuditVerdict.ALLOW
        # SYSTEM 风险（shell/python 等）
        # 内容审计已通过 → 命令本身不危险
        # auto 模式自动放行
        if mode == "auto":
            return AuditVerdict.ALLOW
        # standard 模式：工作区内放行（开发命令如 npm/tsc/git/python 等）
        # 工作区外仍需确认
        if not is_outside:
            return AuditVerdict.ALLOW
        return AuditVerdict.CONFIRM

    # All path-like parameter names that need workspace containment checks
    # Covers both snake_case (Python) and camelCase (TS/LLM) variants for parity
    PATH_PARAMS = {"path", "file_path", "filepath", "dir_path", "dirpath",
                   "file_a", "file_b", "fileA", "fileB",
                   "source", "target", "pattern", "out_path", "outPath"}

    def audit(self, tool_name: str, args: dict) -> Tuple[bool, str]:
        """4级判决：allow / warn / confirm / deny。
        返回 (ok, reason) 其中 ok=False 且 reason="confirm" 时需要用户确认。
        
        关键修复: CONFIRM 不短路内容审计 — shell/SQL/Python 危险命令在确认前仍会检测。
        MCP 和 BROWSER 能力跳过内容审计（不是 shell/http 命令，无需审计）。
        """
        meta = registry.meta(tool_name)
        if meta is None: return False, f"未注册: {tool_name}"
        risk = meta.get("risk", RiskLevel.SAFE)
        cap = meta["capability"]
        # File tools: 检测所有路径参数是否在工作区外
        is_outside = False
        if cap in (Capability.FS_READ, Capability.FS_WRITE):
            for pname in self.PATH_PARAMS:
                if pname in args:
                    is_outside = self.is_outside_workspace(args[pname])
                    if is_outside:
                        break
        # ── 内容审计 ──
        # yolo 模式：仅拦截极端危险命令（系统级毁灭），跳过其余内容审计
        # auto/standard 模式：完整内容审计
        content_ok = True
        content_reason = ""
        mode = getattr(self.config, 'permission_mode', 'standard') if self.config else 'standard'
        if mode == "yolo":
            # yolo 模式：仅检查极端危险命令（rm -rf /, format, shutdown 等）
            if cap == Capability.SHELL:
                cmd = args.get("command", "")
                low = cmd.lower()
                for p in self.SHELL_BLOCK_SUBSTR:
                    if p.lower() in low:
                        return False, f"YOLO 模式仍拦截极端危险命令: {p}"
            # yolo 模式跳过 SQL/Python/SSRF/路径审计
            return True, ""
        # auto/standard 模式：完整内容审计
        if cap == Capability.DB_READ:
            content_ok, content_reason = self._audit_sql(args.get("sql", ""))
        elif cap == Capability.SHELL:
            content_ok, content_reason = self._audit_shell(args.get("command", ""))
        elif cap == Capability.PYTHON:
            content_ok, content_reason = self._audit_python(args.get("code", ""))
        elif cap in (Capability.NET_HTTP, Capability.NET_SEARCH):
            target = args.get("url") or args.get("query", "")
            content_ok, content_reason = self._audit_url(target)
        elif cap == Capability.FS_WRITE:
            content_ok, content_reason = self._audit_path_write(args)
        # MCP / BROWSER: 无内容审计 — 直接进入权限判决
        # 内容审计失败 → 直接拒绝（即使在 yolo 模式下）
        if not content_ok:
            return False, content_reason
        # yolo = 跳过权限检查，放行（内容审计已通过）
        if self.config and self.config.permission_mode == "yolo":
            return True, ""
        # ── 权限模式判决 ──
        verdict = self._check_permission(risk, is_outside)
        if verdict == AuditVerdict.CONFIRM:
            # 内容已通过审计，但仍需用户确认权限
            return False, "confirm"
        if verdict == AuditVerdict.DENY:
            return False, "denied"
        # ALLOW 或 WARN → 可能带警告前缀
        if content_reason.startswith(self.WARN_PREFIX):
            return True, content_reason
        return True, ""

    def resolve_path(self, user_path: str) -> Tuple[bool, str]:
        full = os.path.realpath(os.path.join(self.work_dir, user_path))
        if not full.startswith(self.work_dir + os.sep) and full != self.work_dir:
            return False, f"路径越权: {user_path}"
        return True, full

    def _audit_path(self, path: str) -> Tuple[bool, str]:
        return self.resolve_path(path)

    def _audit_path_write(self, args: dict) -> Tuple[bool, str]:
        """文件写入内容审计：仅检查危险文件扩展名。路径权限由 _check_permission() 处理。"""
        path = args.get("path", "")
        resolved = os.path.realpath(os.path.join(self.work_dir, path))
        ext = os.path.splitext(resolved)[1].lower()
        if ext in self.FORBIDDEN_EXTS: return False, f"禁止写入 {ext}"
        return True, resolved

    def _audit_sql(self, sql: str) -> Tuple[bool, str]:
        s = sql.strip()
        if ";" in s.rstrip(";"): return False, "禁止多语句"
        if not s.upper().startswith("SELECT"): return False, "仅允许 SELECT"
        low = s.lower()
        for kw in self.SQL_DENY:
            if re.search(rf'\b{re.escape(kw)}\b', low):
                return False, f"SQL 含禁止关键词: {kw}"
        return True, ""

    def _audit_shell(self, cmd: str) -> Tuple[bool, str]:
        low = cmd.lower()
        # Tier 1a: substring BLOCK
        for p in self.SHELL_BLOCK_SUBSTR:
            if p.lower() in low:
                return False, f"高危命令: {p}"
        # Tier 1b: regex BLOCK
        for pattern, reason in self.SHELL_BLOCK_RE:
            if pattern.search(cmd):
                return False, reason
        # Tier 2: WARN
        for p in self.SHELL_WARN_SUBSTR:
            if p.lower() in low:
                return True, f"{self.WARN_PREFIX}潜在风险: {p}"
        # Tier 3: ALLOW
        return True, ""

    def _audit_python(self, code: str) -> Tuple[bool, str]:
        for pattern, reason in self.PYTHON_DENY:
            if pattern.search(code): return False, reason
        return True, ""

    def _audit_url(self, target: str) -> Tuple[bool, str]:
        if not re.match(r'^https?://', target, re.I):
            return True, ""
        return check_ssrf(target)


# ══════════════════════════════════════════════════════════════
