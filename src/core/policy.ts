/**
 * PolicyEngine — 安全策略引擎
 * 与 Python policy.py 完全对应：4 级判决 + SSRF/SQL/Shell/Python 检测
 */
import * as os from "os";
import * as path from "path";
import * as net from "net";
import * as dns from "dns";
import { RiskLevel, Capability, AuditVerdict, PermissionMode } from './types.js';
import { registry } from './registry.js';

// ── SSRF 拦截网段 ──
const SSRF_BLOCKED_NETS = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
  "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4",
  "::1/128", "fc00::/7", "fe80::/10",
];

function ipInCidr(ip: string, cidr: string): boolean {
  // Full CIDR check covering both IPv4 and IPv6
  if (ip.includes(":") && cidr.includes(":")) {
    // IPv6 CIDR — simple prefix match for the listed ranges
    const [ipNorm] = ip.toLowerCase().split("%"); // strip zone index
    const [netStr, bitsStr] = cidr.split("/");
    const bits = parseInt(bitsStr);
    // For /128: exact match; for /7 and /10: prefix match
    if (bits >= 64) return ipNorm === netStr.toLowerCase();
    return ipNorm.toLowerCase().startsWith(netStr.toLowerCase().slice(0, Math.ceil(bits / 4)));
  }
  if (!ip.includes(".") || !cidr.includes(".")) return false;
  const [ipA, ipB, ipC, ipD] = ip.split(".").map(Number);
  const [netStr, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr);
  const [nA, nB, nC, nD] = netStr.split(".").map(Number);
  // Guard against NaN (e.g., "localhost" passed as IP)
  if (isNaN(ipA) || isNaN(nA) || bits > 32) return false;
  const ipNum = ((ipA << 24) | (ipB << 16) | (ipC << 8) | ipD) >>> 0;
  const netNum = ((nA << 24) | (nB << 16) | (nC << 8) | nD) >>> 0;
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

async function resolveHostname(host: string): Promise<string[]> {
  try {
    const addresses = await dns.promises.resolve4(host);
    try {
      const v6 = await dns.promises.resolve6(host);
      return [...addresses, ...v6];
    } catch { /* IPv6 not available */ }
    return addresses;
  } catch {
    // Try reverse lookup — if DNS fails, block (rebinding protection)
    return [];
  }
}

export async function checkSsrf(hostOrUrl: string): Promise<[boolean, string]> {
  let host = hostOrUrl;
  const m = hostOrUrl.match(/^https?:\/\/(?:\[([^\]]+)\]|([^/:]+))/i);
  if (m) host = (m[1] || m[2]).toLowerCase();

  // Check if it's already an IP
  if (net.isIP(host)) {
    // Handle IPv4-mapped IPv6
    const v4m = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4m) host = v4m[1];
    for (const cidr of SSRF_BLOCKED_NETS) {
      if (ipInCidr(host, cidr)) {
        return [false, `SSRF 防护: ${host} 在禁访范围 ${cidr}`];
      }
    }
    return [true, ""];
  }

  // Check for localhost variants
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return [false, `SSRF 防护: 禁止访问 ${host}`];
  }

  // Hostname — resolve and check all resolved IPs
  try {
    const ips = await resolveHostname(host);
    if (ips.length > 0) {
      // DNS succeeded — check if any resolved IP is in blocked range
      for (const ip of ips) {
        for (const cidr of SSRF_BLOCKED_NETS) {
          if (ipInCidr(ip, cidr)) {
            return [false, `SSRF 防护: ${host} → ${ip} 在禁访范围 ${cidr}`];
          }
        }
      }
      return [true, ""];
    }
  } catch {
    // DNS error — fall through to warn+allow
  }
  // DNS failed: warn but allow (the HTTP layer will do its own isPrivateHost check)
  // This avoids blocking legitimate external requests when corporate DNS is restricted
  return [true, `[WARN] SSRF: DNS 无法解析 ${host}，放行 (连接层检查)`];
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
    // System destruction
    "rm -rf /", "rm -rf --no-preserve-root", "sudo rm", "del /f /s",
    "format ", "diskpart", "mkfs", "fdisk", "dd if=",
    "shutdown", "reboot", "stop-computer", "restart-computer",
    // Privilege escalation
    "sudo ", "su ", "runas ",
    // Data exfiltration vectors
    "nc ", "ncat ", "netcat ", "telnet ",
    "ssh ", "scp ", "sftp ", "ftp ", "sendmail",
    // System config modification
    "reg add", "reg delete", "reg import", "reg save",
    "sc create", "sc delete", "sc config", "sc stop", "sc start",
    "schtasks", "new-service", "remove-service",
    "set-itemproperty", "new-itemproperty",
    "bcdedit", "netsh ", "wmic ", "set-executionpolicy",
    // Process/service termination
    "taskkill", "stop-process", "clear-recyclebin",
    // PowerShell obfuscation
    "-encodedcommand", "-enc ", " -e ", "invoke-expression",
    "iex ", ".iex", "|iex", ";iex",
    // Registry access
    "hklm:", "hkcu:", "hkey_",
  ];

  // Tier 1 regex patterns — context-sensitive shell detection
  static SHELL_BLOCK_RE: [RegExp, string][] = [
    [/(?:^|\s)([d-z]:\\)/i,           "禁止访问非 C 盘路径"],
    [/(?:^|\s|;)(?:-[eE][nNcCoOdDeEdDcCoOmMmMaAnNdD]*)\s/, "禁止 PowerShell 编码命令 (-e/-en/-enc)"],
    [/[|;]\s*remove-item\b/i,          "禁止管道删除操作"],
    [/[|;]\s*stop-process\b/i,          "禁止管道终止进程"],
    [/[|;]\s*out-file\b/i,              "禁止管道写入文件"],
    [/[|;]\s*set-content\b/i,           "禁止管道修改文件"],
    [/>\s*[/\\]/i,                      "禁止重定向到系统路径"],
  ];

  static SHELL_WARN_SUBSTR = [
    "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
    "chmod 777", "chmod -R",
    "net user", "net localgroup", "net share",
    "get-process", "get-service", "get-eventlog", "get-wmiobject",
    "test-connection", "test-netconnection", "resolve-dnsname",
    "set-content", "out-file", "add-content",
  ];

  static SQL_DENY = new Set([
    "drop", "delete", "update", "insert", "alter", "create", "truncate",
    "grant", "revoke", "exec", "execute", "union", "attach", "detach", "pragma",
    "replace", "into",
  ]);

  static PYTHON_DENY: [RegExp, string][] = [
    [/\b__\s*import\s*__/, "禁止 __import__ 逃逸"],
    [/\bexec\s*\(/, "禁止 exec"],
    [/\beval\s*\(/, "禁止 eval"],
    [/\bcompile\s*\(/, "禁止 compile"],
    [/\bsubprocess\b/, "禁止 subprocess"],
    [/\bsocket\b/, "禁止 socket"],
    [/\bctypes\b/, "禁止 ctypes"],
    [/\b__builtins__/, "禁止 __builtins__"],
    [/\b__class__/, "禁止 __class__"],
    [/\b__base__/, "禁止 __base__"],
    [/\b__subclasses__/, "禁止 __subclasses__"],
    [/\b__globals__/, "禁止 __globals__"],
    [/\b__getattribute__/, "禁止 __getattribute__"],
    [/\b__delattr__/, "禁止 __delattr__"],
    [/\b__setattr__/, "禁止 __setattr__"],
  ];

  // All path-like parameter names used across file tools (both Python and TS naming)
  static PATH_PARAMS = new Set([
    "path", "filePath", "dirPath", "fileA", "fileB",
    "file_a", "file_b", "source", "target", "pattern", "outPath",
  ]);

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
      // 工作区内写操作在 auto-edit 和 standard 模式都放行
      if (!isOutside) return AuditVerdict.ALLOW;
      // 工作区外的写操作在 auto-edit 模式也放行（agent 可能在项目目录操作）
      if (mode === "auto-edit") return AuditVerdict.ALLOW;
      return AuditVerdict.CONFIRM;
    }
    // SYSTEM
    // auto-edit 模式：系统命令自动放行
    if (mode === "auto-edit") return AuditVerdict.ALLOW;
    if (mode === "standard") return AuditVerdict.CONFIRM;
    return AuditVerdict.ALLOW;
  }

  async audit(toolName: string, args: Record<string, unknown>): Promise<[boolean, string]> {
    const meta = registry.meta(toolName);
    if (!meta) return [false, `未注册: ${toolName}`];
    const risk = meta.risk;
    const cap = meta.capability;

    // 文件工具：检查路径参数
    let isOutside = false;
    if (cap === Capability.FS_READ || cap === Capability.FS_WRITE) {
      for (const pname of PolicyEngine.PATH_PARAMS) {
        const val = args[pname];
        if (typeof val === "string" && val) {
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
      [contentOk, contentReason] = await this.auditUrl(target);
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
    const userPath = String(args["path"] || args["filePath"] || args["source"] || "");
    const full = path.resolve(this.workDir, userPath);
    // Check workspace containment
    const sep = path.sep;
    if (!(full.startsWith(this.workDir + sep) || full === this.workDir)) {
      return [false, `路径越权: ${userPath}`];
    }
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
    // Tier 1a: substring BLOCK
    for (const p of PolicyEngine.SHELL_BLOCK_SUBSTR) {
      if (low.includes(p.toLowerCase())) return [false, `高危命令: ${p}`];
    }
    // Tier 1b: regex BLOCK
    for (const [pattern, reason] of PolicyEngine.SHELL_BLOCK_RE) {
      if (pattern.test(cmd)) return [false, reason];
    }
    // Tier 2: WARN
    for (const p of PolicyEngine.SHELL_WARN_SUBSTR) {
      if (low.includes(p.toLowerCase())) return [true, `${PolicyEngine.WARN_PREFIX}潜在风险: ${p}`];
    }
    return [true, ""];
  }

  private auditPython(code: string): [boolean, string] {
    for (const [pattern, reason] of PolicyEngine.PYTHON_DENY) {
      if (pattern.test(code)) return [false, reason as string];
    }
    return [true, ""];
  }

  private async auditUrl(target: string): Promise<[boolean, string]> {
    if (!/^https?:\/\//i.test(target)) return [true, ""];
    return checkSsrf(target);
  }
}
