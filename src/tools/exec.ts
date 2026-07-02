/**
 * 执行工具 — Shell / Python / SQL / 时间 / 任务
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

registry.register("执行系统命令", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", command: "string" },
  function run_shell_command(workDir: string, args: Record<string, unknown>): string {
    const cmd = String(args["command"]);
    const isWin = process.platform === "win32";
    try {
      const result = isWin
        ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd],
            { cwd: workDir, timeout: 10000, encoding: "utf-8" })
        : spawnSync("bash", ["-c", cmd],
            { cwd: workDir, timeout: 10000, encoding: "utf-8" });
      const out = ((result.stdout || "") + (result.stderr || "")).trim().slice(0, 2000) || "(无输出)";
      return `exit=${result.status}\n${out}`;
    } catch (e) { return `(x) ${e}`; }
  },
);

registry.register("执行 Python 代码", RiskLevel.SYSTEM, Capability.PYTHON,
  { workDir: "string", code: "string" },
  function run_python(_workDir: string, args: Record<string, unknown>): string {
    const code = String(args["code"]);
    try {
      // Use random suffix to prevent collision when two calls happen in same ms
      const rnd = Math.random().toString(36).slice(2, 8);
      const tmp = path.join(require("os").tmpdir(), `ctx_py_${Date.now()}_${rnd}.py`);
      fs.writeFileSync(tmp, code, "utf-8");
      try {
        const result = spawnSync("python", [tmp], { timeout: 10000, encoding: "utf-8" });
        const out = ((result.stdout || "") + (result.stderr || "")).trim().slice(0, 3000) || "(无输出)";
        return `exit=${result.status}\n${out}`;
      } finally {
        // Always clean up temp file even if spawn fails
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (e) { return `(x) Python 沙箱异常: ${e}`; }
  },
);

registry.register("执行只读 SQL 查询", RiskLevel.SAFE, Capability.DB_READ,
  { workDir: "string", sql: "string" },
  function execute_sql_query(workDir: string, args: Record<string, unknown>): string {
    const sql = String(args["sql"]).trim().replace(/;$/, "");
    const dbPath = path.join(workDir, "agent.db");
    if (!fs.existsSync(dbPath)) return "(x) agent.db 不存在";
    // SQLite via better-sqlite3 would be ideal, but for zero-deps we use node:sqlite (Node 22+)
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare(sql).all();
      db.close();
      if (!rows.length) return "(空结果)";
      const cols = Object.keys(rows[0] as object);
      const lines = [cols.join(" | "), "-".repeat(cols.join(" | ").length)];
      for (const r of rows.slice(0, 50)) {
        lines.push(cols.map(c => String((r as Record<string, unknown>)[c])).join(" | "));
      }
      return `(${rows.length} 行)\n${lines.join("\n")}`;
    } catch (e) { return `(x) SQL 查询失败: ${e}`; }
  },
);

// 模块级任务存储
const _tasks: { id: string; subject: string; description: string; status: string }[] = [];

registry.register("创建待办任务", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", subject: "string", description: "string" },
  function task_create(_wd: string, args: Record<string, unknown>): string {
    const subject = String(args["subject"]);
    const desc = String(args["description"] || "");
    const tid = `task_${(_tasks.length + 1).toString().padStart(3, "0")}_${subject.slice(0, 10).replace(/\s/g, "_")}`;
    _tasks.push({ id: tid, subject, description: desc, status: "pending" });
    return `已创建 #${tid}: ${subject}`;
  },
);

registry.register("列出所有任务", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function task_list(): string {
    if (!_tasks.length) return "(无任务)";
    return _tasks.map(t => `${t.id.padEnd(30)} [${t.status.padEnd(12)}] ${t.subject}`).join("\n");
  },
);

registry.register("更新任务状态", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", task_id: "string", status: "string" },
  function task_update(_wd: string, args: Record<string, unknown>): string {
    const tid = String(args["task_id"]);
    const st = String(args["status"]);
    for (const t of _tasks) {
      if (t.id === tid) {
        if (["pending", "in_progress", "completed", "deleted"].includes(st)) {
          t.status = st;
          return `任务 ${t.id} → ${st}`;
        }
        return `(x) 无效状态: ${st}`;
      }
    }
    return `(x) 未找到任务: ${tid}`;
  },
);
