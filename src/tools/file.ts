/**
 * 文件操作工具 — 与 Python tools.py 文件部分对应
 */
import * as fs from "fs";
import * as path from "path";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

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
    const now = new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const weekNum = Math.ceil(((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${days[now.getDay()]} (week ${String(weekNum).padStart(2, "0")})`;
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
    // 按修改时间排序（最近修改在前），与 Python 端对齐
    matches.sort((a: string, b: string) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return `(${matches.length} 个匹配)\n` + matches.map((m: string) => `  ${path.relative(base, m)}`).join("\n");
  },
);

registry.register("正则搜索文件内容", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", pattern: "string", dirPath: "string", globFilter: "string", head: "number" },
  function grep(workDir: string, args: Record<string, unknown>): string {
    const pattern = String(args["pattern"]); const dirPath = String(args["dirPath"] || ".");
    const globFilter = String(args["globFilter"] || ""); const head = Number(args["head"] || 50);
    let regex: RegExp;
    try { regex = new RegExp(pattern); } catch { return "(x) 正则错误"; }
    // glob 通配符 → 正则（支持 *.ts, *.py 等，与 Python fnmatch 对齐）
    let globRegex: RegExp | null = null;
    if (globFilter) {
      const gr = globFilter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      try { globRegex = new RegExp("^" + gr + "$"); } catch { /* invalid glob */ }
    }
    const base = path.resolve(path.isAbsolute(dirPath) ? dirPath : path.join(workDir, dirPath));
    if (!fs.existsSync(base)) return `(x) 路径不存在: ${dirPath}`;
    const results: string[] = [];
    const search = (p: string) => {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        try {
          const lines = fs.readFileSync(p, "utf-8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${p}:${i + 1}: ${lines[i].replace(/\s+$/, "").slice(0, 200)}`);
              if (results.length >= head) return;
            }
          }
        } catch { /* skip unreadable */ }
      } else if (stat.isDirectory()) {
        try {
          for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
            if (results.length >= head) return;
            if (globRegex && !globRegex.test(entry.name)) continue;
            search(path.join(p, entry.name));
          }
        } catch { /* skip unreadable dirs */ }
      }
    };
    search(base);
    if (!results.length) return `(未找到匹配 '${pattern}' 的结果)`;
    return `(${results.length} 条)\n` + results.join("\n");
  },
);

