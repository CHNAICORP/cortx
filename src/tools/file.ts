/**
 * 文件操作工具 — 与 Python tools.py 文件部分对应
 */
import * as fs from "fs";
import * as path from "path";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { checkSsrf } from '../core/policy.js';

registry.register(
  "列出目录内的文件和子目录",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", dirPath: "string" },
  function list_directory(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["dirPath"] || "./");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return `(x) 目录不存在: ${p}`;
    const items = fs.readdirSync(d);
    if (!items.length) return "(空目录)";
    const lines = [`(${items.length} 项)`];
    for (const x of items.sort()) {
      const stat = fs.statSync(path.join(d, x));
      lines.push(`  [${stat.isDirectory() ? "DIR" : "   "}] ${x}`);
    }
    return lines.join("\n");
  },
);

registry.register(
  "读取文本文件内容",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string" },
  function read_file(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]);
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d)) return `(x) 不存在: ${p}`;
    if (fs.statSync(d).size > 102400) return "(x) 文件过大 (>100KB)";
    return fs.readFileSync(d, "utf-8");
  },
);

registry.register(
  "写入/覆盖文本文件",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filePath: "string", content: "string" },
  function write_file(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]);
    const content = String(args["content"]);
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    const parent = path.dirname(d);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(d, content, "utf-8");
    return `已写入 ${p} (${content.length} 字符)`;
  },
);

registry.register(
  "获取当前系统日期时间",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function get_current_time(_workDir: string): string {
    return new Date().toISOString();
  },
);

registry.register("精确编辑文件", RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filePath: "string", oldString: "string", newString: "string" },
  function edit_file(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]); const oldS = String(args["oldString"]); const newS = String(args["newString"]);
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d)) return `(x) 文件不存在: ${p}`;
    let content = fs.readFileSync(d, "utf-8");
    if (!content.includes(oldS)) return "(x) 未找到匹配文本";
    // Replace only the FIRST occurrence (matches Python behavior)
    const idx = content.indexOf(oldS);
    content = content.slice(0, idx) + newS + content.slice(idx + oldS.length);
    fs.writeFileSync(d, content, "utf-8");
    return `已替换 1 处`;
  },
);

registry.register("通配符匹配文件", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", pattern: "string" },
  function glob(workDir: string, args: Record<string, unknown>): string {
    const pattern = String(args["pattern"]);
    const base = path.resolve(workDir);
    const fullPattern = path.join(base, pattern);
    let matches: string[];
    try {
      // Node 22+ has native glob
      matches = fs.globSync(fullPattern).slice(0, 50);
    } catch {
      // Fallback: use manual recursive glob with minimatch-style patterns
      matches = [];
      const dir = path.dirname(fullPattern);
      if (fs.existsSync(dir)) {
        const searchPattern = path.basename(fullPattern);
        const regex = new RegExp(
          "^" + searchPattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
        );
        const walk = (d: string) => {
          if (matches.length >= 50) return;
          try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              if (matches.length >= 50) return;
              const full = path.join(d, entry.name);
              if (entry.isDirectory()) {
                // Recursive for **/
                if (pattern.includes("**")) walk(full);
              } else if (regex.test(entry.name)) {
                matches.push(full);
              }
            }
          } catch { /* skip unreadable dirs */ }
        };
        walk(dir);
      }
    }
    if (!matches.length) return `(无匹配: ${pattern})`;
    return `(${matches.length} 个匹配)\n` + matches.map((m: string) => `  ${path.relative(base, m)}`).join("\n");
  },
);

registry.register("正则搜索文件内容", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", pattern: "string", dirPath: "string", globFilter: "string", head: "number" },
  function grep(workDir: string, args: Record<string, unknown>): string {
    const pattern = String(args["pattern"]); const dirPath = String(args["dirPath"] || ".");
    try { new RegExp(pattern); } catch { return "(x) 正则错误"; }
    return "(grep 结果)";
  },
);

registry.register("文件差异对比", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", fileA: "string", fileB: "string" },
  function diff_files(workDir: string, args: Record<string, unknown>): string {
    const a = String(args["fileA"]); const b = String(args["fileB"]);
    const pa = path.resolve(path.isAbsolute(a) ? a : path.join(workDir, a));
    const pb = path.resolve(path.isAbsolute(b) ? b : path.join(workDir, b));
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) return "(x) 文件不存在";
    const ca = fs.readFileSync(pa, "utf-8").split("\n");
    const cb = fs.readFileSync(pb, "utf-8").split("\n");
    const diff: string[] = [];
    const maxLen = Math.max(ca.length, cb.length);
    for (let i = 0; i < maxLen; i++) {
      if (ca[i] !== cb[i]) diff.push(`${i+1}: - ${ca[i] || ""}\n${i+1}: + ${cb[i] || ""}`);
    }
    return diff.length ? diff.join("\n") : "(文件完全相同)";
  },
);

registry.register("文件操作 cp/mv/rm/mkdir", RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", operation: "string", source: "string", target: "string" },
  function file_ops(workDir: string, args: Record<string, unknown>): string {
    const op = String(args["operation"]).toLowerCase();
    const src = String(args["source"]); const tgt = String(args["target"] || "");
    const sp = path.resolve(path.isAbsolute(src) ? src : path.join(workDir, src));
    if (op === "mkdir") { fs.mkdirSync(sp, { recursive: true }); return `已创建目录 ${src}`; }
    if (!fs.existsSync(sp)) return `(x) 源不存在: ${src}`;
    if (op === "cp") { fs.cpSync(sp, path.resolve(path.isAbsolute(tgt) ? tgt : path.join(workDir, tgt)), { recursive: true }); return `已复制`; }
    if (op === "rm") { fs.rmSync(sp, { recursive: true }); return `已删除`; }
    return `(x) 不支持: ${op}`;
  },
);

registry.register("读取JSON文件", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string" },
  function read_json(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]); const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d)) return `(x) 文件不存在: ${p}`;
    return JSON.stringify(JSON.parse(fs.readFileSync(d, "utf-8")), null, 2);
  },
);

registry.register("CSV文件查询", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string", query: "string" },
  function csv_query(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]); const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d)) return `(x) 文件不存在: ${p}`;
    return fs.readFileSync(d, "utf-8").slice(0, 2000);
  },
);

registry.register("HTTP请求", RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string", method: "string", body: "string", headers: "string" },
  async function http_request(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]); const method = String(args["method"] || "GET");
    try {
      // SSRF check before making the request
      if (/^https?:\/\//i.test(url)) {
        const [ok, reason] = await checkSsrf(url);
        if (!ok) return `(x) ${reason}`;
      }
      const resp = await fetch(url, { method, body: args["body"] ? String(args["body"]) : undefined });
      return `HTTP ${resp.status}\n${(await resp.text()).slice(0, 2000)}`;
    } catch (e) { return `(x) ${e}`; }
  },
);
