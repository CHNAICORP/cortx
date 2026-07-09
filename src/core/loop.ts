/**
 * Cortex Agent — Agentic Loop 引擎
 * 与 Python cortex_agent.py 完全对应: Think → Guard → Act → Reflect
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import {
  AgentConfig, DEFAULT_CONFIG, Capability, AuditVerdict,
  Message, RunTrace, StepRecord, CacheStats,
} from './types.js';
import { registry } from './registry.js';
import { PolicyEngine } from './policy.js';
import { LLMProvider, ParsedToolCall, resolveCapabilities } from './llm.js';
export { LLMProvider } from './llm.js';
import { MemoryStore, SessionStore } from './memory_store.js';
import { SkillManager } from './skills.js';
import { HookManager } from './hooks.js';
import { setToolContext, clearToolContext, getToolContext } from './tool_context.js';
export { HookManager } from './hooks.js';
export { setToolContext, getToolContext } from './tool_context.js';

// ── 默认系统提示 ──
const DEFAULT_SYSTEM = [
  "你是 Cortex Agent，一个具备工具调用能力的 AI 助手，专为企业级大型项目连续开发而设计。",
  "",
  "== 最高优先级规则：判断是否需要工具 ==",
  "在收到用户输入后，你首先必须判断：这个请求是否需要调用工具？",
  "",
  "  【不需要工具 → 直接回复】以下情况，不要调用任何工具，直接用文字回复用户：",
  "  - 问候、闲聊（如「你好」「谢谢」「你是谁」）",
  "  - 你已具备知识可以直接回答的问题（如「Python 怎么读文件」「HTTP 状态码 404 是什么意思」）",
  "  - 对之前工作的简单询问（如「你刚才做了什么」「总结一下进度」）",
  "",
  "  【需要工具 → 进入工作循环】以下情况，使用工具完成任务：",
  "  - 需要读取/写入/修改文件",
  "  - 需要执行 shell 命令",
  "  - 需要搜索网络获取实时信息",
  "  - 需要操作浏览器、数据库等外部系统",
  "",
  "  ⚠ 重要：用户没有明确要求「继续之前的任务」时，不要因为上下文中有历史操作记录就自行继续旧任务。",
  "  每次用户输入都是一个新的请求，请根据当前输入的内容判断意图。",
  "",
  "== 核心工作循环（需要工具时遵守）==",
  "当用户的请求需要使用工具时，你必须遵循以下循环：",
  "",
  "  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐",
  "  │  思考    │ →  │  调用工具 │ →  │  反思    │ →  │  继续/完成 │",
  "  │ (Think)  │     │  (Act)   │     │(Reflect) │     │(Loop/Done)│",
  "  └─────────┘     └─────────┘     └─────────┘     └─────────┘",
  "",
  "**第一步：思考（必须）**",
  "  在调用任何工具之前，你必须先思考：",
  "  - 用户想要什么？当前任务的目标是什么？",
  "  - 我已经知道什么？还缺少什么信息？",
  "  - 下一步应该做什么？为什么选择这个方案？",
  "  - 不要跳过思考直接调用工具。先想清楚再行动。",
  "",
  "**第二步：调用工具**",
  "  经过思考后，如果需要使用工具来完成当前步骤：",
  "  - 调用最合适的工具（优先专用工具，如 edit_file 而非 shell）",
  "  - 每次只调用当前步骤需要的工具，不要一次调用过多工具",
  "",
  "**第三步：反思（必须）**",
  "  拿到工具返回结果后，你必须反思：",
  "  - 工具执行成功了吗？结果是否符合预期？",
  "  - 当前任务完成了吗？还有哪些步骤没做？",
  "  - 如果有错误，根因是什么？如何修复？",
  "  - 如果任务完成，直接给出最终回答（不再调用工具）",
  "  - 如果任务未完成，继续下一轮思考→调用→反思",
  "",
  "**第四步：完成判断**",
  "  当所有步骤都完成后，给出清晰的最终回答。",
  "  不要在任务完成后继续调用不必要的工具。",
  "  最终回答应该总结你完成的工作和关键结果。",
  "",
  "== 安全边界 ==",
  "1. 不得执行可能危害系统安全、泄露数据或破坏系统完整性的操作。",
  "2. 不得修改系统配置或系统服务文件（如 C:\\Windows, /etc 等）。",
  "3. 不得将文件内容通过外部网络发送。",
  "4. 不得读取系统敏感文件。",
  "5. 不得使用编码命令或混淆方式执行 shell。",
  "6. 文件操作可以在用户目录范围内自由进行（桌面、文档、工作目录等）。",
  "",
  "== 企业级大项目工程指引 ==",
  "你具备连续长时间工作的能力，可以完成 10 万行以上代码的大型项目。遵循以下原则：",
  "1. **任务分解**：复杂任务先用 write_file 创建 TASKS.md，分解为里程碑和子任务。",
  "2. **渐进式开发**：按依赖顺序逐个模块完成。每完成一个子任务更新 TASKS.md 标记 [x]。",
  "3. **即时验证**：写完代码文件后立即运行编译或语法检查，发现错误立即修复。",
  "4. **问题感知与自修复**：当工具返回错误时，仔细阅读错误信息，定位根因，使用 edit_file 修复后重新验证。",
  "5. **上下文管理**：当上下文被压缩时，通过读取 TASKS.md 和已有代码文件恢复进度感知。",
  "6. **最终验证**：所有模块完成后运行完整构建和测试，确保零错误。",
  "",
  "== 服务器启动与验证指引 ==",
  "当需要启动开发服务器（Flask/Django/Express/Vite 等）进行端到端验证时：",
  "  1. **使用 run_background_command** 在后台启动服务器，不要用 run_shell_command（会被阻塞检测拦截）",
  "  2. **等待 2-3 秒** 让服务器完成启动（可以先做其他操作）",
  "  3. **使用 check_server_status** 发送 HTTP 请求验证服务是否正常响应",
  "  4. **验证完成后** 使用 stop_background_process 停止后台进程",
  "  示例流程：",
  "    run_background_command(command='python app.py')  → 返回 PID",
  "    check_server_status(url='http://localhost:5000/api/health')  → 验证服务",
  "    stop_background_process(pid=12345)  → 清理进程",
  "",
  "联网搜索或查询实时信息前，先调用 get_current_time 获取当前时间以确保时效性。",
  "搜索时务必将获取到的具体年份和月份直接写入搜索关键词中。",
].join("\n");

// ── ContextGovernor ──
export class ContextGovernor {
  static TOKENS_PER_CHAR = 0.4;
  /** 工具结果压缩阈值（字符数） */
  static COMPRESS_THRESHOLD = 1500;
  static COMPRESS_HEAD = 600;
  static COMPRESS_TAIL = 400;
  /** 安全余量：预留给 tokenizer 估算误差 + tool schema 开销 */
  static SAFETY_MARGIN = 4096;
  /** 输入 token 预警线（占 maxInputTokens 的百分比） */
  static INPUT_WARN_PCT = 80;
  static INPUT_FORCE_PCT = 90;

  system: Message;
  maxMsgs: number;
  contextLimit: number;
  maxTokens: number;
  maxInputTokens: number;
  // 可调参数实例字段
  compressThreshold: number;
  compressHead: number;
  compressTail: number;
  safetyMargin: number;
  inputWarnPct: number;
  inputForcePct: number;

  constructor(opts: {
    system?: string; workDir?: string; maxMsgs?: number;
    memoryContext?: string; historySummary?: string;
    kbContext?: string; contextLimit?: number;
    maxInputTokens?: number; maxTokens?: number;
    compressThreshold?: number; compressHead?: number; compressTail?: number;
    safetyMargin?: number; inputWarnPct?: number; inputForcePct?: number;
  }) {
    const parts: string[] = [opts.system || DEFAULT_SYSTEM];
    if (opts.kbContext) parts.push(`\n[项目知识库]\n${opts.kbContext}`);
    if (opts.memoryContext) parts.push(`\n${opts.memoryContext}`);
    if (opts.historySummary) parts.push(`\n${opts.historySummary}`);
    if (opts.workDir) parts.push(`\n工作目录: ${opts.workDir}`);
    this.system = { role: "system", content: parts.join("\n") };
    this.maxMsgs = opts.maxMsgs || 24;
    this.contextLimit = opts.contextLimit || 1_000_000;
    this.maxTokens = opts.maxTokens || 16384;
    // 可调参数：使用传入值或回退到类常量默认值
    this.compressThreshold = opts.compressThreshold || ContextGovernor.COMPRESS_THRESHOLD;
    this.compressHead = opts.compressHead || ContextGovernor.COMPRESS_HEAD;
    this.compressTail = opts.compressTail || ContextGovernor.COMPRESS_TAIL;
    this.safetyMargin = opts.safetyMargin || ContextGovernor.SAFETY_MARGIN;
    this.inputWarnPct = opts.inputWarnPct || ContextGovernor.INPUT_WARN_PCT;
    this.inputForcePct = opts.inputForcePct || ContextGovernor.INPUT_FORCE_PCT;
    // maxInputTokens: 0 = 自动计算 (contextLimit - maxTokens - SAFETY_MARGIN)
    if (opts.maxInputTokens && opts.maxInputTokens > 0) {
      this.maxInputTokens = opts.maxInputTokens;
    } else {
      this.maxInputTokens = Math.max(this.contextLimit - this.maxTokens - this.safetyMargin, 16000);
    }
  }

  /** 压缩超长工具结果：保留首尾，中间用省略标记替代。 */
  static compressResult(text: string, self?: ContextGovernor): string {
    const threshold = self?.compressThreshold || ContextGovernor.COMPRESS_THRESHOLD;
    const headLen = self?.compressHead || ContextGovernor.COMPRESS_HEAD;
    const tailLen = self?.compressTail || ContextGovernor.COMPRESS_TAIL;
    if (text.length <= threshold) return text;
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    const omitted = text.length - headLen - tailLen;
    return `${head}\n\n[...已压缩，省略 ${omitted} 字符...]\n\n${tail}`;
  }

  /** 实例方法版本，使用实例的可调参数。 */
  compressResult(text: string): string {
    return ContextGovernor.compressResult(text, this);
  }

  static estimateTokens(msgs: Message[]): number {
    let total = 0;
    for (const m of msgs) {
      let content = m.content || "";
      if (m.tool_calls) {
        content += JSON.stringify(m.tool_calls.map(tc => tc.function));
      }
      if (typeof content === "string") {
        total += Math.floor(content.length * ContextGovernor.TOKENS_PER_CHAR);
      }
    }
    return Math.max(total, 1);
  }

  static contextPct(msgs: Message[], limit: number): number {
    if (limit <= 0) return 0;
    const est = ContextGovernor.estimateTokens(msgs);
    return Math.min(Math.floor(est / limit * 100), 100);
  }

  /** 当前输入 token 占 maxInputTokens 的百分比。 */
  inputTokensPct(msgs: Message[]): number {
    if (this.maxInputTokens <= 0) return 0;
    const est = ContextGovernor.estimateTokens(msgs);
    return Math.min(Math.floor(est / this.maxInputTokens * 100), 100);
  }

  /** 上下文压缩 — 将旧消息摘要为单条 system 消息，保留最近 N 条。 */
  compact(msgs: Message[], keepRecent = 10): Message[] {
    if (msgs.length <= keepRecent + 1) return msgs;
    const system = msgs[0]?.role === "system" ? msgs[0] : null;
    const recent = msgs.slice(-keepRecent);
    const old = system ? msgs.slice(1, -keepRecent) : msgs.slice(0, -keepRecent);

    const summaryParts: string[] = [];
    const toolCallsSeen: string[] = [];
    const filesTouched = new Set<string>();
    for (const m of old) {
      if (m.role === "user") {
        const content = (m.content || "").slice(0, 120);
        if (content.trim()) summaryParts.push(`用户请求: ${content}`);
      } else if (m.role === "assistant") {
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            toolCallsSeen.push(tc.function.name);
            try {
              const args = JSON.parse(tc.function.arguments);
              for (const v of Object.values(args)) {
                if (typeof v === "string" && (v.includes("/") || v.includes("\\") || /\.(py|ts|js|html|css|json|md)$/.test(v))) {
                  filesTouched.add(v.slice(0, 80));
                }
              }
            } catch { /* ignore */ }
          }
        }
        const content = (m.content || "").slice(0, 80);
        if (content.trim()) summaryParts.push(`Agent: ${content}`);
      } else if (m.role === "tool") {
        const content = m.content || "";
        if (content.length > 100) {
          summaryParts.push(`  → 结果(${content.length}字符): ${content.slice(0, 80)}...`);
        }
      }
    }

    let compactText = `[上下文压缩 — ${old.length}条消息已摘要]\n`;
    if (toolCallsSeen.length > 0) {
      const freq: Record<string, number> = {};
      for (const t of toolCallsSeen) freq[t] = (freq[t] || 0) + 1;
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
      compactText += `工具调用: ${sorted.map(([n, c]) => `${n}×${c}`).join(", ")}\n`;
    }
    if (filesTouched.size > 0) {
      compactText += `涉及文件: ${Array.from(filesTouched).slice(0, 10).join(", ")}\n`;
    }
    if (summaryParts.length > 0) {
      let body = summaryParts.slice(-20).join("\n");
      if (body.length > 2000) body = body.slice(0, 2000) + "...";
      compactText += `对话摘要:\n${body}\n`;
    }

    const result: Message[] = [];
    if (system) result.push(system);
    result.push({ role: "system", content: compactText });
    result.push(...recent);
    return ContextGovernor._fixToolPairing(result);
  }

  static loadKb(projectDir: string): string {
    const kbPath = path.join(projectDir, "CORTEX.md");
    if (fs.existsSync(kbPath)) {
      try { return fs.readFileSync(kbPath, "utf-8"); } catch { /* ignore */ }
    }
    return "";
  }

  init(query: string): Message[] {
    return [this.system, { role: "user", content: query }];
  }

  appendUser(ctx: Message[], query: string): Message[] {
    ctx.push({ role: "user", content: query });
    return ctx;
  }

  /**
   * 三重裁剪：条数裁剪 + tool result 压缩 + 输入 token 体积管控。
   *
   * 裁剪策略（与 Python 对齐）:
   *   1. 按条数裁剪到 maxMsgs，保留最近一轮 tool_call+result 配对
   *   2. 遍历保留的消息，对超长 tool result 执行首尾压缩
   *   3. 输入 token 三级预警:
   *      ≥80% maxInputTokens → 压缩所有 tool result
   *      ≥90% maxInputTokens → 丢弃最早的非 system 消息
   *      ≥100% maxInputTokens → 只保留 system + 最近 3 条
   */
  govern(msgs: Message[]): Message[] {
    // Step 1: 条数裁剪
    let result: Message[];
    if (msgs.length <= this.maxMsgs) {
      result = [...msgs];
    } else {
      let limit = this.maxMsgs - 1;
      let reserve = new Set<number>();
      let hasPair = false;
      for (let i = msgs.length - 1; i > 1; i--) {
        if (msgs[i].role === "tool" && msgs[i - 1].tool_calls) {
          reserve = new Set([i - 1, i]);
          hasPair = true;
          limit -= 2;
          break;
        }
      }
      const kept: Message[] = [];
      for (let i = msgs.length - 1; i > 0 && kept.length < Math.max(limit, 0); i--) {
        if (reserve.has(i)) continue;
        kept.unshift(msgs[i]);
      }
      if (hasPair) {
        const sorted = [...reserve].sort((a, b) => a - b);
        kept.push(msgs[sorted[0]]);
        kept.push(msgs[sorted[1]]);
      }
      const trimmed = msgs.length - 1 - kept.length;
      if (trimmed > 0) {
        kept.unshift({ role: "system", content: `[${trimmed}条历史已压缩]` });
        while (kept.length > this.maxMsgs - 1) kept.splice(1, 1);
      }
      if (kept.length === 0) kept.push(msgs[msgs.length - 1]);
      result = [msgs[0], ...kept];
    }

    // Step 2: 压缩超长 tool result
    for (const m of result) {
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > this.compressThreshold) {
        m.content = this.compressResult(m.content);
      }
    }

    // Step 3: 输入 token 体积管控（三级预警）
    const inputTokens = ContextGovernor.estimateTokens(result);
    const warnThreshold = Math.floor(this.maxInputTokens * this.inputWarnPct / 100);
    const forceThreshold = Math.floor(this.maxInputTokens * this.inputForcePct / 100);

    if (inputTokens >= this.maxInputTokens) {
      // HARD: 只保留 system + 最近 3 条
      if (result.length > 4) {
        result = [result[0], ...result.slice(-3)];
      }
    } else if (inputTokens >= forceThreshold) {
      // FORCE: 逐步丢弃最早的非 system 消息
      while (result.length > 4 && ContextGovernor.estimateTokens(result) >= forceThreshold) {
        result.splice(1, 1);
      }
      result.splice(1, 0, { role: "system", content: "[上下文压力过高，已强制裁剪历史]" });
    } else if (inputTokens >= warnThreshold) {
      // WARN: 强制压缩所有 tool result（包括未超阈值的）
      for (const m of result) {
        if (m.role === "tool" && typeof m.content === "string" && m.content.length > 200) {
          m.content = this.compressResult(m.content);
        }
      }
    }

    // Step 4: 修复 tool_calls/tool 配对完整性
    result = ContextGovernor._fixToolPairing(result);

    return result;
  }

  /** 修复 tool_calls/tool 配对完整性 — 裁剪可能打破配对关系导致 API 报错。 */
  static _fixToolPairing(msgs: Message[]): Message[] {
    if (msgs.length === 0) return msgs;
    const fixed: Message[] = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        // 收集这个 assistant 消息之后所有连续的 tool 结果
        const tcIds = new Set(m.tool_calls.map(tc => tc.id));
        const toolResults: Message[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") {
          toolResults.push(msgs[j]);
          j++;
        }
        // 只保留 tool_call_id 在 tcIds 中的 tool 结果（过滤孤立结果）
        const matchedResults = toolResults.filter(tr => tr.tool_call_id && tcIds.has(tr.tool_call_id));
        const matchedIds = new Set(matchedResults.map(tr => tr.tool_call_id));
        if (matchedIds.size > 0) {
          // 只保留有结果的 tool_calls
          const keptTcs = m.tool_calls.filter(tc => matchedIds.has(tc.id));
          const newM: Message = { ...m, tool_calls: keptTcs };
          fixed.push(newM);
          fixed.push(...matchedResults);
        } else {
          // 没有任何匹配的 tool 结果 → 移除 tool_calls，保留 content
          const { tool_calls, ...rest } = m;
          if (rest.content) fixed.push(rest);
        }
        i = j;
      } else if (m.role === "tool") {
        // 孤立的 tool 消息（前面没有带 tool_calls 的 assistant）→ 跳过
        i++;
      } else {
        fixed.push(m);
        i++;
      }
    }
    return fixed;
  }
}

