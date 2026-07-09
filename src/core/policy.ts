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
// 注意：127.0.0.0/8 和 ::1/128 已移除 — 允许 localhost 开发访问
const SSRF_BLOCKED_NETS = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4",
  "fc00::/7", "fe80::/10",
];

/** 将 IPv6 地址转为 BigInt（128 位），便于精确 CIDR 前缀匹配。失败返回 null。 */
function ipv6ToBigInt(ip: string): bigint | null {
  try {
    const norm = normalizeIPv6(ip);
    if (!norm) return null;
    let result = 0n;
    for (const group of norm.split(":")) {
      result = (result << 16n) | BigInt(parseInt(group, 16));
    }
    return result;
  } catch { return null; }
}

/** 规范化 IPv6 地址为 8 组 4 位 hex（不含 ::）。返回 null 表示格式非法。*/
function normalizeIPv6(ip: string): string | null {
  try {
    // 去掉 zone index
    ip = ip.split("%")[0].toLowerCase();
    // 处理 IPv4-mapped (::ffff:a.b.c.d)
    const v4Match = ip.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Match) {
      const parts = v4Match[2].split(".").map(Number);
      if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
      const hex1 = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, "0");
      const hex2 = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, "0");
      ip = v4Match[1] + hex1 + ":" + hex2;
    }
    // 展开 ::
    const dblIdx = ip.indexOf("::");
    if (dblIdx >= 0) {
      if (ip.indexOf("::", dblIdx + 1) >= 0) return null; // 只能有一个 ::
      const head = ip.slice(0, dblIdx);
      const tail = ip.slice(dblIdx + 2);
      const headGroups = head ? head.split(":") : [];
      const tailGroups = tail ? tail.split(":") : [];
      const fill = 8 - headGroups.length - tailGroups.length;
      if (fill < 0) return null;
      const groups = [...headGroups, ...Array(fill).fill("0"), ...tailGroups];
      ip = groups.join(":");
    }
    const groups = ip.split(":");
    if (groups.length !== 8) return null;
    return groups.map(g => g.padStart(4, "0")).join(":");
  } catch { return null; }
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [netStr, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr);
  if (isNaN(bits)) return false;
  // IPv6 路径
  if (cidr.includes(":")) {
    const ipBig = ipv6ToBigInt(ip);
    const netBig = ipv6ToBigInt(netStr);
    if (ipBig === null || netBig === null) return false;
    if (bits <= 0) return true;
    if (bits > 128) return false;
    const mask = (2n ** 128n - 1n) << BigInt(128 - bits) & (2n ** 128n - 1n);
    return (ipBig & mask) === (netBig & mask);
  }
  // IPv4 路径
  if (!ip.includes(".") ) return false;
  const [ipA, ipB, ipC, ipD] = ip.split(".").map(Number);
  const [nA, nB, nC, nD] = netStr.split(".").map(Number);
  if (isNaN(ipA) || isNaN(nA) || bits > 32) return false;
  const ipNum = ((ipA << 24) | (ipB << 16) | (ipC << 8) | ipD) >>> 0;
  const netNum = ((nA << 24) | (nB << 16) | (nC << 8) | nD) >>> 0;
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

