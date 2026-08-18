/**
 * 子代理工具 — 分离子任务到独立 Agent 实例
 *
 * 参考智谱 Coding Agent Subagents 设计：
 *   - 上下文隔离：子代理拥有独立上下文，返回结果摘要，不污染主对话
 *   - 工具过滤：可限制子代理只使用特定工具
 *   - 技能预加载：子代理启动前可预加载技能指引
 *   - 并行执行：spawn_subagents 支持同时派遣多个子代理（fan-out）
 *
 * 与 Python tools.py 中的 spawn_subagent / spawn_subagents 对齐
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { getToolContext } from '../core/tool_context.js';

/** 截断过长的子代理结果 */
function truncateResult(result: string, maxLen = 5000): string {
  if (result.length <= maxLen) return result;
  const head = result.slice(0, Math.floor(maxLen * 0.7));
  const tail = result.slice(-Math.floor(maxLen * 0.3));
  return `${head}\n\n[...子代理结果已截断...]\n\n${tail}`;
}

registry.register(
  "生成子代理执行独立任务。子代理拥有独立的上下文和工具集，执行完毕后返回结果摘要。\n"
  + "适用于将复杂任务分解为子任务，避免污染主对话上下文。\n"
  + "参数:\n"
  + "  task   — 任务描述（必填）\n"
  + "  tools  — 限制子代理可用的工具，逗号分隔（如 'read_file,grep,glob'），留空则继承父代理\n"
  + "  skill  — 预加载技能名称（如 'code-review'），技能指引会注入子代理上下文\n"
  + "  model  — 模型别名覆盖（留空用父代理模型）\n"
  + "用法: spawn_subagent(task=\"审查 auth.py 的安全性\", tools=\"read_file,grep\", skill=\"code-review\")",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", task: "string", model: "string", tools: "string", skill: "string" },
  async function spawn_subagent(_wd: string, args: Record<string, unknown>): Promise<string> {
    const task = String(args["task"] || "");
    if (!task.trim()) return "(x) 请提供任务描述";
    const model = String(args["model"] || "");
    const tools = String(args["tools"] || "");
    const skill = String(args["skill"] || "");
    const ctx = getToolContext();
    if (!ctx.spawnSubagent) {
      return "(x) 子代理系统不可用 — 请在 Agent 模式下使用";
    }
    try {
      const result = await ctx.spawnSubagent(
        task, model || undefined, tools || undefined, skill || undefined,
      );
      if (!result.trim()) return "(子代理未返回结果)";
      return truncateResult(result);
    } catch (e) {
      return `(x) 子代理执行失败: ${e}`;
    }
  },
);

registry.register(
  "并行派遣多个子代理执行独立任务（fan-out 模式）。所有子代理同时运行，互不干扰。\n"
  + "适用于大规模代码分析、多维度审查（安全/性能/测试分别由不同子代理检查）等场景。\n\n"
  + "tasks_json 是一个 JSON 数组字符串，每个元素是一个任务对象:\n"
  + '  [{"task":"审查安全性","tools":"read_file,grep","skill":"code-review"},\n'
  + '   {"task":"检查测试覆盖率","tools":"read_file,grep,glob"},\n'
  + '   {"task":"审查代码风格","tools":"read_file"}]\n\n'
  + "每个任务对象支持: task(必填), tools(可选), skill(可选), model(可选)\n"
  + "用法: spawn_subagents(tasks_json='[{\"task\":\"分析模块A\"},{\"task\":\"分析模块B\"}]')",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", tasks_json: "string" },
  async function spawn_subagents(_wd: string, args: Record<string, unknown>): Promise<string> {
    const tasksJson = String(args["tasks_json"] || "");
    if (!tasksJson.trim()) return "(x) 请提供 tasks_json 参数（JSON 数组）";
    const ctx = getToolContext();
    if (!ctx.spawnSubagents) {
      return "(x) 并行子代理系统不可用 — 请在 Agent 模式下使用";
    }
    try {
      return await ctx.spawnSubagents(tasksJson);
    } catch (e) {
      return `(x) 并行子代理执行失败: ${e}`;
    }
  },
);
