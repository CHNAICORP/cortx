/**
 * 执行工具 — Shell / Python / SQL / 时间 / 任务
 * 
 * 超时策略：空闲超时（Inactivity Timeout）
 *   - 命令持续产生输出 → 一直等待，不中断
 *   - 命令 N 秒无任何输出 → 判定卡死，超时中断
 *   - 硬上限 5 分钟作为安全网
 */
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

// ── 超时配置 ──
let INACTIVITY_TIMEOUT = 30;   // 空闲超时（秒）：无输出超过此时间则判定卡死
const MAX_TIMEOUT = 300;       // 硬上限（秒）：无论如何最多运行 5 分钟

/** 从 AgentConfig 同步 toolTimeout（与 Python set_tool_timeout 对齐） */
export function setToolTimeout(seconds: number): void {
  if (seconds > 0) INACTIVITY_TIMEOUT = seconds;
}

// ── 后台进程注册表 ──
const _bgProcesses = new Map<number, { proc: any; command: string; startTime: number; logFile: string }>();

/**
 * 使用空闲超时执行子进程（异步）。
 * 
 * 与 spawnSync(timeout=N) 的区别：
 * - spawnSync: 硬超时 — N 秒后无条件杀死，即使命令在持续输出
 * - 本函数: 空闲超时 — 仅当 N 秒无输出时才杀死；命令持续输出则一直等待
 *           另有硬上限 MAX_TIMEOUT 作为安全网
 */
function runWithInactivityTimeout(
  cmd: string, cmdArgs: string[], cwd: string
): Promise<{ retcode: number | null; stdout: string; stderr: string; timeoutReason: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let lastActivity = Date.now();
    const startTime = Date.now();
    let timeoutReason: string | null = null;
    let settled = false;

    /** 强制终止整个进程树（Windows: taskkill /T /F；Unix: 进程组 kill）。
     *  仅 proc.kill() 会留下孤儿子进程，导致继承的 stdio 管道不关闭，
     *  'close' 事件永不触发 → Promise 永不 resolve → agent 卡死。*/
    const killTree = () => {
      try {
        if (process.platform === "win32" && proc.pid) {
          // /T = 连同子进程，/F = 强制
          spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { stdio: "ignore" });
        } else {
          try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
        }
      } catch { /* 尽力而为 */ }
      try { proc.kill(); } catch { /* 已退出 */ }
    };

    /** 安全网：kill 后若 3s 内 'close' 仍未触发（孤儿进程持有管道），
     *  强制 resolve，避免 agent 永久卡死。*/
    const forceResolveGuard = () => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({
            retcode: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
            stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
            timeoutReason: timeoutReason || "force",
          });
        }
      }, 3000);
    };

    const inactivityTimer = setInterval(() => {
      if (settled) return;
      const idle = (Date.now() - lastActivity) / 1000;
      const total = (Date.now() - startTime) / 1000;
      if (idle > INACTIVITY_TIMEOUT) {
        timeoutReason = "inactivity";
        clearInterval(inactivityTimer);
        killTree();
        forceResolveGuard();
      } else if (total > MAX_TIMEOUT) {
        timeoutReason = "max";
        clearInterval(inactivityTimer);
        killTree();
        forceResolveGuard();
      }
    }, 500); // 500ms 轮询

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      lastActivity = Date.now();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      lastActivity = Date.now();
    });

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearInterval(inactivityTimer);
        resolve({
          retcode: code,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
          stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
          timeoutReason,
        });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearInterval(inactivityTimer);
        resolve({
          retcode: null,
          stdout: "",
          stderr: String(err),
          timeoutReason: null,
        });
      }
    });
  });
}

