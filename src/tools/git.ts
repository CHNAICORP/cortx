/**
 * Git 专用工具 — 封装常用 Git 操作
 * 
 * 相比 run_shell_command，这些工具：
 *   - 经过更细粒度的权限审计
 *   - 自动处理 Git 输出格式
 *   - 提供结构化返回
 */
import * as path from "path";
import { spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

function gitExec(workDir: string, args: string[], timeout = 30000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: workDir,
      timeout,
      encoding: "utf-8",
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

function isGitRepo(workDir: string): boolean {
  const r = gitExec(workDir, ["rev-parse", "--is-inside-work-tree"], 5000);
  return r.ok && r.stdout === "true";
}

// ── git_status ──
registry.register(
  "查看 Git 工作区状态。显示已修改、已暂存、未跟踪的文件。\n用法: git_status()",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function git_status(workDir: string): string {
    if (!isGitRepo(workDir)) return "(x) 当前目录不是 Git 仓库";
    const r = gitExec(workDir, ["status", "--porcelain=v1", "--branch"]);
    if (!r.ok) return `(x) git status 失败: ${r.stderr}`;
    if (!r.stdout) return "工作区干净 (无变更)";
    const lines = r.stdout.split("\n");
    const branchLine = lines.find(l => l.startsWith("##")) || "";
    const changes = lines.filter(l => !l.startsWith("##"));
    let result = "";
    if (branchLine) result += `分支: ${branchLine.slice(3)}\n\n`;
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    for (const line of changes) {
      const code = line.slice(0, 2);
      const file = line.slice(3);
      if (code[0] === "?" && code[1] === "?") untracked.push(file);
      else if (code[0] !== " " && code[0] !== "?") staged.push(file);
      else if (code[1] !== " ") unstaged.push(file);
    }
    if (staged.length) result += `已暂存:\n${staged.map(f => `  + ${f}`).join("\n")}\n`;
    if (unstaged.length) result += `已修改:\n${unstaged.map(f => `  ~ ${f}`).join("\n")}\n`;
    if (untracked.length) result += `未跟踪:\n${untracked.map(f => `  ? ${f}`).join("\n")}\n`;
    return result.trim() || "工作区干净";
  },
);

// ── git_diff ──
registry.register(
  "查看 Git 差异。可查看已暂存或未暂存的变更。\n"
  + "staged=true 查看已暂存的变更，staged=false 查看未暂存的变更。\n"
  + "用法: git_diff(staged=true)\n      git_diff(staged=false, filePath=\"src/main.ts\")",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", staged: "boolean", filePath: "string" },
  function git_diff(workDir: string, args: Record<string, unknown>): string {
    if (!isGitRepo(workDir)) return "(x) 当前目录不是 Git 仓库";
    const staged = args["staged"] !== false;
    const filePath = String(args["filePath"] || "");
    const gitArgs = ["diff"];
    if (staged) gitArgs.push("--cached");
    if (filePath) gitArgs.push("--", filePath);
    const r = gitExec(workDir, gitArgs);
    if (!r.ok) return `(x) git diff 失败: ${r.stderr}`;
    if (!r.stdout) return staged ? "(无已暂存的变更)" : "(无未暂存的变更)";
    return r.stdout;
  },
);

// ── git_commit ──
registry.register(
  "暂存文件并创建 Git 提交。\n"
  + "filePath 可以是具体文件、通配符或 \".\"（全部）。\n"
  + "用法: git_commit(filePath=\".\", message=\"修复登录页面样式\")",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filePath: "string", message: "string" },
  function git_commit(workDir: string, args: Record<string, unknown>): string {
    if (!isGitRepo(workDir)) return "(x) 当前目录不是 Git 仓库";
    const filePath = String(args["filePath"] || ".");
    const message = String(args["message"] || "");
    if (!message.trim()) return "(x) 提交消息不能为空";
    // 先 add
    const addR = gitExec(workDir, ["add", filePath], 10000);
    if (!addR.ok) return `(x) git add 失败: ${addR.stderr}`;
    // 再 commit
    const commitR = gitExec(workDir, ["commit", "-m", message], 15000);
    if (!commitR.ok) {
      if (commitR.stderr.includes("nothing to commit")) return "无变更可提交 (工作区已是最新)";
      return `(x) git commit 失败: ${commitR.stderr}`;
    }
    // 获取简短 commit hash
    const hashR = gitExec(workDir, ["rev-parse", "--short", "HEAD"], 5000);
    const hash = hashR.ok ? hashR.stdout : "?";
    return `已提交 ${hash}: ${message}\n${commitR.stdout}`;
  },
);

// ── git_branch ──
registry.register(
  "管理 Git 分支。\n"
  + "action=\"list\" 列出所有分支\n"
  + "action=\"create\" 创建新分支 (需 branchName)\n"
  + "action=\"switch\" 切换分支 (需 branchName)\n"
  + "action=\"delete\" 删除分支 (需 branchName)\n"
  + "用法: git_branch(action=\"create\", branchName=\"feature/auth\")",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", action: "string", branchName: "string" },
  function git_branch(workDir: string, args: Record<string, unknown>): string {
    if (!isGitRepo(workDir)) return "(x) 当前目录不是 Git 仓库";
    const action = String(args["action"] || "list");
    const branchName = String(args["branchName"] || "");
    if (action === "list") {
      const r = gitExec(workDir, ["branch", "-a", "--format=%(refname:short) %(objectname:short) %(committerdate:relative)"]);
      if (!r.ok) return `(x) git branch 失败: ${r.stderr}`;
      if (!r.stdout) return "(无分支)";
      return `分支列表:\n${r.stdout.split("\n").map(l => `  ${l}`).join("\n")}`;
    }
    if (!branchName.trim()) return `(x) 需要 branchName 参数`;
    if (action === "create") {
      const r = gitExec(workDir, ["checkout", "-b", branchName], 10000);
      if (!r.ok) return `(x) 创建分支失败: ${r.stderr}`;
      return `已创建并切换到分支: ${branchName}`;
    }
    if (action === "switch") {
      const r = gitExec(workDir, ["checkout", branchName], 10000);
      if (!r.ok) return `(x) 切换分支失败: ${r.stderr}`;
      return `已切换到分支: ${branchName}`;
    }
    if (action === "delete") {
      const r = gitExec(workDir, ["branch", "-d", branchName], 10000);
      if (!r.ok) return `(x) 删除分支失败: ${r.stderr}`;
      return `已删除分支: ${branchName}`;
    }
    return `(x) 未知操作: ${action}\n可用: list, create, switch, delete`;
  },
);

// ── git_log ──
registry.register(
  "查看 Git 提交历史。\nlimit 指定显示条数（默认 10）。\n用法: git_log(limit=20)",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", limit: "number" },
  function git_log(workDir: string, args: Record<string, unknown>): string {
    if (!isGitRepo(workDir)) return "(x) 当前目录不是 Git 仓库";
    const limit = Number(args["limit"] || 10);
    const r = gitExec(workDir, [
      "log", `--max-count=${limit}`,
      "--format=%h %ad %an  %s",
      "--date=short",
    ]);
    if (!r.ok) return `(x) git log 失败: ${r.stderr}`;
    if (!r.stdout) return "(无提交历史)";
    return `提交历史 (最近 ${limit} 条):\n${r.stdout.split("\n").map(l => `  ${l}`).join("\n")}`;
  },
);