// ── Observer ──
class Observer {
  traces: RunTrace[] = [];

  createTrace(query: string): RunTrace {
    const t: RunTrace = { query, steps: [], startTime: Date.now(), finalAnswer: "", stepLimitReached: false, error: "" };
    this.traces.push(t);
    return t;
  }

  record(trace: RunTrace, step: number, name: string, args: Record<string, unknown>,
    result: string, success: boolean, cap: string, latencyMs: number): void {
    trace.steps.push({
      step, timestamp: Date.now(), toolName: name, toolArgs: args,
      resultPreview: result.slice(0, 200), success,
      riskLevel: "", capability: cap, latencyMs,
    });
  }
}

// ── ToolExecutor ──
export class ToolExecutor {
  static MAX_RESULT_CHARS = 10000;
  private reg: typeof registry;
  private workDir: string;
  private timeout: number;
  maxResultChars: number;

  // snake_case → camelCase 别名映射，使 TS 端兼容 Python 风格的参数名
  // 注意: task_id 不在此映射中，因为 task_update 工具直接使用 args["task_id"]（snake_case）
  private static SNAKE_ALIASES: Record<string, string> = {
    "file_path": "filePath", "dir_path": "dirPath", "out_path": "outPath",
    "old_string": "oldString", "new_string": "newString",
    "file_a": "fileA", "file_b": "fileB", "glob_filter": "globFilter",
    "max_results": "maxResults", "max_chars": "maxChars",
    "allowed_domains": "allowedDomains", "blocked_domains": "blockedDomains",
    "branch_name": "branchName",
  };

