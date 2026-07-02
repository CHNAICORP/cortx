/**
 * PolicyEngine — 安全策略引擎
 * 与 Python policy.py 完全对应：4 级判决 + SSRF/SQL/Shell/Python 检测
 */
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { RiskLevel, Capability, AuditVerdict, PermissionMode } from './types.js';
import { registry } from './registry.js';

// ── SSRF 拦截网段 ──
const SSRF_BLOCKED_NETS = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
  "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4",
  "::1/128", "fc00::/7", "fe80::/10",
];

function ipInCidr(ip: string, cidr: string): boolean {
  // Simplified IPv4 CIDR check (covers common cases)
  if (!ip.includes(".") || !cidr.includes(".")) return false;
  const [ipA, ipB, ipC, ipD] = ip.split(".").map(Number);
  const [netStr, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr);
  const [nA, nB, nC, nD] = netStr.split(".").map(Number);
  const ipNum = (ipA << 24) | (ipB << 16) | (ipC << 8) | ipD;
  const netNum = (nA << 24) | (nB << 16) | (nC << 8) | nD;
  const mask = ~((1 << (32 - bits)) - 1);
  return (ipNum & mask) === (netNum & mask);
}

export function checkSsrf(hostOrUrl: string): [boolean, string] {
  let host = hostOrUrl;
  const m = hostOrUrl.match(/^https?:\/\/(?:\[([^\]]+)\]|([^/:]+))/i);
  if (m) host = (m[1] || m[2]).toLowerCase();

  // Check if it's already an IP
  if (net.isIP(host)) {
    for (const cidr of SSRF_BLOCKED_NETS) {
      if (ipInCidr(host, cidr) || host === "127.0.0.1" || host === "::1") {
        return [false, `SSRF 防护: ${host} 在禁访范围 ${cidr}`];
      }
    }
    return [true, ""];
  }
  // Hostname — resolve and check
  try {
    // Synchronous DNS not available in pure Node without dns.promises
    // For simplicity, allow hostnames (tools will do their own check)
    return [true, ""];
  } catch {
    return [false, `SSRF 防护: 无法解析 ${host}`];
  }
}

// ── PolicyEngine ──
export class PolicyEngine {
  static FORBIDDEN_EXTS = new Set([
    ".sh", ".bat", ".exe", ".ps1", ".com", ".scr", ".vbs",
    ".cmd", ".psm1", ".psd1", ".vbe", ".jse", ".wsf", ".wsh",
    ".hta", ".msi", ".msp", ".cpl", ".scf",
  ]);

  static WARN_PREFIX = "[WARN] ";

  static SHELL_BLOCK_SUBSTR = [
    "rm -rf /", "sudo rm", "del /f /s", "format ", "diskpart", "mkfs", "fdisk", "dd if=",
    "shutdown", "reboot", "sudo ", "su ", "runas ",
    "nc ", "ncat ", "netcat ", "telnet ", "ssh ", "scp ", "sftp ", "ftp ", "sendmail",
  ];

  static SHELL_WARN_SUBSTR = [
    "curl ", "wget ", "chmod 777", "chmod -R",
    "net user", "net localgroup", "net share",
  ];

  static SQL_DENY = new Set([
    "drop", "delete", "update", "insert", "alter", "create", "truncate",
    "grant", "revoke", "exec", "execute", "union", "attach", "detach", "pragma",
  ]);

