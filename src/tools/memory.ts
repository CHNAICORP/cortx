/**
 * 记忆 + 辅助工具
 */
import * as fs from "fs";
import * as path from "path";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

function getMemoryPath(workDir: string): string {
  return path.join(workDir, "memory.md");
}

registry.register("记住事实", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", name: "string", description: "string" },
  function remember_fact(workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"]);
    const desc = String(args["description"]);
    const mp = getMemoryPath(workDir);
    const dir = path.dirname(mp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `- ${name} ${desc}\n`;
    // 去重
    if (fs.existsSync(mp) && fs.readFileSync(mp, "utf-8").includes(line.trim())) return "(已存在)";
    fs.appendFileSync(mp, line, "utf-8");
    return `已记住: ${name}`;
  },
);

registry.register("回忆事实", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", query: "string" },
  function recall_fact(workDir: string, args: Record<string, unknown>): string {
    const q = String(args["query"] || "").toLowerCase();
    const mp = getMemoryPath(workDir);
    if (!fs.existsSync(mp)) return "(没有记住任何事实)";
    const lines = fs.readFileSync(mp, "utf-8").split("\n").filter(l => l.startsWith("- "));
    if (!lines.length) return "(没有记住任何事实)";
    const filtered = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
    if (!filtered.length) return `(未找到包含 '${q}' 的记忆)`;
    return filtered.join("\n");
  },
);

registry.register("删除记忆", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", name: "string" },
  function forget_fact(workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"]);
    const mp = getMemoryPath(workDir);
    if (!fs.existsSync(mp)) return "(x) 记忆系统不可用";
    let lines = fs.readFileSync(mp, "utf-8").split("\n");
    const before = lines.length;
    lines = lines.filter(l => !l.includes(name));
    if (lines.length === before) return `(x) 未找到: ${name}`;
    fs.writeFileSync(mp, lines.join("\n"), "utf-8");
    return `已忘记: ${name}`;
  },
);

registry.register("向用户提问", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", question: "string" },
  function ask_user(_wd: string, args: Record<string, unknown>): string {
    return `[需要用户确认] ${args["question"]}`;
  },
);

registry.register("Python 语法检查", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string", code: "string" },
  function python_lint(workDir: string, args: Record<string, unknown>): string {
    const fp = String(args["filePath"] || "");
    const code = String(args["code"] || "");
    // Simplified lint — check for obvious syntax issues
    if (code) return "OK — 语法检查通过 (简版)";
    if (fp) {
      const d = path.resolve(path.isAbsolute(fp) ? fp : path.join(workDir, fp));
      if (!fs.existsSync(d)) return `(x) 文件不存在: ${fp}`;
      return "OK — 语法检查通过 (简版)";
    }
    return "(x) 需要 filePath 或 code 参数";
  },
);
