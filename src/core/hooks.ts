/**
 * Hooks System — 生命周期钩子
 * 
 * 支持 PreToolUse / PostToolUse 两个生命周期事件。
 * 钩子可以：
 *   - PreToolUse: 阻止工具执行（返回非零退出码）
 *   - PostToolUse: 注入附加信息到工具结果
 * 
 * 配置在 settings.json 的 "hooks" 字段中：
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "pattern": "run_shell_command", "command": "echo 'About to run shell'" }
 *     ],
 *     "PostToolUse": [
 *       { "pattern": "write_file", "command": "npx prettier --write $TOOL_ARGS_FILE_PATH" }
 *     ]
 *   }
 * }
 * 
 * 与 Python hooks.py 对应
 */

import { spawnSync } from "child_process";

export type HookEvent = "PreToolUse" | "PostToolUse";

export interface HookConfig {
  /** 匹配工具名称的 glob 模式（如 "run_shell_command" 或 "write_*"） */
  pattern: string;
  /** 要执行的 shell 命令 */
  command: string;
  /** 超时（秒），默认 30 */
  timeout?: number;
}

export interface HookContext {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  workDir: string;
}

export interface HookResult {
  /** PreToolUse: 是否阻止工具执行 */
  block: boolean;
  /** 阻止/注入时的消息 */
  message: string;
  /** PostToolUse: 附加到结果末尾的内容 */
  append?: string;
}

export class HookManager {
  private hooks: Record<HookEvent, HookConfig[]> = {
    PreToolUse: [],
    PostToolUse: [],
  };
  private enabled = true;

  /** 从 settings 配置加载钩子 */
  loadFromConfig(config: unknown): void {
    if (!config || typeof config !== "object") return;
    const cfg = config as Record<string, unknown>;
    const hooksCfg = cfg["hooks"];
    if (!hooksCfg || typeof hooksCfg !== "object") return;

    for (const event of ["PreToolUse", "PostToolUse"] as HookEvent[]) {
      const list = (hooksCfg as Record<string, unknown>)[event];
      if (!Array.isArray(list)) continue;
      this.hooks[event] = list
        .filter((h: unknown) => {
          if (typeof h !== "object" || h === null) return false;
          const hc = h as Record<string, unknown>;
          return typeof hc["pattern"] === "string" && typeof hc["command"] === "string";
        })
        .map((h: unknown) => {
          const hc = h as Record<string, unknown>;
          return {
            pattern: String(hc["pattern"]),
            command: String(hc["command"]),
            timeout: typeof hc["timeout"] === "number" ? Number(hc["timeout"]) : 30,
          };
        });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 匹配工具名称与 glob 模式 */
  private matchPattern(pattern: string, toolName: string): boolean {
    if (pattern === "*") return true;
    // 支持 * 通配符
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return regex.test(toolName);
  }

  /** 构建环境变量供钩子命令使用 */
  private buildEnv(ctx: HookContext): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    env["TOOL_NAME"] = ctx.toolName;
    env["TOOL_WORKDIR"] = ctx.workDir;
    // 序列化 args 中的关键字段
    for (const [k, v] of Object.entries(ctx.args)) {
      if (k === "workDir" || k === "work_dir") continue;
      const envKey = "TOOL_ARG_" + k.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      env[envKey] = typeof v === "string" ? v : String(v ?? "");
    }
    if (ctx.result !== undefined) {
      env["TOOL_RESULT"] = ctx.result.slice(0, 4096);
    }
    return env;
  }

  /** 执行 shell 命令（跨平台） */
  private execHook(command: string, ctx: HookContext, timeout: number): { status: number | null; stdout: string; stderr: string } {
    const isWin = process.platform === "win32";
    const env = this.buildEnv(ctx);
    if (isWin) {
      const result = spawnSync("cmd", ["/c", command], {
        cwd: ctx.workDir, timeout, encoding: "utf-8", env,
      });
      return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
    }
    const result = spawnSync("bash", ["-c", command], {
      cwd: ctx.workDir, timeout, encoding: "utf-8", env,
    });
    return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
  }

  /** 执行 PreToolUse 钩子（合并执行：所有匹配的钩子都触发） */
  async runPreToolUse(ctx: HookContext): Promise<HookResult> {
    if (!this.enabled) return { block: false, message: "" };

    let block = false;
    let message = "";
    const appends: string[] = [];

    for (const hook of this.hooks.PreToolUse) {
      if (!this.matchPattern(hook.pattern, ctx.toolName)) continue;
      try {
        const timeout = (hook.timeout || 30) * 1000;
        // 日志输出（stderr 不干扰 readline）
        process.stderr.write(`  \x1b[90m[Hook] PreToolUse ${hook.pattern} → ${hook.command.slice(0, 60)}\x1b[0m\n`);
        const { status, stdout, stderr: err } = this.execHook(hook.command, ctx, timeout);

        if (status !== 0) {
          // 非零退出码 → 阻止执行，停止后续钩子
          block = true;
          message = `[Hook 拦截] "${hook.pattern}" 阻止了 ${ctx.toolName}${err ? `: ${err}` : ""}`;
          break;
        }
        // stdout 非空 → 累积为附加提示
        if (stdout) {
          appends.push(`[Hook 提示] ${stdout}`);
        }
      } catch (e) {
        appends.push(`[Hook 警告] 钩子执行失败: ${e}`);
      }
    }
    return { block, message, append: appends.join("\n") };
  }

  /** 执行 PostToolUse 钩子（合并执行：所有匹配的钩子都触发） */
  async runPostToolUse(ctx: HookContext): Promise<HookResult> {
    if (!this.enabled) return { block: false, message: "" };

    const appends: string[] = [];

    for (const hook of this.hooks.PostToolUse) {
      if (!this.matchPattern(hook.pattern, ctx.toolName)) continue;
      try {
        const timeout = (hook.timeout || 30) * 1000;
        process.stderr.write(`  \x1b[90m[Hook] PostToolUse ${hook.pattern} → ${hook.command.slice(0, 60)}\x1b[0m\n`);
        const { status, stdout, stderr: err } = this.execHook(hook.command, ctx, timeout);

        if (stdout) {
          appends.push(`[Hook 后处理] ${stdout}`);
        }
        if (err && status !== 0) {
          appends.push(`[Hook 后处理警告] ${err}`);
        }
      } catch (e) {
        appends.push(`[Hook 后处理警告] 钩子执行失败: ${e}`);
      }
    }
    return { block: false, message: "", append: appends.join("\n") };
  }

  /** 获取已注册钩子数量 */
  get count(): number {
    return this.hooks.PreToolUse.length + this.hooks.PostToolUse.length;
  }
}