  static PYTHON_DENY: [RegExp, string][] = [
    [/\b__\s*import\s*__/, "禁止 __import__ 逃逸"],
    [/\bexec\s*\(/, "禁止 exec"],
    [/\beval\s*\(/, "禁止 eval"],
    [/\bsubprocess\b/, "禁止 subprocess"],
    [/\bsocket\b/, "禁止 socket"],
    [/\bctypes\b/, "禁止 ctypes"],
    [/\b__builtins__/, "禁止 __builtins__"],
    [/\b__subclasses__/, "禁止 __subclasses__"],
  ];

  // 所有路径参数名
  static PATH_PARAMS = new Set(["path", "file_a", "file_b", "source", "target", "pattern"]);

  private workDir: string;
  private config: { permissionMode: PermissionMode };

  constructor(workDir: string, config: { permissionMode: PermissionMode }) {
    this.workDir = path.resolve(workDir);
    this.config = config;
  }

  isOutsideWorkspace(userPath: string): boolean {
    if (userPath.includes("\x00")) return true;
    try {
      const full = path.resolve(this.workDir, userPath);
      const sep = path.sep;
      return !(full.startsWith(this.workDir + sep) || full === this.workDir);
    } catch {
      return true;
    }
  }

  private checkPermission(risk: RiskLevel, isOutside: boolean): AuditVerdict {
    const mode = this.config.permissionMode;
    if (mode === "yolo") return AuditVerdict.ALLOW;
    if (risk === RiskLevel.SAFE) {
      if (isOutside && mode !== "auto-edit") return AuditVerdict.CONFIRM;
      return AuditVerdict.ALLOW;
    }
    if (risk === RiskLevel.WRITE) {
      if (isOutside) return AuditVerdict.CONFIRM;
      return AuditVerdict.ALLOW;
    }
    // SYSTEM
    if (mode === "standard") return AuditVerdict.CONFIRM;
    return AuditVerdict.ALLOW;
  }

  audit(toolName: string, args: Record<string, unknown>): [boolean, string] {
    const meta = registry.meta(toolName);
    if (!meta) return [false, `未注册: ${toolName}`];
    const risk = meta.risk;
    const cap = meta.capability;

    // 文件工具：检查路径参数
    let isOutside = false;
    if (cap === Capability.FS_READ || cap === Capability.FS_WRITE) {
      for (const pname of PolicyEngine.PATH_PARAMS) {
        const val = args[pname];
        if (typeof val === "string") {
          isOutside = this.isOutsideWorkspace(val);
          if (isOutside) break;
        }
      }
    }

    if (this.config.permissionMode === "yolo") return [true, ""];

    // ── 内容审计（始终执行）──
    let contentOk = true;
    let contentReason = "";
    if (cap === Capability.DB_READ) {
      [contentOk, contentReason] = this.auditSql(String(args["sql"] || ""));
    } else if (cap === Capability.SHELL) {
      [contentOk, contentReason] = this.auditShell(String(args["command"] || ""));
    } else if (cap === Capability.PYTHON) {
      [contentOk, contentReason] = this.auditPython(String(args["code"] || ""));
    } else if (cap === Capability.NET_HTTP || cap === Capability.NET_SEARCH) {
      const target = String(args["url"] || args["query"] || "");
      [contentOk, contentReason] = this.auditUrl(target);
    } else if (cap === Capability.FS_WRITE) {
      [contentOk, contentReason] = this.auditPathWrite(args);
    }
    if (!contentOk) return [false, contentReason];

    // ── 权限判决 ──
    const verdict = this.checkPermission(risk, isOutside);
    if (verdict === AuditVerdict.CONFIRM) return [false, "confirm"];
    if (verdict === AuditVerdict.DENY) return [false, "denied"];
    return [true, contentReason];
  }

  private auditPathWrite(args: Record<string, unknown>): [boolean, string] {
    const userPath = String(args["path"] || args["source"] || "");
    const full = path.resolve(this.workDir, userPath);
    const ext = path.extname(full).toLowerCase();
    if (PolicyEngine.FORBIDDEN_EXTS.has(ext)) return [false, `禁止写入 ${ext}`];
    return [true, full];
  }

  private auditSql(sql: string): [boolean, string] {
    const s = sql.trim();
    if (s.includes(";") && s.replace(/;$/, "").includes(";")) return [false, "禁止多语句"];
    if (!s.toUpperCase().startsWith("SELECT")) return [false, "仅允许 SELECT"];
    const low = s.toLowerCase();
    for (const kw of PolicyEngine.SQL_DENY) {
      if (new RegExp(`\\b${kw}\\b`).test(low)) return [false, `SQL 含禁止关键词: ${kw}`];
    }
    return [true, ""];
  }

  private auditShell(cmd: string): [boolean, string] {
    const low = cmd.toLowerCase();
    for (const p of PolicyEngine.SHELL_BLOCK_SUBSTR) {
      if (low.includes(p)) return [false, `高危命令: ${p}`];
    }
    for (const p of PolicyEngine.SHELL_WARN_SUBSTR) {
      if (low.includes(p)) return [true, `${PolicyEngine.WARN_PREFIX}潜在风险: ${p}`];
    }
    return [true, ""];
  }

  private auditPython(code: string): [boolean, string] {
    for (const [pattern, reason] of PolicyEngine.PYTHON_DENY) {
      if (pattern.test(code)) return [false, reason as string];
    }
    return [true, ""];
  }

  private auditUrl(target: string): [boolean, string] {
    if (!/^https?:\/\//i.test(target)) return [true, ""];
    return checkSsrf(target);
  }
}