  constructor(workDir: string, timeout = 10, maxResultChars = 0) {
    this.reg = registry;
    this.workDir = workDir;
    this.timeout = timeout;
    this.maxResultChars = maxResultChars > 0 ? maxResultChars : ToolExecutor.MAX_RESULT_CHARS;
  }

  execute(name: string, args: Record<string, unknown>): string | Promise<string> {
    const fn = this.reg.get(name);
    if (!fn) return `(x) 未知工具: ${name}`;
    try {
      // snake_case 别名归一化：接受 Python 风格参数名，转为工具的 camelCase
      const normArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        normArgs[ToolExecutor.SNAKE_ALIASES[k] || k] = v;
      }
      const result = fn(this.workDir, normArgs);
      if (result instanceof Promise) {
        return result.then(r => this.truncate(r));
      }
      return this.truncate(result);
    } catch (e) {
      return `(x) ${e}`;
    }
  }

  /**
   * 智能截断：保留首尾，中间省略（与 Python 对齐）。
   * head = 2/3, tail = 1/3
   */
  private truncate(result: string): string {
    if (result.length <= this.maxResultChars) return result;
    const head = Math.floor(this.maxResultChars * 2 / 3);
    const tail = Math.floor(this.maxResultChars / 3);
    const omitted = result.length - head - tail;
    return `${result.slice(0, head)}\n\n[...已截断，省略 ${omitted} 字符...]\n\n${result.slice(-tail)}`;
  }
}

