/**
 * Tool Context — 全局工具上下文
 *
 * 允许工具函数访问 Agent 级别的功能（如用户交互、子代理生成），
 * 而不需要修改 ToolFn 签名。
 *
 * 与 Python tool_context.py 对应
 */

import type { SkillManager } from './skills.js';

export interface ToolContext {
  /** 弹出 AskUserPanel 询问面板并收集回答（非交互模式返回标记文本） */
  askUserPanel?: (questionsJson: string) => string | Promise<string>;
  /** 生成单个子代理执行独立任务（支持工具过滤 + 技能预加载） */
  spawnSubagent?: (task: string, model?: string, tools?: string, skill?: string) => Promise<string>;
  /** 并行派遣多个子代理（fan-out），tasks_json 为 JSON 数组字符串 */
  spawnSubagents?: (tasksJson: string) => Promise<string>;
  /** 当前工作目录 */
  workDir?: string;
  /** 是否为非交互模式（管道/CI） */
  nonInteractive?: boolean;
  /** 当前 Agent 配置（只读引用） */
  agentConfig?: Record<string, unknown>;
  /** 技能管理器（供 list_skills / use_skill 工具使用） */
  skillManager?: SkillManager;
}

const _ctx: ToolContext = {};

export function setToolContext(ctx: Partial<ToolContext>): void {
  Object.assign(_ctx, ctx);
}

export function getToolContext(): ToolContext {
  return _ctx;
}

export function clearToolContext(): void {
  for (const k of Object.keys(_ctx)) {
    delete (_ctx as Record<string, unknown>)[k];
  }
}
