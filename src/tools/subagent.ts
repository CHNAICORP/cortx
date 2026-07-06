/**
 * 子代理工具 — 分离子任务到独立 Agent 实例
 * 
 * 子代理拥有：
 *   - 独立的上下文（不共享父代理的对话历史）
 *   - 共享的工具、策略引擎、钩子
 *   - 限制的步数（防止无限循环）
 *   - 共享的工作目录和文件系统
 * 
 * 用途：将复杂任务分解为子任务并行处理
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { getToolContext } from '../core/tool_context.js';

registry.register(
  "生成子代理执行独立任务。子代理拥有独立的上下文和工具集，执行完毕后返回结果。\n"
  + "适用于将复杂任务分解为子任务，避免污染主对话上下文。\n"
  + "用法: spawn_subagent(task=\"搜索所有 API 端点并生成文档\")",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", task: "string", model: "string" },
  async function spawn_subagent(_wd: string, args: Record<string, unknown>): Promise<string> {
    const task = String(args["task"] || "");
    if (!task.trim()) return "(x) 请提供任务描述";
    const model = String(args["model"] || "");
    const ctx = getToolContext();
    if (!ctx.spawnSubagent) {
      return "(x) 子代理系统不可用 — 请在 Agent 模式下使用";
    }
    try {
      const result = await ctx.spawnSubagent(task, model || undefined);
      if (!result.trim()) return "(子代理未返回结果)";
      // 截断过长的结果
      const maxLen = 5000;
      if (result.length > maxLen) {
        const head = result.slice(0, Math.floor(maxLen * 0.7));
        const tail = result.slice(-Math.floor(maxLen * 0.3));
        return `${head}\n\n[...子代理结果已截断...]\n\n${tail}`;
      }
      return result;
    } catch (e) {
      return `(x) 子代理执行失败: ${e}`;
    }
  },
);