// ════════════════════════════════════════════
// Cortex Agent
// ════════════════════════════════════════════

export class CortexAgent {
  config: AgentConfig;
  private policy: PolicyEngine;
  private executor: ToolExecutor;
  llm: LLMProvider;
  private governor!: ContextGovernor;
  private observer = new Observer();
  private ctx: Message[] = [];
  private trace: RunTrace | null = null;
  private lastLlmError = "";
  private rejectionCounts = new Map<Capability, number>();
  private suspendedCaps = new Set<Capability>();
  private permissionDecisions = new Map<string, boolean>();
  private sessionId: string | null = null;
  private queryCount = 0;
  private stepCountTotal = 0;
  private _memory: MemoryStore | null = null;
  private _sessions: SessionStore | null = null;
  private _skillMgr: SkillManager | null = null;
  private _hooks: HookManager = new HookManager();
  private _nonInteractive: boolean = false;
  private _allowedTools: Set<string> | null = null;
  private _disallowedTools: Set<string> | null = null;
  private term: {
    thinkToken: (t: string) => void;
    answerToken: (t: string) => void;
    toolStart: (n: string, a: Record<string, unknown>) => void;
    toolDone: (ok: boolean, ms: number, p: string) => void;
    closeThinking: () => void;
    nextRound: () => void;
    write: (s: string) => void;
    codeStream: (filePath: string, content: string) => Promise<void>;
    isAnswerShown: () => boolean;
    writeAnswer: (text: string) => void;
  } | null = null;

  setTerm(t: typeof this.term) { this.term = t; }

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    let wd = path.resolve(this.config.workDir);
    try {
      fs.mkdirSync(wd, { recursive: true });
    } catch {
      wd = path.resolve(os.homedir(), '.cortx', 'workspace');
      fs.mkdirSync(wd, { recursive: true });
      this.config.workDir = wd;
    }

    this.policy = new PolicyEngine(wd, { permissionMode: this.config.permissionMode });
    this.executor = new ToolExecutor(wd, this.config.toolTimeout, this.config.maxResultChars);

    // ── 记忆 + 会话存储 ──
    const memoryPath = this.config.memoryDir || path.join(wd, "memory.md");
    const sessionsDir = this.config.sessionsDir || path.join(wd, "sessions");
this._memory = this.config.memoryEnabled ? new MemoryStore(memoryPath) : null;
this._sessions = this.config.sessionsEnabled ? new SessionStore(sessionsDir) : null;
this._skillMgr = new SkillManager(this.config.workDir);

    // ── Model capabilities auto-resolve ──
    // contextLimit=0 或 maxTokens=0 时，从模型能力注册表自动解析
    const resolvedModel = LLMProvider.resolve(this.config.model);
    const caps = resolveCapabilities(resolvedModel);
    if (this.config.contextLimit === 0) this.config.contextLimit = caps.contextWindow;
    if (this.config.maxTokens === 0) this.config.maxTokens = caps.maxOutputTokens;