registry.register("执行系统命令", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", command: "string" },
  async function run_shell_command(workDir: string, args: Record<string, unknown>): Promise<string> {
    const cmd = String(args["command"]);
    // ── 阻塞命令检测 ──
    const blockingPatterns = [
      // npm/npx
      /\b(npm\s+start|npm\s+run\s+dev|npm\s+run\s+serve)\b/i,
      /\b(npx\s+.*serve|npx\s+.*start)\b/i,
      // Python 服务器
      /\b(flask\s+run)\b/i,
      /\b(python\s+manage\.py\s+runserver)\b/i,
      /\b(uvicorn\s+|gunicorn\s+|hypercorn\s+)\b/i,
      /\b(python\s+-m\s+http\.server)\b/i,
      /\b(python\s+app\.py|python\s+server\.py|python\s+main\.py)\b/i,
      /\b(python\s+run\.py|python\s+start\.py)\b/i,
      // Node 服务器
      /\b(node\s+server|node\s+app|node\s+index)\b/i,
      // 其他
      /\b(php\s+-S)\b/i,
      /\b(rails\s+server|rails\s+s)\b/i,
      /\b(docker\s+run|docker-compose\s+up)\b/i,
      // Go / Rust / Git daemon（与 Python 对齐）
      /\b(go\s+run\s+)\b/i,
      /\b(cargo\s+run\s+)\b/i,
      /\b(git\s+daemon)\b/i,
    ];
    for (const pattern of blockingPatterns) {
      if (pattern.test(cmd)) {
        return `(x) 检测到阻塞命令: '${cmd}'\n该命令会启动长期运行的服务器进程，无法在 run_shell_command 中执行。\n\n✅ 正确做法：使用 run_background_command 工具在后台启动服务器，然后用 check_server_status 验证。\n   示例：run_background_command(command='python app.py')\n   然后：check_server_status(url='http://localhost:5000')`;
      }
    }
    const isWin = process.platform === "win32";
    // PowerShell 5.x 不支持 &&，自动转换为 ; 避免语法错误
    const effectiveCmd = isWin ? cmd.replace(/&&/g, ';') : cmd;
    const cmdArgs = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", effectiveCmd]
      : ["-c", cmd];
    const exe = isWin ? "powershell" : "bash";

    const { retcode, stdout, stderr, timeoutReason } = await runWithInactivityTimeout(exe, cmdArgs, workDir);

    if (timeoutReason === "inactivity") {
      const partial = (stdout + stderr).trim();
      const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
      return `(x) 空闲超时（命令 ${INACTIVITY_TIMEOUT}s 无任何输出，判定为卡死）\n命令: ${cmd}\n${partialMsg}\n\n可能的原因:\n  1. 命令启动了阻塞式进程（如服务器）等待输入\n  2. 命令在等待网络响应\n  3. 命令进入了交互模式`;
    } else if (timeoutReason === "max") {
      const partial = (stdout + stderr).trim();
      const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
      return `(x) 硬超时（命令执行超过 ${MAX_TIMEOUT}s 上限）\n命令: ${cmd}${partialMsg}`;
    }

    const out = (stdout + stderr).trim() || "(无输出)";
    return `exit=${retcode}\n${out}`;
  },
);