async function resolveHostname(host: string): Promise<string[]> {
  // 使用 dns.lookup（系统 DNS 解析器）而非 dns.resolve4（c-ares）
  // 系统解析器兼容企业 DNS / VPN / hosts 文件
  return new Promise((resolve) => {
    dns.lookup(host, { all: true, family: 0 }, (err, addresses) => {
      if (err || !addresses) {
        return resolve([]);
      }
      resolve(addresses.map(a => a.address));
    });
  });
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

  // Hostname — resolve and check all resolved IPs
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
  }
  // DNS 失败或解析为空 → 放行（HTTP 层会处理）
  return [true, ""];
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
    // System destruction — 仅拦截真正危险的系统级操作
    "rm -rf /", "rm -rf --no-preserve-root", "del /f /s /q c:",
    "format ", "diskpart", "mkfs", "fdisk", "dd if=/dev/",
    "shutdown", "reboot", "stop-computer", "restart-computer",
    // Privilege escalation (仅真正的提权命令)
    "runas /user:",
    // Data exfiltration vectors
    "nc ", "ncat ", "netcat ",
    // System config modification
    "reg add", "reg delete", "reg import",
    "sc create", "sc delete", "sc config",
    "schtasks /create", "schtasks /delete",
    "new-service", "remove-service",
    "bcdedit", "netsh ", "set-executionpolicy",
    // PowerShell obfuscation (仅真正的混淆)
    "-encodedcommand", "-enc ",
    // Registry access
    "hklm:", "hkcu:", "hkey_",
  ];

  // Tier 1 regex patterns — context-sensitive shell detection
  static SHELL_BLOCK_RE: [RegExp, string][] = [
    // 仅拦截 PowerShell 编码命令（powershell/pwsh 上下文中的 -enc/-encodedcommand）
    // 不再拦截 node -e / python -e 等开发常用命令
    [/(?:powershell|pwsh)[\s\.\-].*(?:-(?:enc|encodedcommand)\s)/i, "禁止 PowerShell 编码命令 (-EncodedCommand)"],
    // 仅拦截针对根目录的批量静默删除
    [/del\s+\/[a-z]*s[a-z]*\s+\/q\s+[a-z]:\\?\s*$/i,  "禁止批量静默删除根目录"],
  ];

  static SHELL_WARN_SUBSTR = [
    "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
    "chmod 777", "chmod -R",
    "net user", "net localgroup", "net share",
    "get-eventlog", "get-wmiobject",
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
      // 文件读取操作在所有路径都放行 — 工作目录只是默认值，不是沙箱
      // 桌面、文档等用户目录都是合法的访问范围
      return AuditVerdict.ALLOW;
    }
    if (risk === RiskLevel.WRITE) {
      // 文件写操作在所有路径都放行 — 桌面、文档等用户目录都是合法的写入范围
      // 危险文件扩展名已在内容审计中拦截
      return AuditVerdict.ALLOW;
    }
    // SYSTEM 风险（shell/python 等）
    // 内容审计已通过 → 命令本身不危险
    // auto 模式自动放行
    if (mode === "auto") return AuditVerdict.ALLOW;
    // standard 模式：工作区内放行（开发命令如 npm/tsc/git/python 等）
    if (!isOutside) return AuditVerdict.ALLOW;
    return AuditVerdict.CONFIRM;
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

    // ── 内容审计 ──
    // yolo 模式：仅拦截极端危险命令（系统级毁灭），跳过其余内容审计
    // auto/standard 模式：完整内容审计
    let contentOk = true;
    let contentReason = "";
    if (this.config.permissionMode === "yolo") {
      // yolo 模式：仅检查极端危险命令（rm -rf /, format, shutdown 等）
      if (cap === Capability.SHELL) {
        const cmd = String(args["command"] || "");
        const low = cmd.toLowerCase();
        for (const p of PolicyEngine.SHELL_BLOCK_SUBSTR) {
          if (low.includes(p.toLowerCase())) {
            return [false, `YOLO 模式仍拦截极端危险命令: ${p}`];
          }
        }
      }
      // yolo 模式跳过 SQL/Python/SSRF/路径审计
      return [true, ""];
    }
    // auto/standard 模式：完整内容审计
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
    // MCP / BROWSER: 无内容审计 — 直接进入权限判决
    // 内容审计失败 → 直接拒绝
    if (!contentOk) return [false, contentReason];

    // ── 权限判决（yolo 模式已在上文提前返回）──
    const verdict = this.checkPermission(risk, isOutside);
    if (verdict === AuditVerdict.CONFIRM) return [false, "confirm"];
    if (verdict === AuditVerdict.DENY) return [false, "denied"];
    return [true, contentReason];
  }

  /** 文件写入内容审计：仅检查危险文件扩展名。路径权限由 checkPermission() 处理。 */
  private auditPathWrite(args: Record<string, unknown>): [boolean, string] {
    const userPath = String(args["path"] || args["filePath"] || args["source"] || "");
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