registry.register("文件差异对比", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", fileA: "string", fileB: "string" },
  function diff_files(workDir: string, args: Record<string, unknown>): string {
    const a = String(args["fileA"]); const b = String(args["fileB"]);
    const pa = path.resolve(path.isAbsolute(a) ? a : path.join(workDir, a));
    const pb = path.resolve(path.isAbsolute(b) ? b : path.join(workDir, b));
    if (!fs.existsSync(pa)) return `(x) 文件不存在: ${a}`;
    if (!fs.existsSync(pb)) return `(x) 文件不存在: ${b}`;
    const ca = fs.readFileSync(pa, "utf-8").split("\n");
    const cb = fs.readFileSync(pb, "utf-8").split("\n");
    // 防止大文件 OOM：LCS 表为 O(n*m)，限制总行数
    const MAX_DIFF_LINES = 4000;
    if (ca.length > MAX_DIFF_LINES || cb.length > MAX_DIFF_LINES) {
      // 退化为按行截断的简单差异
      const limit = 200;
      const head = Math.min(ca.length, limit);
      const tailA = ca.slice(head), tailB = cb.slice(head);
      const lines: string[] = [`--- ${a}\n+++ ${b}`];
      for (let k = 0; k < head; k++) {
        if (ca[k] !== cb[k]) { lines.push(`- ${ca[k]}`); lines.push(`+ ${cb[k]}`); }
      }
      if (tailA.length || tailB.length) lines.push(`(文件过大，仅对比前 ${head} 行；后续 ${tailA.length}/${tailB.length} 行省略)`);
      return lines.length > 1 ? lines.join("\n") : "(文件完全相同)";
    }
    // Unified diff (LCS-based, matching Python difflib.unified_diff output)
    const diff: string[] = [];
    const n = ca.length, m = cb.length;
    // Build LCS table
    const dp: number[][] = Array(n + 1).fill(0).map(() => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = ca[i] === cb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    // Backtrack to produce diff
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ca[i] === cb[j]) { i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { diff.push(`- ${ca[i]}`); i++; }
      else { diff.push(`+ ${cb[j]}`); j++; }
    }
    while (i < n) { diff.push(`- ${ca[i]}`); i++; }
    while (j < m) { diff.push(`+ ${cb[j]}`); j++; }
    if (!diff.length) return "(文件完全相同)";
    const header = `--- ${a}\n+++ ${b}\n`;
    return header + diff.slice(0, 80).join("\n");
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
    if (op === "cp") { fs.cpSync(sp, path.resolve(path.isAbsolute(tgt) ? tgt : path.join(workDir, tgt)), { recursive: true }); return `已复制 ${src} → ${tgt}`; }
    if (op === "mv") {
      const dp = path.resolve(path.isAbsolute(tgt) ? tgt : path.join(workDir, tgt));
      const parent = path.dirname(dp);
      if (parent) fs.mkdirSync(parent, { recursive: true });
      fs.renameSync(sp, dp);
      return `已移动 ${src} → ${tgt}`;
    }
    if (op === "rm") {
      const workRoot = path.resolve(workDir);
      if (sp === workRoot) return "(x) 禁止删除工作目录根目录";
      fs.rmSync(sp, { recursive: true }); return `已删除 ${src}`;
    }
    return `(x) 不支持: ${op} (可用: cp, mv, rm, mkdir)`;
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
    const query = String(args["query"] || "SELECT * LIMIT 50");
    if (!fs.existsSync(d)) return `(x) 文件不存在: ${p}`;
    try {
      const raw = fs.readFileSync(d, "utf-8").trim();
      const lines = raw.split("\n");
      if (!lines.length) return "(空CSV)";
      const cols = lines[0].split(",").map((c: string) => c.trim());
      const rows: Record<string, string>[] = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(",");
        const row: Record<string, string> = {};
        cols.forEach((c: string, ci: number) => { row[c] = (vals[ci] || "").trim(); });
        rows.push(row);
      }
      if (!rows.length) return "(空CSV)";
      // 大小写不敏感的列名查找
      const colLower = new Map<string, string>(cols.map((c: string) => [c.toLowerCase(), c]));
      const resolveCol = (name: string): string => colLower.get(name.toLowerCase()) || name;
      // ── SQL 解析: SELECT cols FROM table WHERE cond ORDER BY col LIMIT n ──
      // 不大写整个查询（保留值原始大小写），用 IGNORECASE 正则拆分关键词
      const splitKw = (text: string, kw: string): string[] => {
        const re = new RegExp("\\s+" + kw + "\\s+", "i");
        const idx = text.search(re);
        if (idx === -1) return [text];
        const match = text.match(re)!;
        return [text.slice(0, idx), text.slice(idx + match[0].length)];
      };
      // 去掉 SELECT 前缀
      let working = query.replace(/^\s*SELECT\s+/i, "").trim();
      // 分离 LIMIT
      let limit = 50;
      const limParts = splitKw(working, "LIMIT");
      if (limParts.length === 2) {
        working = limParts[0].trim();
        limit = parseInt(limParts[1].trim()) || 50;
      }
      // 分离 ORDER BY
      let orderBy: string | null = null;
      const obParts = splitKw(working, "ORDER\\s+BY");
      if (obParts.length === 2) {
        working = obParts[0].trim();
        orderBy = obParts[1].trim();
      }
      // 分离 WHERE
      let whereClause: string | null = null;
      const wParts = splitKw(working, "WHERE");
      if (wParts.length === 2) {
        working = wParts[0].trim();
        whereClause = wParts[1].trim();
      }
      // 去掉 FROM table
      const fromParts = splitKw(working, "FROM");
      if (fromParts.length === 2) {
        working = fromParts[0].trim();
      }
      // 解析选择的列
      let selected: string[];
      if (working.trim() === "*" || !working.trim()) {
        selected = cols;
      } else {
        selected = working.split(",").map((c: string) => resolveCol(c.trim()));
      }
      let filtered = rows;
      // ── WHERE 过滤: 支持 =, !=, >, <, >=, <= ──
      if (whereClause) {
        const m = whereClause.match(/(\w+)\s*(>=|<=|!=|=|>|<)\s*(.+)/);
        if (m) {
          const col = resolveCol(m[1]);
          const op = m[2];
          const val = m[3].trim().replace(/^["']/, "").replace(/["']$/, "");
          const fv = parseFloat(val);
          filtered = filtered.filter((r: Record<string, string>) => {
            const v = r[col] || "";
            const fv2 = parseFloat(v);
            const isNum = !isNaN(fv) && !isNaN(fv2);
            switch (op) {
              case "=": return v === val || (isNum && fv2 === fv);
              case "!=": return v !== val;
              case ">": return isNum ? fv2 > fv : false;
              case "<": return isNum ? fv2 < fv : false;
              case ">=": return isNum ? fv2 >= fv : false;
              case "<=": return isNum ? fv2 <= fv : false;
              default: return false;
            }
          });
        }
      }
      // ── ORDER BY 排序 ──
      if (orderBy) {
        const desc = orderBy.endsWith(" DESC");
        const col = resolveCol(orderBy.replace(" DESC", "").replace(" ASC", "").trim());
        filtered.sort((a: Record<string, string>, b: Record<string, string>) => {
          const av = a[col] || "", bv = b[col] || "";
          const fav = parseFloat(av), fbv = parseFloat(bv);
          if (!isNaN(fav) && !isNaN(fbv)) return desc ? fbv - fav : fav - fbv;
          return desc ? bv.localeCompare(av) : av.localeCompare(bv);
        });
      }
      filtered = filtered.slice(0, limit);
      const outLines = [selected.join(" | "), "-".repeat(Math.max(selected.join(" | ").length, 10))];
      for (const r of filtered) outLines.push(selected.map((c: string) => r[c] || "").join(" | "));
      return `(${filtered.length} 行)\n` + outLines.join("\n");
    } catch (e) { return `(x) ${e}`; }
  },
);

registry.register(
  "列出当前 Agent 已注册的所有工具及其描述和参数定义。\n在开始任何任务之前，应先调用此工具了解你拥有哪些能力，再规划行动方案。\n返回每个工具的名称、描述、风险等级和参数列表。",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function list_tools(): string {
    const schemas = registry.schemas;
    const lines: string[] = [`=== 已注册工具 (${schemas.length} 个) ===\n`];
    for (const s of schemas) {
      const fn = s.function;
      const name = fn.name;
      const desc = (fn.description || "").split("\n")[0].slice(0, 100);
      const params = (fn.parameters as any).properties || {};
      const required: string[] = (fn.parameters as any).required || [];
      const meta = registry.meta(name);
      const riskStr = meta ? meta.risk.toString().split(".").pop() : "?";
      const capStr = meta ? meta.capability : "?";
      const paramParts: string[] = [];
      for (const [pname, pinfo] of Object.entries(params)) {
        const ptype = (pinfo as any).type || "?";
        const req = required.includes(pname) ? "必填" : "可选";
        paramParts.push(`${pname}(${ptype},${req})`);
      }
      const paramsStr = paramParts.length ? paramParts.join(", ") : "无参数";
      lines.push(`  ● ${name}`);
      lines.push(`    描述: ${desc}`);
      lines.push(`    风险: ${riskStr} | 能力: ${capStr}`);
      lines.push(`    参数: ${paramsStr}`);
      lines.push("");
    }
    return lines.join("\n");
  },
);