    this.llm = new LLMProvider({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      model: resolvedModel,
      tools: registry.schemaList,
      timeout: this.config.thinkTimeout,
      maxTokens: this.config.maxTokens,
    });
    this._makeGovernor();
    this._setupToolContext();
  }

  /** 设置工具上下文（供 ask_user, spawn_subagent 等工具使用） */
  private _setupToolContext(): void {
    setToolContext({
      workDir: this.config.workDir,
      nonInteractive: this._nonInteractive,
      agentConfig: this.config as unknown as Record<string, unknown>,
      askUser: async (question: string): Promise<string> => {
        if (this._nonInteractive || !this.term) {
          return `[非交互模式] ${question}`;
        }
        this.term.closeThinking();
        process.stdout.write(`\n  \x1b[36m💬 Agent 提问:\x1b[0m ${question}\n  \x1b[90m> \x1b[0m`);
        try {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ans = await new Promise<string>(resolve => rl.question('', resolve));
          rl.close();
          return ans.trim() || "(用户未输入)";
        } catch {
          return "(用户未响应)";
        }
      },
      spawnSubagent: async (task: string, model?: string): Promise<string> => {
        const subConfig: Partial<AgentConfig> = {
          ...this.config,
          model: model ? LLMProvider.resolve(model) : this.config.model,
          maxSteps: 20, // 子代理限制步数
          maxRounds: 1,  // 子代理不续行
        };
        const subAgent = new CortexAgent(subConfig);
        subAgent._nonInteractive = true;
        subAgent._hooks = this._hooks; // 共享 hooks
        subAgent._allowedTools = this._allowedTools;
        subAgent._disallowedTools = this._disallowedTools;
        subAgent._setupToolContext();
        return await subAgent.run(task);
      },
    });
  }

  /** 设置非交互模式（管道/CI） */
  setNonInteractive(v: boolean): void {
    this._nonInteractive = v;
    this._setupToolContext();
  }

  /** 设置工具白名单/黑名单 */
  setToolFilter(allowed: string[] | null, disallowed: string[] | null): void {
    this._allowedTools = allowed ? new Set(allowed) : null;
    this._disallowedTools = disallowed ? new Set(disallowed) : null;
  }

  /** 获取 HookManager */
  get hooks(): HookManager {
    return this._hooks;
  }

  private _makeGovernor(summarySid?: string): void {
    const kb = ContextGovernor.loadKb(this.config.workDir);
    // 动态记忆注入：根据记忆条数控制注入量
    let memoryCtx = "";
    if (this._memory) {
      const total = this._memory.count();
      const injectN = total > this.config.memoryInjectCount ? this.config.memoryInjectCount : total;
      memoryCtx = this._memory.toSystemContext(injectN);
    }
    // 历史摘要：优先使用传入的 summarySid（用于新会话时引用上一次会话）
    const sid = summarySid || this.sessionId;
    const historySummary = (this._sessions && sid)
      ? (this._sessions.getHistorySummary(sid) || "") : "";
    this.governor = new ContextGovernor({
      system: this.config.systemPrompt,
      workDir: this.config.workDir,
      maxMsgs: this.config.maxContextMsgs,
      memoryContext: memoryCtx,
      historySummary: historySummary,
      kbContext: kb,
      contextLimit: this.config.contextLimit,
      maxInputTokens: this.config.maxInputTokens,
      maxTokens: this.config.maxTokens,
      compressThreshold: this.config.compressThreshold,
      compressHead: this.config.compressHead,
      compressTail: this.config.compressTail,
      safetyMargin: this.config.safetyMargin,
      inputWarnPct: this.config.inputWarnPct,
      inputForcePct: this.config.inputForcePct,
    });
  }

  get contextPct(): number {
    return ContextGovernor.contextPct(this.ctx, this.config.contextLimit);
  }

  get contextTokens(): number {
    return ContextGovernor.estimateTokens(this.ctx);
  }

  get cacheStats(): CacheStats {
    return this.llm.cacheStats;
  }

  initSession(sessionId?: string, resume = false): string {
    this._makeGovernor();
    if (resume && this._sessions) {
      const sid = sessionId || this._sessions.getLastSession() || "";
      if (sid) {
        try {
          const [savedCtx, meta] = this._sessions.load(sid);
          // Preserve full message structure including tool_calls and tool_call_id
          const typedCtx: Message[] = savedCtx.map((m: any) => ({
            role: (m.role || "user") as Message["role"],
            content: String(m.content || ""),
            ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls } : {}),
            ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
          }));
          if (typedCtx.length > 0 && typedCtx[0].role !== "system") {
            typedCtx.unshift(this.governor.system);
          }
          this.ctx = typedCtx;
          this.sessionId = sid;
          // Restore query/step counters from saved metadata
          this.queryCount = (meta && meta.query_count as number) || 0;
          this.stepCountTotal = (meta && meta.step_count as number) || 0;
          return sid;
        } catch { /* fall through to create new */ }
      }
    }
    const lastSid = this._sessions?.getLastSession() || "";
    const sid = sessionId || (this._sessions?.generateId() || "default");
    this.sessionId = sid;
    this.queryCount = 0;
    this.stepCountTotal = 0;
    this.ctx = [];
    // 新会话：不从上次会话加载完整上下文，但注入历史摘要以保留回顾信息
    this._makeGovernor(lastSid && lastSid !== sid ? lastSid : undefined);
    return sid;
  }

  get sessionIdStr(): string | null { return this.sessionId; }

  /** @internal Public for CLI access — matches Python's observer.traces */
  get allTraces(): RunTrace[] { return this.observer.traces; }

  get lastTrace(): RunTrace | null { return this.trace; }

  /** @internal Public for CLI access — matches Python's skill_mgr */
  get skillMgr(): SkillManager | null { return this._skillMgr; }

  get contextLimit(): number { return this.config.contextLimit; }
  get contextMessages(): number { return this.ctx.length; }
  get maxInputTokens(): number { return this.governor.maxInputTokens; }
  get maxTokens(): number { return this.config.maxTokens; }
  get inputTokensPct(): number { return this.governor.inputTokensPct(this.ctx); }

  /** @internal Public for CLI access — matches Python's public attribute */
  get sessions(): SessionStore | null { return this._sessions; }
  get memoryStore(): MemoryStore | null { return this._memory; }

  switchModel(alias: string): void {
    this.llm.switch(alias); this.config.model = this.llm.model;
    // 重新解析模型能力，更新 contextLimit 和 maxTokens
    const caps = resolveCapabilities(this.llm.model);
    this.config.contextLimit = caps.contextWindow;
    this.config.maxTokens = caps.maxOutputTokens;
    this.llm.updateMaxTokens(this.config.maxTokens);
    // 重建 governor 以应用新的上下文窗口
    this._makeGovernor();
  }

  switchPermissionMode(mode: string): string {
    const m = mode.toLowerCase().trim();
    if (["s", "std", "standard"].includes(m)) {
      this.config.permissionMode = "standard";
      return "standard — 文件操作全路径放行 / SYSTEM区内放行";
    } else if (["a", "auto", "auto-edit", "edit"].includes(m)) {
      this.config.permissionMode = "auto";
      return "auto — 自动批准编辑 + SYSTEM放行";
    } else if (["y", "yolo", "full", "bypass"].includes(m)) {
      this.config.permissionMode = "yolo";
      return "yolo — 全部放行";
    }
    return `(x) 未知模式: ${mode}\n可用: standard | auto | yolo`;
  }

  async chat(query: string, maxSteps?: number): Promise<string> {
    return this.run(query, maxSteps, true);
  }

  get goal(): string {
    const goalFile = path.join(this.config.workDir, "GOAL.txt");
    if (fs.existsSync(goalFile)) {
      try { return fs.readFileSync(goalFile, "utf-8").trim(); } catch { return ""; }
    }
    return "";
  }

  setGoal(text: string): string {
    const goalFile = path.join(this.config.workDir, "GOAL.txt");
    if (text.trim()) {
      fs.writeFileSync(goalFile, text.trim(), "utf-8");
      this.ctx.push({ role: "user", content: `[目标] ${text.trim()}` });
      return text.trim();
    } else {
      if (fs.existsSync(goalFile)) fs.unlinkSync(goalFile);
      return "";
    }
  }

  async run(query: string, maxSteps?: number, keepHistory = false): Promise<string> {
    if (!keepHistory || this.ctx.length === 0) {
      this.ctx = this.governor.init(query);
    } else {
      this.ctx = this.governor.appendUser(this.ctx, query);
    }
    const result = await this._loop(maxSteps || this.config.maxSteps);
    this.queryCount++;
    this.stepCountTotal += this.trace?.steps.length || 0;
    this._autoSave();
    // ── Auto-extract memory facts for next session ──
    if (this.config.autoExtractMemory && this._memory) {
      this._autoExtractFacts(query);
    }
    return result ?? "";
  }

  /**
   * 长时运行模式 — 自动续行直到任务完成或达到最大轮数。
   *
   * 每轮调用 run() 执行 maxSteps 步。当步数耗尽但任务未完成时：
   *   1. 保存当前会话（检查点）
   *   2. 压缩上下文（保留最近上下文 + 进度摘要）
   *   3. 注入续行提示，自动开始下一轮
   *
   * 与 Claude Code 的行为对齐：agent 持续工作直到用户中断或任务完成。
   */
  async runLong(query: string, maxRounds?: number): Promise<string> {
    const rounds = maxRounds ?? this.config.maxRounds;
    // 0 = truly unlimited auto-continue (user can Ctrl+C to interrupt)
    const unlimited = (rounds === 0);

    let fullResult = "";
    let roundNo = 0;
    while (true) {
      roundNo++;
      if (!unlimited && roundNo > rounds) break;
      if (this.term) {
        const display = unlimited ? "∞" : `${rounds}`;
        this.term.write(`\n  \x1b[36m═══ 轮次 ${roundNo}/${display} | 总步数 ${this.stepCountTotal} ═══\x1b[0m\n`);
      }

      // 执行一轮：首轮用 run()，后续轮直接调用 _loop（续行提示已在 ctx 中）
      let result: string;
      if (roundNo === 1) {
        result = await this.run(query, undefined, true);
      } else {
        result = await this._loop(this.config.maxSteps) ?? "";
        this.queryCount++;
        this.stepCountTotal += this.trace?.steps.length || 0;
        this._autoSave();
      }

      // 检查是否完成（trace 没有 stepLimitReached 说明 LLM 自然结束）
      if (this.trace && !this.trace.stepLimitReached) {
        fullResult = result;
        break;
      }

      // 步数耗尽但未完成 → 检查是否有错误
      if (this.trace && this.trace.error) {
        if (this.term) {
          this.term.write(`\n  \x1b[31m[轮次 ${roundNo} 失败: ${this.trace.error}]\x1b[0m\n`);
        }
        fullResult = result;
        break;
      }

      // 保存检查点
      if (this.sessionId && this._sessions) {
        this._autoSave();
        if (this.term) {
          this.term.write(`\n  \x1b[90m[检查点已保存]\x1b[0m\n`);
        }
      }

      // 上下文压缩
      if (this.ctx.length > this.config.compactThreshold) {
        this.ctx = this.governor.compact(this.ctx, 12);
        if (this.term) {
          this.term.write(`  \x1b[90m[上下文已压缩: ${this.ctx.length}条]\x1b[0m\n`);
        }
      }

      // 注入进度感知的续行提示
      this.ctx.push({
        role: "user",
        content: this._buildContinuationPrompt(),
      });

      fullResult = result;
    }

    return fullResult;
  }

  // ── TASKS.md 进度追踪 ──

  private get _tasksPath(): string {
    return path.join(this.config.workDir, "TASKS.md");
  }

  private _readTasks(): string {
    try {
      if (fs.existsSync(this._tasksPath)) {
        return fs.readFileSync(this._tasksPath, "utf-8");
      }
    } catch { /* ignore */ }
    return "";
  }

  private static _countTaskProgress(tasksText: string): { done: number; todo: number; total: number; pct: number } {
    const done = (tasksText.match(/\[x\]/g) || []).length;
    const todo = (tasksText.match(/\[ \]/g) || []).length;
    const total = done + todo;
    const pct = total > 0 ? Math.floor(done / total * 100) : 0;
    return { done, todo, total, pct };
  }

  private _buildContinuationPrompt(): string {
    const tasks = this._readTasks();
    // Check recent tool calls for errors
    const recentErrors: string[] = [];
    if (this.trace && this.trace.steps) {
      for (const step of this.trace.steps.slice(-5)) {
        if (!step.success) {
          recentErrors.push(`  - [${step.toolName}] ${step.resultPreview.slice(0, 200)}`);
        }
      }
    }
    let errorHint = "";
    if (recentErrors.length > 0) {
      errorHint = "\n\n== 最近错误（需要优先修复）==\n"
        + recentErrors.join("\n")
        + "\n请优先分析并修复以上错误，再继续新任务。";
    }
    if (!tasks) {
      return (
        "请继续之前的工作。如果任务已完成，请直接给出最终总结。"
        + "如果还有未完成的步骤，请继续执行。\n"
        + "提示：如果你还没有创建 TASKS.md 来跟踪进度，请先创建一个。"
        + errorHint
      );
    }
    const prog = CortexAgent._countTaskProgress(tasks);
    let tasksPreview = tasks.slice(0, 2000);
    if (tasks.length > 2000) tasksPreview += "\n...(TASKS.md 已截断)";
    return (
      `请继续之前的工作。当前进度：${prog.done}/${prog.total} 完成（${prog.pct}%）。\n\n`
      + `== TASKS.md 当前内容 ==\n${tasksPreview}\n\n`
      + "请根据以上进度：\n"
      + "- 如果有未完成的 [ ] 任务，继续执行下一个。\n"
      + "- 如果所有任务都已完成 [x]，请运行最终构建和测试验证，然后给出最终总结。\n"
      + "- 如果发现已完成的部分有错误，优先修复。"
      + errorHint
    );
  }

  private _autoExtractFacts(_userQuery: string): void {
    if (!this._memory) return;
    const steps = this.trace?.steps || [];
    const toolNames = steps.map(s => s.toolName);
    // Only auto-bookmark if no explicit remember_fact was already called
    if (!toolNames.includes("remember_fact")) {
      const summary = _userQuery.slice(0, 80).replace(/\n/g, " ");
      this._memory.append(`查询: ${summary}`);
    }
    // Auto-extract web_search result summaries (URL + title) into memory
    for (const step of steps) {
      if (step.toolName === "web_search" && step.success) {
        // Extract first result line from the search output
        const result = step.resultPreview;
        const match = result.match(/\[1\] (.*?)(?:\n|$)/);
        if (match) {
          const firstResult = match[1].trim().slice(0, 100);
          this._memory.append(`搜索到: ${firstResult}`);
        }
      }
      if (step.toolName === "web_fetch" && step.success && step.resultPreview.includes("--- ")) {
        // Extract page title/URL from fetch result
        const urlMatch = step.resultPreview.match(/--- (https?:\/\/\S+)/);
        if (urlMatch) {
          const url = urlMatch[1];
          const summary = step.resultPreview.slice(0, 200).replace(/\n/g, " ");
          this._memory.append(`抓取: ${url}`);
        }
      }
    }
  }

  private _autoSave(): void {
    if (!this._sessions || !this.sessionId) return;
    try {
      this._sessions.save(this.sessionId, this.ctx as any, {
        session_id: this.sessionId,
        last_active: new Date().toISOString(),
        model: this.config.model,
        query_count: this.queryCount,
        step_count: this.stepCountTotal,
      });
    } catch (e) {
      // Log save failure but don't crash
      console.error(`[session] 保存失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  saveSession(label?: string): string {
    if (!this._sessions || !this.sessionId) return "";
    this._sessions.save(this.sessionId, this.ctx as any, {
      session_id: this.sessionId,
      label: label || "",
      last_active: new Date().toISOString(),
      model: this.config.model,
      query_count: this.queryCount,
      step_count: this.stepCountTotal,
    });
    return this.sessionId;
  }

  reset(): void {
    this.ctx = [];
    this.rejectionCounts.clear();
    this.suspendedCaps.clear();
    this.permissionDecisions.clear();
    this.trace = null;
  }

  resumeSession(sessionId: string): boolean {
    if (!this._sessions) return false;
    try {
      const [savedCtx, meta] = this._sessions.load(sessionId);
      this.ctx = savedCtx as unknown as Message[];
      this.sessionId = sessionId;
      this.queryCount = (meta.query_count as number) || 0;
      this.stepCountTotal = (meta.step_count as number) || 0;
      this._makeGovernor();
      return true;
    } catch {
      return false;
    }
  }

  private async _requestConfirmation(
    toolName: string, args: Record<string, unknown>, capability: string,
  ): Promise<boolean> {
    const safeArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (k !== "workDir" && k !== "work_dir") safeArgs[k] = v;
    }
    const key = `${toolName}:${JSON.stringify(Object.entries(safeArgs).sort())}`;
    if (this.config.permissionRemember && this.permissionDecisions.has(key)) {
      return this.permissionDecisions.get(key)!;
    }
    if (!this.term) return false;

    this.term.closeThinking();
    const pathHint = String(args["path"] || args["url"] || args["command"] || "").slice(0, 40);
    process.stdout.write(`\n  \x1b[33m⚠ 需要授权:\x1b[0m  \x1b[36m▸ ${toolName}\x1b[0m [${capability}]\n`);
    process.stdout.write(`     \x1b[90m${pathHint}\x1b[0m\n`);
    process.stdout.write(`     [\x1b[32mY\x1b[0m/\x1b[31mn\x1b[0m/\x1b[32malways\x1b[0m/\x1b[31mdeny\x1b[0m] `);

    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise<string>(resolve => rl.question('', resolve));
      rl.close();
      const trimmed = ans.trim().toLowerCase();
      if (trimmed === "always") { this.permissionDecisions.set(key, true); return true; }
      if (trimmed === "deny") { this.permissionDecisions.set(key, false); return false; }
      return trimmed === "y" || trimmed === "yes";
    } catch { return false; }
  }

  private async _loop(maxSteps: number): Promise<string> {
    this.trace = this.observer.createTrace(this.ctx[this.ctx.length - 1]?.content || "");
    if (this.term) this.term.nextRound();
    // maxSteps=0 → unlimited steps (24h continuous operation)
    const unlimited = (maxSteps === 0);
    let stepNo = 0;
    while (true) {
      stepNo++;
      if (!unlimited && stepNo > maxSteps) break;
      // ── Heartbeat: log progress every 20 steps (observability for long runs) ──
      if (stepNo % 20 === 0 && this.term) {
        const elapsed = (Date.now() - this.trace.startTime) / 1000;
        const ctxPct = ContextGovernor.contextPct(this.ctx, this.config.contextLimit);
        const cs = this.llm.cacheStats;
        const cacheStr = cs.calls > 0 ? ` | 缓存 ${cs.hitRate.toFixed(0)}%` : "";
        this.term.write(`\n  \x1b[90m[心跳] 步骤 ${stepNo} | 耗时 ${elapsed.toFixed(0)}s | 上下文 ${ctxPct}%${cacheStr} | 消息 ${this.ctx.length} 条 | 工具调用 ${this.trace.steps.length} 次\x1b[0m\n`);
      }
      this.ctx = this.governor.govern(this.ctx);
      const { text, toolCalls } = await this._think();
      if (text === null && !toolCalls) {
        const err = this.lastLlmError || "未知错误";
        this.trace.error = `LLM 调用失败: ${err}`;
        if (this.term) {
          this.term.closeThinking();
          this.term.write(`\n${this.trace.error}\n`);
          return "";
        }
        return this.trace.error;
      }
      if (!toolCalls) {
        this.ctx.push({ role: "assistant", content: text || "" });
        this.trace.finalAnswer = text || "";
        // Terminal output: ensure the answer text is visible.
        // 1) Fallback: if text was returned by LLM but not streamed to terminal
        //    (e.g., retry levels produced text but answerToken was never called),
        //    print it now via writeAnswer().
        // 2) Always write a trailing newline so the REPL prompt (rl.prompt())
        //    doesn't overwrite the last line of the answer via _refreshLine().
        if (this.term) {
          if (text && !this.term.isAnswerShown()) {
            this.term.writeAnswer(text);
          }
          this.term.write("\n");
        }
        return this.term ? "" : (text || "");
      }
      this.ctx.push({
        role: "assistant", content: text || "",
        tool_calls: toolCalls.map(tc => ({
          id: tc.id, type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tc of toolCalls) {
        const t0 = Date.now();
        const meta = registry.meta(tc.name);
        const capStr = meta?.capability || "?";
        const cap = meta?.capability || null;

        if (this.term) this.term.toolStart(tc.name, tc.args);
        let ok: boolean;
        let reason: string;

        // ── 工具白名单/黑名单过滤 ──
        if (this._allowedTools && !this._allowedTools.has(tc.name)) {
          ok = false; reason = `工具 ${tc.name} 不在白名单中`;
        } else if (this._disallowedTools && this._disallowedTools.has(tc.name)) {
          ok = false; reason = `工具 ${tc.name} 已被黑名单禁止`;
        } else if (cap && this.suspendedCaps.has(cap) && this.config.permissionMode !== "yolo") {
          ok = false; reason = `能力 ${cap} 已被暂停`;
        } else {
          [ok, reason] = await this.policy.audit(tc.name, tc.args);
        }
        if (!ok && reason === "confirm") {
          if (this.config.permissionMode === "yolo" || this.config.permissionMode === "auto") {
            ok = true; reason = "";
          } else {
            try {
              ok = await this._requestConfirmation(tc.name, tc.args, capStr);
              reason = ok ? "用户授权" : "用户拒绝";
            } catch {
              ok = false; reason = "用户拒绝";
            }
          }
        }
        if (!ok && cap && !reason.includes("用户")) {
          // yolo 模式不累计拒绝计数，不暂停能力
          if (this.config.permissionMode !== "yolo") {
            const cnt = (this.rejectionCounts.get(cap) || 0) + 1;
            this.rejectionCounts.set(cap, cnt);
            if (cnt >= 5) {
              this.suspendedCaps.add(cap);
              reason = `(x) [Policy 拦截] ${cap} 能力已被暂停（连续 ${cnt} 次违规）`;
            } else {
              reason = `(x) [Policy 拦截] ${reason}`;
            }
          } else {
            reason = `(x) [Policy 拦截] ${reason}`;
          }
        }
        let result: string;
        if (!ok) {
          result = reason;
        } else {
          // ── PreToolUse 钩子 ──
          const preHook = await this._hooks.runPreToolUse({
            toolName: tc.name, args: tc.args, workDir: this.config.workDir,
          });
          if (preHook.block) {
            ok = false;
            result = preHook.message;
          } else {
            // ── 代码写入打字机效果：在 write_file/edit_file 执行前流式显示代码 ──
            if (this.term && (tc.name === "write_file" || tc.name === "edit_file")) {
              const content = tc.name === "write_file"
                ? String(tc.args["content"] || "")
                : String(tc.args["newString"] || tc.args["new_string"] || "");
              const filePath = String(tc.args["filePath"] || tc.args["path"] || tc.args["file_path"] || "");
              if (content && content.length >= 30) {
                await this.term.codeStream(filePath, content);
              }
            }
            if (reason.startsWith(PolicyEngine.WARN_PREFIX)) {
              // WARN tier: execute but annotate warning to LLM context (与 Python 对齐)
              const warnMsg = reason.slice(PolicyEngine.WARN_PREFIX.length);
              result = await Promise.resolve(this.executor.execute(tc.name, tc.args));
              result = `[注意: ${warnMsg}]\n${result}`;
            } else {
              result = await Promise.resolve(this.executor.execute(tc.name, tc.args));
            }
            // ── PostToolUse 钩子 ──
            const postHook = await this._hooks.runPostToolUse({
              toolName: tc.name, args: tc.args, result, workDir: this.config.workDir,
            });
            if (preHook.append) result += `\n${preHook.append}`;
            if (postHook.append) result += `\n${postHook.append}`;
          }
        }

        const latency = Date.now() - t0;
        if (this.term) this.term.toolDone(ok, latency, result);
        this.observer.record(this.trace, stepNo, tc.name, tc.args, result, ok, capStr, latency);
        this.ctx.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      // ── Checkpoint: auto-save every N steps ──
      if (this.config.checkpointInterval > 0 &&
        stepNo % this.config.checkpointInterval === 0 &&
        this.sessionId && this._sessions) {
        this._autoSave();
      }
      // ── Context compaction: compress when messages exceed threshold ──
      if (this.config.compactThreshold > 0 &&
        this.ctx.length > this.config.compactThreshold) {
        this.ctx = this.governor.compact(this.ctx, 12);
        if (this.term) {
          this.term.write(`\n  \x1b[90m[上下文已压缩: ${this.ctx.length}条]\x1b[0m\n`);
        }
      }

      // ── Reflect: only check convergence when step limit is set ──
      if (!unlimited) {
        const convergence = await this._reflect(this.trace, stepNo, maxSteps);
        if (convergence !== null) return convergence;
      }
    }
    // Only mark step limit reached when not unlimited
    if (!unlimited) {
      this.trace.stepLimitReached = true;
    }
    const msg = "[超步数] 未能完成";
    if (this.term) {
      this.term.closeThinking();
      this.term.write(`\n${msg}\n`);
      return "";
    }
    return msg;
  }

  private async _reflect(trace: RunTrace, stepNo: number, maxSteps: number): Promise<string | null> {
    if (stepNo === maxSteps) {
      // 标记步数已耗尽（runLong 依赖此标记决定是否续行）
      trace.stepLimitReached = true;
      // On the last step, give LLM one more chance to produce a final answer
      const { text, toolCalls } = await this._think();
      if (text) {
        trace.finalAnswer = text;
        if (toolCalls && toolCalls.length > 0) {
          // Text was streamed, but the suffix is not — print it to terminal
          if (this.term) {
            this.term.closeThinking();
            this.term.write("\n\n[已达最大步数，工具调用未执行]");
            return "";
          }
          return text + "\n\n[已达最大步数，工具调用未执行]";
        }
        // Text was already streamed via callStream — return "" for terminal mode
        return this.term ? "" : text;
      }
      // LLM returned empty (API failure after retries) — display fallback to terminal
      let fallback: string;
      if (trace.steps.length > 0) {
        const lastResults = trace.steps.slice(-3).map(s =>
          `[${s.toolName}] ${s.resultPreview}`
        ).join("\n");
        fallback = `[达到最大步数 ${maxSteps} 步，无法生成完整回答]\n\n最后一次工具调用结果:\n${lastResults}\n\n请尝试用更具体的问题重新查询，或增加 --max-steps 参数。`;
      } else {
        fallback = "[达到最大步数]";
      }
      if (this.term) {
        this.term.closeThinking();
        this.term.write(`\n${fallback}\n`);
        return "";
      }
      return fallback;
    }
    return null;
  }

  private async _think(): Promise<{
    text: string | null; toolCalls: ParsedToolCall[] | null; reasoning: string;
  }> {
    /**
     * Think 阶段 — 调用 LLM，带输入压力感知的渐进降级恢复。
     *
     * 4 级降级策略（每级改变策略+减少输入压力，与 Python 对齐）:
     *   Level 1: thinking=true  — 正常推理模式
     *   Level 2: thinking=false — 关闭推理，全部 token 留给 content/tool_calls
     *   Level 3: thinking=false + 强制 govern — 压缩历史 tool result 后重试
     *   Level 4: thinking=false + nudge — 注入提示消息强制生成回答
     *
     * 所有异常被捕获并记录到 this.lastLlmError，不静默吞掉。
     */
    this.lastLlmError = "";

    const doCall = async (thinking: boolean = true, ctxOverride?: Message[]) => {
      const ctx = ctxOverride || this.ctx;
      if (this.term) {
        return this.llm.callStream(ctx,
          t => this.term!.thinkToken(t),
          t => this.term!.answerToken(t),
          thinking,
          (name, _args) => { if (!name) this.term!.closeThinking(); },
        );
      }
      return this.llm.call(ctx, thinking);
    };

    const isTransient = (err: any): boolean => {
      const msg = String(err?.message || err).toLowerCase();
      const markers = ["429", "500", "502", "503", "timeout", "timed out",
        "connection", "temporar", "overload", "rate limit",
        "service unavailable", "bad gateway", "internal server error"];
      return markers.some(m => msg.includes(m));
    };

    const doCallWithRetry = async (thinking: boolean = true, ctxOverride?: Message[]) => {
      let lastErr: any;
      for (let attempt = 0; attempt <= this.config.retryMax; attempt++) {
        try {
          return await doCall(thinking, ctxOverride);
        } catch (e: any) {
          lastErr = e;
          if (!isTransient(e) || attempt >= this.config.retryMax) throw e;
          const delay = this.config.retryBaseDelay * Math.pow(2, attempt);
          if (this.term) {
            this.term.write(`\n  \x1b[33m[重试 ${attempt + 1}/${this.config.retryMax}] ${delay.toFixed(0)}s 后重试: ${e}\x1b[0m`);
          }
          await new Promise(r => setTimeout(r, delay * 1000));
        }
      }
      throw lastErr;
    };

    // ── Level 1: 正常推理模式（含瞬态错误重试） ──
    let l1Reasoning = "";
    try {
      const { text, toolCalls, reasoning } = await doCallWithRetry(true);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning };
      }
      l1Reasoning = reasoning || "";
    } catch (e: any) { this.lastLlmError = `[L1] ${e?.message || e}`; /* fall through */ }

    // ── Level 2: 关闭推理模式（解决 finishReason=length） ──
    await new Promise(r => setTimeout(r, 500));
    try {
      const { text, toolCalls } = await doCall(false);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning: "" };
      }
    } catch (e: any) { this.lastLlmError = `[L2] ${e?.message || e}`; /* fall through */ }

    // ── Level 3: 压缩上下文后重试（减少输入 token 压力） ──
    await new Promise(r => setTimeout(r, 500));
    const compressedCtx = this.governor.govern([...this.ctx]);
    try {
      const { text, toolCalls } = await doCall(false, compressedCtx);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning: "" };
      }
    } catch (e: any) { this.lastLlmError = `[L3] ${e?.message || e}`; /* fall through */ }

    // ── Level 4: 关闭推理 + 注入 nudge ──
    await new Promise(r => setTimeout(r, 500));
    const nudge: Message = { role: "user", content: "请根据以上工具返回的信息，直接给出你的回答。" };
    this.ctx.push(nudge);
    let l4Text: string | null = null;
    let l4Tcs: ParsedToolCall[] | null = null;
    let l4Reasoning = "";
    try {
      const { text, toolCalls, reasoning } = await doCall(false);
      l4Text = text; l4Tcs = toolCalls; l4Reasoning = reasoning;
    } catch (e: any) { this.lastLlmError = `[L4] ${e?.message || e}`; }
    // 使用 finally 模式确保 nudge 只被 pop 一次（与 Python 对齐）
    if (this.ctx.length > 0 && this.ctx[this.ctx.length - 1] === nudge) {
      this.ctx.pop();
    }

    if (l4Text || l4Tcs) {
      return { text: l4Text, toolCalls: l4Tcs, reasoning: l4Reasoning };
    }
    // ── Fallback: all levels returned empty text.
    // If reasoning was collected (e.g., API returned reasoning_content but no content),
    // use the reasoning as the answer text so the user sees something useful
    // instead of a cryptic "LLM 调用失败" error.
    const fallbackReasoning = (l4Reasoning && l4Reasoning.trim()) || (l1Reasoning && l1Reasoning.trim());
    if (fallbackReasoning) {
      return { text: fallbackReasoning, toolCalls: null, reasoning: "" };
    }
    return { text: null, toolCalls: null, reasoning: "" };
  }
}
