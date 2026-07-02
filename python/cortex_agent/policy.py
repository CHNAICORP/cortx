"""
Cortex Agent 安全策略引擎 — PolicyEngine
══════════════════════════════════════════════

完整中介：所有工具调用必须通过 audit() 审计。
4 级判决：ALLOW / WARN / CONFIRM / DENY
SSRF 防护 / SQL 注入防护 / Shell 命令分级 / Python 沙箱检测 / 路径穿越检测
"""

import os, re, ipaddress
from typing import Tuple
from .cortex_agent import RiskLevel, Capability, AuditVerdict, registry, check_ssrf


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
    SHELL_BLOCK_SUBSTR = [
        # System destruction
        "rm -rf /", "rm -rf --no-preserve-root", "sudo rm", "del /f /s",
        "format ", "diskpart", "mkfs", "fdisk", "dd if=",
        "shutdown", "reboot", "stop-computer", "restart-computer",
        # Privilege escalation
        "sudo ", "su ", "runas ",
        # Data exfiltration vectors (非 localhost)
        "nc ", "ncat ", "netcat ", "telnet ",
        "ssh ", "scp ", "sftp ", "ftp ", "sendmail",
        # System config modification
        "reg add", "reg delete", "reg import", "reg save",
        "sc create", "sc delete", "sc config", "sc stop", "sc start",
        "schtasks", "new-service", "remove-service",
        "set-itemproperty", "new-itemproperty",
        "bcdedit", "netsh ", "wmic ", "set-executionpolicy",
        # Process/service termination
        "taskkill", "stop-process", "clear-recyclebin",
        # PowerShell obfuscation
        "-encodedcommand", "-enc ", " -e ", "invoke-expression",
        "iex ", ".iex", "|iex", ";iex",
        # Registry access
        "hklm:", "hkcu:", "hkey_",
    ]

    # Tier 1 regex patterns — context-sensitive detection
    SHELL_BLOCK_RE = [
        (re.compile(r'(?:^|\s)([d-z]:\\)', re.I),       "禁止访问非 C 盘路径"),
        (re.compile(r'(?:^|\s|;)(?:-[eE][nNcCoOdDeEdDcCoOmMmMaAnNdD]*)\s'),
                                                          "禁止 PowerShell 编码命令 (-e/-en/-enc/-enco/-ec)"),
        (re.compile(r'[|;]\s*remove-item\b', re.I),      "禁止管道删除操作"),
        (re.compile(r'[|;]\s*stop-process\b', re.I),      "禁止管道终止进程"),
        (re.compile(r'[|;]\s*out-file\b', re.I),          "禁止管道写入文件"),
        (re.compile(r'[|;]\s*set-content\b', re.I),       "禁止管道修改文件"),
        (re.compile(r'>\s*[/\\]', re.I),                   "禁止重定向到系统路径"),
    ]

    # Tier 2: WARN — allow execution but inject warning to LLM context
    SHELL_WARN_SUBSTR = [
        # Network tools (allowed but logged — SSRF check still applies)
        "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
        # Permissions
        "chmod 777", "chmod -R",
        # System info gathering
        "net user", "net localgroup", "net share",
        "get-process", "get-service", "get-eventlog", "get-wmiobject",
        "test-connection", "test-netconnection", "resolve-dnsname",
        # File output (potential overwrite)
        "set-content", "out-file", "add-content",
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
        (r'\bsubprocess\b', "禁止 subprocess"),
        (r'\bsocket\b', "禁止 socket"),
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
        """根据权限模式决定判决级别。"""
        mode = getattr(self.config, 'permission_mode', 'standard') if self.config else 'standard'
        if mode == "yolo":
            return AuditVerdict.ALLOW
        if risk == RiskLevel.SAFE:
            if is_outside and mode != "auto-edit":
                return AuditVerdict.CONFIRM
            return AuditVerdict.ALLOW
        if risk == RiskLevel.WRITE:
            if is_outside:
                return AuditVerdict.CONFIRM
            return AuditVerdict.ALLOW
        # SYSTEM
        if mode == "standard":
            return AuditVerdict.CONFIRM
        return AuditVerdict.ALLOW

    # All path-like parameter names that need workspace containment checks
    PATH_PARAMS = {"path", "file_a", "file_b", "source", "target", "pattern"}

    def audit(self, tool_name: str, args: dict) -> Tuple[bool, str]:
        """4级判决：allow / warn / confirm / deny。
        返回 (ok, reason) 其中 ok=False 且 reason="confirm" 时需要用户确认。
        
        关键修复: CONFIRM 不短路内容审计 — shell/SQL/Python 危险命令在确认前仍会检测。
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
        # yolo = 全部放行
        if self.config and self.config.permission_mode == "yolo":
            return True, ""
        # ── 内容审计（始终执行，不受 CONFIRM 短路影响）──
        content_ok = True
        content_reason = ""
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
        # 内容审计失败 → 直接拒绝
        if not content_ok:
            return False, content_reason
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
        path = args.get("path", "")
        ok, resolved = self.resolve_path(path)
        if not ok: return ok, resolved
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