registry.register("执行 Python 代码", RiskLevel.SYSTEM, Capability.PYTHON,
  { workDir: "string", code: "string" },
  async function run_python(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const code = String(args["code"]);
    try {
      const rnd = Math.random().toString(36).slice(2, 8);
      const tmp = path.join(require("os").tmpdir(), `ctx_py_${Date.now()}_${rnd}.py`);
      fs.writeFileSync(tmp, code, "utf-8");
      try {
        const { retcode, stdout, stderr, timeoutReason } = await runWithInactivityTimeout("python", [tmp], _workDir);
        if (timeoutReason === "inactivity") {
          const partial = (stdout + stderr).trim();
          const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
          return `(x) 空闲超时（Python 代码 ${INACTIVITY_TIMEOUT}s 无输出，判定为卡死）\n可能的原因:\n  1. 代码中有 input() 等待用户输入\n  2. 代码在等待网络响应\n  3. 代码进入了死循环但不产生输出${partialMsg}`;
        } else if (timeoutReason === "max") {
          const partial = (stdout + stderr).trim();
          const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
          return `(x) 硬超时（Python 代码执行超过 ${MAX_TIMEOUT}s 上限）${partialMsg}`;
        }
        const out = (stdout + stderr).trim().slice(0, 3000) || "(无输出)";
        return `exit=${retcode}\n${out}`;
      } finally {
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

// ══════════════════════════════════════════════════════════════
// 后台进程管理 — 启动服务器、验证状态、停止进程
// ══════════════════════════════════════════════════════════════

registry.register(
  "在后台启动长期运行的命令（如 Flask/Express 服务器），立即返回 PID。配合 check_server_status 验证。",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", command: "string" },
  function run_background_command(workDir: string, args: Record<string, unknown>): string {
    const cmd = String(args["command"]);
    const isWin = process.platform === "win32";
    const logFile = path.join(workDir, `.bg_log_${Date.now()}.txt`);

    const cmdArgs = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", cmd.replace(/&&/g, ';')]
      : ["-c", cmd];
    const exe = isWin ? "powershell" : "bash";

    try {
      const logFd = fs.openSync(logFile, "w");
      const proc = spawn(exe, cmdArgs, {
        cwd: workDir,
        stdio: ["ignore", logFd, logFd],
        detached: false,
      });
      fs.closeSync(logFd);

      const pid = proc.pid;
      if (pid === undefined) {
        return `(x) 后台进程启动失败: spawn 未返回 PID (进程可能未创建)\n命令: ${cmd}`;
      }
      _bgProcesses.set(pid, { proc, command: cmd, startTime: Date.now(), logFile });

      // Check if process crashed immediately (check after 1s)
      // Note: We can't sleep synchronously in sync context, so we check poll()
      // The caller should use check_server_status after a brief wait
      if (proc.exitCode !== null && proc.exitCode !== 0) {
        let logContent = "";
        try { logContent = fs.readFileSync(logFile, "utf-8").trim().slice(0, 500); } catch { /* */ }
        return `(x) 后台进程启动后立即退出 (exit=${proc.exitCode})\n命令: ${cmd}\n日志:\n${logContent}`;
      }

      return `✅ 后台进程已启动 (PID=${pid})\n命令: ${cmd}\n日志: ${logFile}\n提示: 等待 2-3 秒后使用 check_server_status 验证（自动重试3次）\n      使用 stop_background_process(pid=${pid}) 停止进程`;
    } catch (e) { return `(x) 后台启动失败: ${e}`; }
  },
);

registry.register(
  "检查服务器状态（HTTP 健康检查）。发送 HTTP 请求验证服务是否正常运行。",
  RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string", expected_status: "number" },
  async function check_server_status(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    const expectedStatus = Number(args["expected_status"] || 200);
    const timeout = 5000;

    // Security: only localhost
    if (!/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(url)) {
      return `(x) 安全限制：check_server_status 仅允许检查本地服务 (localhost/127.0.0.1)\nURL: ${url}`;
    }

    // 自动重试：服务器可能需要几秒才能就绪
    const maxRetries = 3;
    const retryDelay = 1500;
    let lastErr = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "CortexAgent/HealthCheck" } });
        const body = await resp.text();
        const ok = resp.status === expectedStatus;
        const icon = ok ? "✅" : "⚠";
        const retryNote = attempt > 1 ? ` (第${attempt}次尝试成功)` : "";
        return `${icon} 服务正常运行${retryNote}\nURL: ${url}\nHTTP 状态码: ${resp.status} (期望: ${expectedStatus})\n响应体预览: ${body.slice(0, 200)}`;
      } catch (e: any) {
        const msg = String(e?.message || e);
        lastErr = msg;
        if (attempt < maxRetries && (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))) {
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
      }
    }
    return `(x) 服务未启动或端口未监听（已重试 ${maxRetries} 次）\nURL: ${url}\n可能的原因:\n  1. 服务器进程未成功启动\n  2. 服务器正在启动中，尚未就绪\n  3. 端口号错误\n建议: 检查后台进程日志 (list_background_processes + read_file 查看日志)`;
  },
);

registry.register(
  "停止后台进程（通过 PID）",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", pid: "number" },
  function stop_background_process(_wd: string, args: Record<string, unknown>): string {
    const pid = Number(args["pid"]);
    const info = _bgProcesses.get(pid);
    if (!info) {
      try { process.kill(pid); return `✅ 已发送终止信号 (PID=${pid})`; }
      catch (e) { return `(x) 进程 ${pid} 不在注册表中，且直接终止失败: ${e}`; }
    }

    try {
      info.proc.kill("SIGTERM");
      const elapsed = ((Date.now() - info.startTime) / 1000).toFixed(1);
      let logTail = "";
      try { logTail = fs.readFileSync(info.logFile, "utf-8").split("\n").slice(-10).join("\n").trim(); } catch { /* */ }
      _bgProcesses.delete(pid);
      return `✅ 后台进程已停止 (PID=${pid})\n命令: ${info.command}\n运行时长: ${elapsed}s\n最后日志:\n${logTail.slice(0, 500)}`;
    } catch (e) { return `(x) 终止进程 ${pid} 失败: ${e}`; }
  },
);

registry.register(
  "列出所有正在运行的后台进程",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function list_background_processes(): string {
    if (_bgProcesses.size === 0) return "(无后台进程)";
    const lines = [`运行中的后台进程 (${_bgProcesses.size} 个):\n`];
    for (const [pid, info] of _bgProcesses) {
      const elapsed = ((Date.now() - info.startTime) / 1000).toFixed(0);
      const alive = info.proc.exitCode === null ? "运行中" : `已退出(exit=${info.proc.exitCode})`;
      lines.push(`  PID=${pid} | ${alive} | ${elapsed}s | ${info.command.slice(0, 60)}`);
    }
    return lines.join("\n");
  },
);
