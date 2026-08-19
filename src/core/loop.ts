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
import { LLMProvider, ParsedToolCall, resolveCapabilities, DEFAULT_PROVIDERS as DEFAULT_PROVIDERS_LLM } from './llm.js';
export { LLMProvider } from './llm.js';
import { MemoryStore, SessionStore } from './memory_store.js';
import { SkillManager } from './skills.js';
import { HookManager } from './hooks.js';
import { setToolContext, getToolContext } from './tool_context.js';
import { SubagentTerminal, SubagentToolCall } from '../cli/terminal.js';
import { setToolTimeout } from '../tools/exec.js';

// Terminal color shortcuts for inline rendering
const Terminal_DIM = "\x1b[38;5;245m";
const Terminal_GRAY = "\x1b[38;5;240m";
const Terminal_GREEN = "\x1b[38;5;82m";
const Terminal_RED = "\x1b[38;5;196m";
const Terminal_RESET = "\x1b[0m";
export { HookManager } from './hooks.js';
export { setToolContext, getToolContext } from './tool_context.js';

// ── 默认系统提示 ──
const DEFAULT_SYSTEM = [
  "你是 Cortex Agent，一个 AI Agent 运行时框架（Harness Agent 架构 + Agentic Loop 引擎），基于用户在 settings.json 中配置的 LLM 模型运行。",
  "当用户问「你是什么模型」时，回答：你是 Cortex Agent，当前底层模型由用户在 settings.json 中配置。",
  "",
  "== 工具使用判断 ==",
  "收到用户输入后，先判断是否需要工具：",
  "  - 问候/闲聊/你已具备知识的问题 → 直接文字回复，不调用工具",
  "  - 需要读写文件/执行命令/搜索网络/操作浏览器 → 进入工作循环",
  "  ⚠ 每次用户输入都是新请求，不要因历史记录自行继续旧任务。",
  "",
  "== 工作循环：思考 → 调用工具 → 反思 → 继续/完成 ==",
  "1. 思考：用户想要什么？还缺什么信息？下一步做什么？为什么选这个方案？",
  "2. 调用工具：优先专用工具（如 edit_file 而非 shell）。",
  "   - 独立任务应并行调用多个工具，减少 LLM 往返次数（降低 API 费用）",
  "   - 例：搜索不同关键词时可同时发起 2-3 个 web_search；读取多个文件时可同时发起多个 read_file",
  "   - 有依赖关系的工具必须分步调用（如先 read_file 再 edit_file）",
  "3. 反思（必须）：拿到工具结果后，先分析再行动：",
  "   - 搜索结果：质量如何？是否已包含答案？哪些信息有用？还缺什么？",
  "   - 执行结果：成功了吗？结果是否符合预期？有错误则定位根因并修复。",
  "   - 根据分析决定下一步：有答案 → 回答用户；信息不足 → 继续搜索或抓取；有错误 → 修复后重试。",
  "   - 任务完成 → 给出清晰的最终回答，总结完成的工作和关键结果。",
  "",
  "== 安全边界 ==",
  "1. 不得危害系统安全、泄露数据或破坏系统完整性。",
  "2. 不得修改系统配置文件（C:\\Windows, /etc 等）或读取系统敏感文件（/etc/passwd、~/.ssh、SAM、注册表）。",
  "3. 不得将文件内容通过外部网络发送，不得使用编码命令或混淆方式执行 shell。",
  "4. 文件操作可在用户目录范围内自由进行（桌面、文档、工作目录等）。",
  "",
  "== 验证策略 ==",
  "模型可能不支持图像识别，验证结果优先用文本方式：",
  "  - 页面验证：browser_snapshot() 获取页面文本，而非 browser_screenshot()",
  "  - 服务验证：check_server_status(url=...) 发送 HTTP 请求",
  "  - 代码验证：run_shell_command 运行测试/编译，grep/read_file 检查代码",
  "⚠️ 连续截图 2 次仍无法确认时，立即切换文本验证。",
  "服务器启动用 run_background_command（非 run_shell_command），Windows 命令分隔符用 ;（非 &&）。",
  "",
  "== 联网搜索策略 ==",
  "搜索结果已包含前3条页面的富内容（约2000字/条），先看是否已包含答案。",
  "搜索指导（根据任务复杂度自主决策搜索次数）：",
  "  - 搜索结果有足够信息 → 直接回答，不必 web_fetch",
  "  - 搜索结果不够 → web_fetch 抓取最相关的页面获取详细内容",
  "  - 仍不够 → 换关键词继续搜索，直到收集到足够信息",
  "  - 复杂调研任务可搜索 5-10 次，每次用不同关键词角度，避免重复搜索同一内容",
  "关键词策略（提高搜索精准度，减少试错）：",
  "  - 用具体的专有名词而非泛词（如 'ToonCrafter GitHub' 而非 'AI 漫剧 视频 生成'）",
  "  - 搜索技术文档/开源项目时优先用英文关键词 + 技术术语",
  "  - 搜索中文产品/平台时用中文关键词（如 '知漫剧 官网 价格'）",
  "  - 避免过泛的关键词（如 'AI 平台 2026' 会返回日历页面和通用列表页）",
  "⚠️ 子代理返回的结果已是最终结果，主代理不要重复搜索或抓取同一内容。",
  "搜索前先调用 get_current_time 获取当前时间，将年份月份写入搜索关键词。",
  "",
  "== 技能系统 (Skills) ==",
  "技能是可复用的专家级指引模板。用 list_skills() 查看，use_skill(name=...) 加载，skill_install(source=...) 安装，skill_remove(name=...) 删除。",
  "任务匹配技能领域时，先 list_skills 再 use_skill 加载指引，然后按指引执行。",
  "",
  "== 子代理系统 (Subagents) ==",
  "可派遣子代理执行独立任务（独立上下文，返回结果摘要，不污染主对话）。",
  "  - spawn_subagent(task=\"...\") 派遣单个；spawn_subagents(tasks_json=\"...\") 并行派遣多个（fan-out）。",
  "  - 可选参数：tools 限制工具，skill 预加载技能。",
  "复杂任务（3+ 模块分析、多维度审查、大规模项目）主动用 spawn_subagents 并行拆分。子代理拥有无限步数。",
  "⚠️ 子代理不应再派遣子代理（避免嵌套导致 API 费用爆炸）。子代理应自己完成搜索和分析。",
  "",
  "== MCP 服务器 ==",
  "预装 chrome-devtools（浏览器自动化）和 cua-driver（桌面控制）MCP 服务器。",
  "用 mcp_list_servers() 查看，mcp_session_start() 启动持久会话，mcp_session_call() 调用工具。",
  "",
  "== 大项目工程指引 ==",
  "复杂任务先创建 TASKS.md 分解子任务，渐进式开发，即时验证（写完即编译/测试），",
  "上下文压缩时读 TASKS.md 恢复进度。最终运行完整构建和测试确保零错误。",
].join("\n");

// ── ContextGovernor ──
export class ContextGovernor {
  /** ASCII 字符的 token 估算系数（英文/代码约 0.4 token/char） */
  static TOKENS_PER_CHAR_ASCII = 0.4;
  /** CJK 字符的 token 估算系数（中文/日文/韩文约 1.0 token/char） */
  static TOKENS_PER_CHAR_CJK = 1.0;
  /** 工具结果压缩阈值（字符数） */
  static COMPRESS_THRESHOLD = 6000;
  static COMPRESS_HEAD = 2400;
  static COMPRESS_TAIL = 1600;
  /** 安全余量：预留给 tokenizer 估算误差 + tool schema 开销 */
  static SAFETY_MARGIN = 4096;
  /** 输入 token 预警线（占 maxInputTokens 的百分比） */
  static INPUT_WARN_PCT = 80;
  static INPUT_FORCE_PCT = 90;
  /** 缓存友好的 compact 触发（token 预算驱动，替代旧的条数触发）：
   * 输入 token 达 maxInputTokens × COMPACT_INPUT_PCT% 才一次性 compact；
   * 平时 govern() 零触碰历史（append-only，前缀逐字节稳定 → 缓存全命中） */
  static COMPACT_INPUT_PCT = 85;
  static COMPACT_KEEP_RECENT = 12;

  system: Message;
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
  compactInputPct: number;
  compactKeepRecent: number;

  constructor(opts: {
    system?: string; workDir?: string;
    memoryContext?: string; historySummary?: string;
    kbContext?: string; contextLimit?: number;
    maxInputTokens?: number; maxTokens?: number;
    compressThreshold?: number; compressHead?: number; compressTail?: number;
    safetyMargin?: number; inputWarnPct?: number; inputForcePct?: number;
    compactInputPct?: number; compactKeepRecent?: number;
  }) {
    const parts: string[] = [opts.system || DEFAULT_SYSTEM];
    if (opts.kbContext) parts.push(`\n[项目知识库]\n${opts.kbContext}`);
    if (opts.memoryContext) parts.push(`\n${opts.memoryContext}`);
    if (opts.historySummary) parts.push(`\n${opts.historySummary}`);
    if (opts.workDir) parts.push(`\n工作目录: ${opts.workDir}`);
    this.system = { role: "system", content: parts.join("\n") };
    this.contextLimit = opts.contextLimit || 1_000_000;
    this.maxTokens = opts.maxTokens || 16384;
    // 可调参数：使用传入值或回退到类常量默认值
    this.compressThreshold = opts.compressThreshold || ContextGovernor.COMPRESS_THRESHOLD;
    this.compressHead = opts.compressHead || ContextGovernor.COMPRESS_HEAD;
    this.compressTail = opts.compressTail || ContextGovernor.COMPRESS_TAIL;
    this.safetyMargin = opts.safetyMargin || ContextGovernor.SAFETY_MARGIN;
    this.inputWarnPct = opts.inputWarnPct || ContextGovernor.INPUT_WARN_PCT;
    this.inputForcePct = opts.inputForcePct || ContextGovernor.INPUT_FORCE_PCT;
    this.compactInputPct = opts.compactInputPct || ContextGovernor.COMPACT_INPUT_PCT;
    this.compactKeepRecent = opts.compactKeepRecent || ContextGovernor.COMPACT_KEEP_RECENT;
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

  /** CJK 感知的 token 估算 — 中文内容 ~1.0 token/char，ASCII ~0.4 token/char。
   *  旧实现固定 0.4 对中文严重低估，导致 compact 在上下文溢出前不触发。 */
  static estimateTextTokens(text: string): number {
    if (!text) return 0;
    let ascii = 0, cjk = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // CJK 统一汉字、扩展A、平假名、片假名、韩文、全角符号
      if ((c >= 0x3000 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xFF00 && c <= 0xFFEF)) {
        cjk++;
      } else {
        ascii++;
      }
    }
    return Math.floor(ascii * ContextGovernor.TOKENS_PER_CHAR_ASCII + cjk * ContextGovernor.TOKENS_PER_CHAR_CJK);
  }

  static estimateTokens(msgs: Message[]): number {
    let total = 0;
    for (const m of msgs) {
      let content = m.content || "";
      if (m.tool_calls) {
        content += JSON.stringify(m.tool_calls.map(tc => tc.function));
      }
      if (typeof content === "string") {
        total += ContextGovernor.estimateTextTokens(content);
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
        const content = (m.content || "").slice(0, 200);
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
        const content = (m.content || "").slice(0, 150);
        if (content.trim()) summaryParts.push(`Agent: ${content}`);
      } else if (m.role === "tool") {
        const content = m.content || "";
        if (content.length > 100) {
          summaryParts.push(`  → 结果(${content.length}字符): ${content.slice(0, 200)}...`);
        }
      }
    }

    let compactText = `[上下文压缩 — ${old.length}条消息已摘要]\n`;
    // 保留原始用户目标（防止长任务丢失目标连续性）
    const firstUserMsg = old.find(m => m.role === "user");
    if (firstUserMsg && firstUserMsg.content) {
      compactText += `原始目标: ${firstUserMsg.content.slice(0, 500)}\n`;
    }
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
      if (body.length > 3000) body = body.slice(0, 3000) + "...";
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
    if (!fs.existsSync(kbPath)) return "";
    try {
      const content = fs.readFileSync(kbPath, "utf-8");
      return ContextGovernor._resolveImports(content, projectDir, 0);
    } catch { return ""; }
  }

  /** 递归解析 @import <path> 指令（深度限制 3，防止循环引用）。与 Python 对齐。 */
  private static _resolveImports(content: string, baseDir: string, depth: number): string {
    if (depth >= 3) return content;
    return content.replace(/^@import\s+(.+)$/gm, (match, importPath) => {
      const trimmed = importPath.trim().replace(/^["']|["']$/g, "");
      const full = path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed);
      try {
        if (fs.existsSync(full)) {
          const imported = fs.readFileSync(full, "utf-8");
          return ContextGovernor._resolveImports(imported, path.dirname(full), depth + 1);
        }
      } catch { /* ignore */ }
      return match;
    });
  }

  init(query: string): Message[] {
    return [this.system, { role: "user", content: query }];
  }

  appendUser(ctx: Message[], query: string): Message[] {
    ctx.push({ role: "user", content: query });
    return ctx;
  }

  /**
   * 缓存友好的上下文治理 — 前缀稳定优先（append-only）。
   *
   * 设计原则（对齐 Claude Code / zcode 的 prompt-cache 优化）:
   *   - 低于压缩预算时**零触碰**：不裁剪条数、不改写历史 tool result、
   *     不往历史中间插入标记消息，保证请求前缀逐字节稳定，
   *     最大化 provider 前缀缓存命中率（GLM/DeepSeek/OpenAI 为自动前缀缓存，
   *     Anthropic 走 cache_control 断点缓存）
   *   - 达到 token 预算（compactInputPct% × maxInputTokens）才一次性 compact，
   *     接受这一次全量缓存重建，之后继续全命中
   *   - compact 后仍超硬上限时，兜底只保留 system + 最近 3 条
   */
  govern(msgs: Message[]): Message[] {
    const inputTokens = ContextGovernor.estimateTokens(msgs);
    const compactLine = Math.floor(this.maxInputTokens * this.compactInputPct / 100);
    if (inputTokens < compactLine) {
      return msgs;  // 零触碰：前缀稳定，缓存全命中
    }
    // 一次性 compact（这一次请求全量重建缓存，之后恢复命中）
    let result = this.compact(msgs, this.compactKeepRecent);
    // 硬兜底：compact 后仍超 maxInputTokens → system + 最近 3 条
    if (result.length > 4 && ContextGovernor.estimateTokens(result) >= this.maxInputTokens) {
      result = ContextGovernor._fixToolPairing([result[0], ...result.slice(-3)]);
    }
    return result;
  }

  /**
   * tool result 写入 ctx 前的定长压缩 — 只在写入时执行一次。
   *
   * 写入后该消息字节永不改变（历史 append-only），这是前缀缓存稳定的关键。
   * 旧实现每步 govern() 都原地压缩历史消息，导致缓存前缀逐步失效。
   */
  finalizeToolResult(text: string): string {
    return this.compressResult(text);
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
  static MAX_RESULT_CHARS = 50000;
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
      // snake_case 别名：同时保留原始 key 和 camelCase 别名，
      // 这样无论工具读 args["allowed_domains"] 还是 args["allowedDomains"] 都能找到。
      const normArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        normArgs[k] = v;
        const alias = ToolExecutor.SNAKE_ALIASES[k];
        if (alias && alias !== k) normArgs[alias] = v;
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

export interface SubagentResult {
  id: number;
  task: string;
  skill?: string;
  tools?: string;
  success: boolean;
  latencyMs: number;
  result: string;
  toolCalls: SubagentToolCall[];
  answerPreview: string;
}

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
  private _screenshotStreak = 0;
  private _lastToolSig = "";
  private _repeatCount = 0;
  private _subagentResults: SubagentResult[] = [];
  private _subagentIdCounter = 1;
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
  /** Agent 深度：0=主代理, 1=子代理。子代理的工具 schema 中不包含 spawn_subagent/spawn_subagents */
  private _depth: number = 0;
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
    subagentDispatch?: (count: number) => void;
    subagentStart?: (idx: number, total: number, task: string) => void;
    subagentDone?: (idx: number, total: number, success: boolean, latencyMs?: number) => void;
  } | null = null;

  setTerm(t: typeof this.term) { this.term = t; }

  constructor(config: Partial<AgentConfig> = {}, depth: number = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._depth = depth;
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
    setToolTimeout(this.config.toolTimeout);

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

    // 根据 depth 过滤工具 schema：子代理（depth>0）看不到 spawn_subagent/spawn_subagents
    // 这是架构层面的隔离 — LLM 根本不知道这些工具存在，不会尝试调用
    const toolSchemas = depth > 0
      ? registry.schemaList.filter(s => s.function.name !== "spawn_subagent" && s.function.name !== "spawn_subagents")
      : registry.schemaList;

    this.llm = new LLMProvider({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      model: resolvedModel,
      tools: toolSchemas,
      timeout: this.config.thinkTimeout,
      maxTokens: this.config.maxTokens,
      protocol: (config as { protocol?: import("./llm.js").ProtocolKind }).protocol,
    });
    this._makeGovernor();
    this._setupToolContext();
  }

  /** 创建并运行单个子代理（含内联流式显示 + 结果存储） */
  private async _runSubagent(task: string, model?: string, tools?: string, skill?: string,
                              idx?: number, total?: number): Promise<string> {
    // 预加载技能：将技能 prompt 前置注入任务
    let effectiveTask = task;
    if (skill && this._skillMgr) {
      const skillObj = this._skillMgr.get(skill);
      if (skillObj) {
        effectiveTask = skillObj.toPrompt() + "\n\n---\n\n任务: " + task;
      }
    }
    const subConfig: Partial<AgentConfig> = {
      ...this.config,
      model: model ? LLMProvider.resolve(model) : this.config.model,
      maxSteps: 0,
      maxRounds: 1,
      thinkTimeout: Math.max(this.config.thinkTimeout || 600, 180), // 子代理并行时API响应慢，至少180s
    };
    const subAgent = new CortexAgent(subConfig, this._depth + 1);
    subAgent._nonInteractive = true;
    subAgent._hooks = this._hooks;
    // 工具 schema 已在构造函数中按 depth 过滤（子代理看不到 spawn_subagent/spawn_subagents）
    // 这里只处理用户指定的 tools 白名单/黑名单
    if (tools) {
      const toolsList = tools.split(",").map(t => t.trim()).filter(Boolean);
      const COMMON = [
        "list_tools", "get_current_time",
        "read_file", "write_file", "edit_file", "glob", "grep", "list_directory",
        "diff_files", "read_json", "file_ops", "csv_query",
        "run_shell_command", "run_python", "execute_sql_query", "python_lint",
        "run_background_command", "check_server_status", "stop_background_process", "list_background_processes",
        "web_search", "web_fetch", "http_request",
        "remember_fact", "recall_fact", "forget_fact", "ask_user",
        "list_skills", "use_skill",
        "git_status", "git_diff", "git_log",
        "set_proxy", "show_proxy", "search_knowledge",
        "mcp_list_servers", "mcp_registry",
      ];
      for (const e of COMMON) { if (!toolsList.includes(e)) toolsList.push(e); }
      subAgent.setToolFilter(toolsList, null);
    } else {
      subAgent._allowedTools = null;
      subAgent._disallowedTools = this._disallowedTools;
    }
    // 设置子代理终端（内联流式显示）
    let subTerm: SubagentTerminal | null = null;
    if (this.term && idx != null && total != null) {
      const label = skill ? `[${skill}] ${task}` : task;
      subTerm = new SubagentTerminal(idx, total, label);
      subAgent.setTerm(subTerm as any);
    }
    subAgent._setupToolContext();
    let result = await subAgent.run(effectiveTask);
    // run() 在 term 存在时返回 ""，从 SubagentTerminal 获取完整答案
    if (!result && subTerm) {
      result = subTerm.getFullAnswer();
    }
    // 输出最终摘要
    if (subTerm) subTerm.flush();
    // 存储结果供 /subagent <id> 查看
    this._subagentResults.push({
      id: this._subagentIdCounter++,
      task, skill, tools,
      success: true,
      latencyMs: 0, // 由调用方设置
      result,
      toolCalls: subTerm ? subTerm.getToolCalls() : [],
      answerPreview: subTerm ? subTerm.getAnswerPreview() : result.slice(0, 200),
    });
    return result;
  }

  /** 设置工具上下文（供 ask_user, spawn_subagent 等工具使用） */
  private _setupToolContext(): void {
    setToolContext({
      workDir: this.config.workDir,
      nonInteractive: this._nonInteractive,
      agentConfig: this.config as unknown as Record<string, unknown>,
      skillManager: this._skillMgr ?? undefined,
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
      spawnSubagent: async (task: string, model?: string, tools?: string, skill?: string): Promise<string> => {
        const label = skill ? `[${skill}] ${task}` : task;
        const t0 = Date.now();
        try {
          const result = await this._runSubagent(task, model, tools, skill, 1, 1);
          if (this.term) this.term.subagentDone?.(1, 1, true, Date.now() - t0);
          // 更新最后一条结果的延迟
          if (this._subagentResults.length > 0) this._subagentResults[this._subagentResults.length - 1].latencyMs = Date.now() - t0;
          return result;
        } catch (e) {
          if (this.term) this.term.subagentDone?.(1, 1, false, Date.now() - t0);
          throw e;
        }
      },
      spawnSubagents: async (tasksJson: string): Promise<string> => {
        let tasks: unknown[];
        try {
          tasks = JSON.parse(tasksJson);
        } catch (e) {
          return `(x) tasks_json 解析失败: ${e}`;
        }
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return "(x) tasks_json 必须是非空 JSON 数组";
        }
        const n = tasks.length;
        if (this.term) this.term.subagentDispatch?.(n);
        const runOne = async (idx: number): Promise<[number, string]> => {
          const td = tasks[idx];
          const isObj = typeof td === "object" && td !== null;
          const t = isObj ? String((td as Record<string, unknown>).task || "") : String(td);
          const m = isObj ? String((td as Record<string, unknown>).model || "") : "";
          const tl = isObj ? String((td as Record<string, unknown>).tools || "") : "";
          const sk = isObj ? String((td as Record<string, unknown>).skill || "") : "";
          const label = sk ? `[${sk}] ${t}` : t;
          const t0 = Date.now();
          try {
            const r = await this._runSubagent(t, m || undefined, tl || undefined, sk || undefined, idx + 1, n);
            if (this.term) this.term.subagentDone?.(idx + 1, n, true, Date.now() - t0);
            // 更新最后一条结果的延迟
            if (this._subagentResults.length > 0) this._subagentResults[this._subagentResults.length - 1].latencyMs = Date.now() - t0;
            return [idx, r || "(子代理未返回结果)"];
          } catch (e) {
            if (this.term) this.term.subagentDone?.(idx + 1, n, false, Date.now() - t0);
            return [idx, `(x) 子代理执行失败: ${e}`];
          }
        };
        // 并行执行所有子代理
        const settled = await Promise.all(tasks.map((_, i) => runOne(i)));
        const results: string[] = new Array(n).fill("");
        for (const [idx, r] of settled) results[idx] = r;

        const lines: string[] = [];
        for (let i = 0; i < n; i++) {
          const td = tasks[i];
          const isObj = typeof td === "object" && td !== null;
          const t = isObj ? String((td as Record<string, unknown>).task || "") : String(td);
          lines.push(`[子代理 ${i + 1}/${n}]`);
          lines.push(`任务: ${t}`);
          if (isObj) {
            const obj = td as Record<string, unknown>;
            if (obj.tools) lines.push(`工具限制: ${obj.tools}`);
            if (obj.skill) lines.push(`预载技能: ${obj.skill}`);
          }
          lines.push("---");
          lines.push(results[i]);
          lines.push("");
        }
        // 输出摘要表
        if (this.term && n > 1) {
          this.term.write(`\n  ${Terminal_DIM}📊 子代理结果摘要:${Terminal_RESET}\n`);
          this.term.write(`  ${Terminal_GRAY}┌─────┬──────────────────────────┬──────┬──────────┐${Terminal_RESET}\n`);
          this.term.write(`  ${Terminal_GRAY}│ #   │ 任务                     │ 状态 │ 耗时     │${Terminal_RESET}\n`);
          this.term.write(`  ${Terminal_GRAY}├─────┼──────────────────────────┼──────┼──────────┤${Terminal_RESET}\n`);
          const recent = this._subagentResults.slice(-n);
          for (const r of recent) {
            const taskShort = r.task.slice(0, 24).padEnd(24);
            const status = r.success ? `${Terminal_GREEN}✓${Terminal_RESET}   ` : `${Terminal_RED}✗${Terminal_RESET}   `;
            const time = `${(r.latencyMs / 1000).toFixed(1)}s`.padEnd(8);
            this.term.write(`  ${Terminal_GRAY}│${Terminal_RESET} ${r.id}   ${Terminal_GRAY}│${Terminal_RESET} ${taskShort} ${Terminal_GRAY}│${Terminal_RESET} ${status} ${Terminal_GRAY}│${Terminal_RESET} ${time} ${Terminal_GRAY}│${Terminal_RESET}\n`);
          }
          this.term.write(`  ${Terminal_GRAY}└─────┴──────────────────────────┴──────┴──────────┘${Terminal_RESET}\n`);
          this.term.write(`  ${Terminal_DIM}用 /subagents 查看详情${Terminal_RESET}\n`);
        }
        return lines.join("\n").trim();
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

  /**
   * 根据用户查询内容自动注入相关技能到上下文。
   * 当检测到 Office 相关关键词时，注入对应的设计技能。
   */
  private _autoInjectSkills(query: string): void {
    if (!this._skillMgr) return;
    const lowerQuery = query.toLowerCase();
    // 检测 Office 相关关键词
    const officeKeywords: Record<string, string[]> = {
      'officecli-pptx': ['.pptx', 'pptx', 'powerpoint', 'ppt', '幻灯片', '演示文稿', 'slides', 'deck'],
      'officecli-xlsx': ['.xlsx', 'xlsx', 'excel', '电子表格', '工作表', 'spreadsheet', 'workbook'],
      'officecli-docx': ['.docx', 'docx', 'word', '文档', '报告', 'document', 'report', 'memo'],
    };
    const injected = new Set<string>();
    for (const [skillName, keywords] of Object.entries(officeKeywords)) {
      if (keywords.some(kw => lowerQuery.includes(kw))) {
        const skill = this._skillMgr.get(skillName);
        if (skill && !injected.has(skillName)) {
          // 注入技能 prompt 作为 system 消息（在用户消息之前）
          const prompt = skill.toPrompt();
          // 只注入前 4000 字符避免上下文膨胀
          const truncated = prompt.length > 4000 ? prompt.slice(0, 4000) + '\n...(技能内容已截断，完整内容请用 /skill 查看)' : prompt;
          this.ctx.push({ role: 'system', content: truncated });
          injected.add(skillName);
        }
      }
    }
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
      system: this.config.systemPrompt
        ? this.config.systemPrompt
        : DEFAULT_SYSTEM + `\n\n[身份信息] 你是 Cortex Agent，当前底层模型: ${this.config.model}。`,
      workDir: this.config.workDir,
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
      compactInputPct: this.config.compactInputPct,
      compactKeepRecent: this.config.compactKeepRecent,
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
  get subagentResults(): SubagentResult[] { return this._subagentResults; }

  get contextLimit(): number { return this.config.contextLimit; }
  get contextMessages(): number { return this.ctx.length; }
  get maxInputTokens(): number { return this.governor.maxInputTokens; }
  get maxTokens(): number { return this.config.maxTokens; }
  get inputTokensPct(): number { return this.governor.inputTokensPct(this.ctx); }

  /** @internal Public for CLI access — matches Python's public attribute */
  get sessions(): SessionStore | null { return this._sessions; }
  get memoryStore(): MemoryStore | null { return this._memory; }
  /** CLI 别名 — /memory 和 /forget 命令通过 agent.memory 访问 */
  get memory(): MemoryStore | null { return this._memory; }

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

  /**
   * 切换模型提供商（apiKey/baseUrl/model 全量切换）并持久化到 settings.json。
   * @param provider 提供商 id（deepseek/openai/glm/anthropic，须在 settings.providers 中配置了 api_key）
   * @param alias 模型别名（缺省用该提供商 models 的第一个）
   * @returns 成功返回描述；失败返回以 (x) 开头的错误提示
   */
  switchProvider(provider: string, alias?: string): string {
    const pid = provider.toLowerCase().trim();
    // 读取 settings.json 中已配置的提供商
    let pcfg: { api_key?: string; base_url?: string; models?: Record<string, string> } | undefined;
    try {
      const { loadSettings } = require("../config.js");
      const settings = loadSettings();
      pcfg = (settings.providers || {})[pid];
    } catch { /* ignore */ }
    const known = ["deepseek", "openai", "glm", "anthropic"];
    if (!pcfg && !known.includes(pid)) {
      return `(x) 未知提供商: ${pid}\n已知: ${known.join(", ")}（需在 settings.json providers 中配置 api_key）`;
    }
    if (!pcfg || !pcfg.api_key) {
      return `(x) 提供商 ${pid} 未配置 API Key\n请在 ~/.cortx/settings.json 的 providers.${pid}.api_key 填入 Key`;
    }
    const models = pcfg.models || {};
    // 别名解析两级查找：settings models 映射 → 内置 DEFAULT_PROVIDERS 全量映射（向导只写一个模型，内置表更全）
    const builtinModels: Record<string, string> = DEFAULT_PROVIDERS_LLM[pid]?.models || {};
    const lookup = { ...builtinModels, ...models };
    const effectiveAlias = alias && lookup[alias] ? alias : (Object.keys(models)[0] || Object.keys(builtinModels)[0]);
    if (!effectiveAlias) {
      return `(x) 提供商 ${pid} 未配置 models 映射\n请在 settings.json 的 providers.${pid}.models 中定义别名 → 模型名`;
    }
    const modelName = lookup[effectiveAlias];
    // 重建 LLMProvider（apiKey/baseUrl/model/protocol 全量切换；工具 schema 不变）
    const baseUrl = pcfg.base_url || this.config.baseUrl;
    const protocol = (pcfg as { protocol?: string }).protocol as import("./llm.js").ProtocolKind | undefined;
    this.llm = new LLMProvider({
      apiKey: pcfg.api_key,
      baseUrl,
      model: modelName,
      tools: registry.schemaList,
      timeout: this.config.thinkTimeout,
      maxTokens: this.config.maxTokens,
      protocol,
    });
    this.config.model = modelName;
    this.config.apiKey = pcfg.api_key;
    this.config.baseUrl = baseUrl;
    // 更新能力 + governor（与 switchModel 一致）
    const caps = resolveCapabilities(modelName);
    this.config.contextLimit = caps.contextWindow;
    this.config.maxTokens = caps.maxOutputTokens;
    this.llm.updateMaxTokens(this.config.maxTokens);
    this._makeGovernor();
    // 持久化到 settings.json（下次启动生效）
    try {
      const fsMod = require("fs");
      const pathMod = require("path");
      const userPath = pathMod.join(require("os").homedir(), ".cortx", "settings.json");
      if (fsMod.existsSync(userPath)) {
        const data = JSON.parse(fsMod.readFileSync(userPath, "utf-8"));
        data.provider = pid;
        data.model = effectiveAlias;
        fsMod.writeFileSync(userPath, JSON.stringify(data, null, 2), "utf-8");
      }
    } catch { /* 持久化失败不阻断切换 */ }
    return `✅ 已切换 → ${pid}/${effectiveAlias} (${modelName})`;
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
    this._screenshotStreak = 0; // 重置截图计数器
    this._lastToolSig = "";
    this._repeatCount = 0;
    // ── Auto-inject relevant skills based on user query ──
    this._autoInjectSkills(query);
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

      // 上下文压缩（token 预算驱动；低于预算时 govern 零触碰）
      const beforeLen = this.ctx.length;
      this.ctx = this.governor.govern(this.ctx);
      if (this.term && this.ctx.length < beforeLen) {
        this.term.write(`  \x1b[90m[上下文已压缩: ${beforeLen}→${this.ctx.length}条]\x1b[0m\n`);
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
      // govern: 低于 token 预算时零触碰（append-only，前缀缓存全命中）；
      // 达到预算才一次性 compact
      const beforeLen = this.ctx.length;
      this.ctx = this.governor.govern(this.ctx);
      if (this.term && this.ctx.length < beforeLen) {
        this.term.write(`\n  \x1b[90m[上下文已压缩: ${beforeLen}→${this.ctx.length}条]\x1b[0m\n`);
      }
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

        // ── 循环检测：相同工具+参数连续调用时警告或拦截 ──
        const toolSig = tc.name + ":" + JSON.stringify(tc.args);
        if (toolSig === this._lastToolSig) {
          this._repeatCount++;
          if (this._repeatCount >= 5) {
            ok = false;
            reason = `(x) [循环检测] ${tc.name} 已连续相同调用 ${this._repeatCount} 次，疑似陷入循环。请换一种方法或检查之前的错误。`;
            this._repeatCount = 0;
            this._lastToolSig = "";
            const latency0 = Date.now() - t0;
            if (this.term) this.term.toolDone(false, latency0, reason);
            this.ctx.push({ role: "tool", tool_call_id: tc.id, content: this.governor.finalizeToolResult(reason) });
            continue;
          }
        } else {
          this._repeatCount = 0;
        }
        this._lastToolSig = toolSig;

        // ── 架构安全网：子代理（depth>0）不能派遣子代理 ──
        // 正常情况下子代理的工具 schema 中不包含这些工具，LLM 不会调用。
        // 这里是最后的安全网，防止任何边界情况。
        if (this._depth > 0 && (tc.name === "spawn_subagent" || tc.name === "spawn_subagents")) {
          ok = false;
          reason = `(x) 架构限制：子代理（深度 ${this._depth}）不能派遣子代理。请自己完成任务。`;
        }
        // ── 工具白名单/黑名单过滤 ──
        else if (this._allowedTools && !this._allowedTools.has(tc.name)) {
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
        // ── 截图循环检测：文本模型无法识图，连续截图时注入警告 ──
        if (tc.name === "browser_screenshot" || tc.name === "computer_screenshot") {
          this._screenshotStreak++;
          if (this._screenshotStreak >= 3) {
            result += `\n\n⚠️ [系统警告] 你已连续截图 ${this._screenshotStreak} 次，但文本模型无法识别图片内容。`
              + `请立即切换到文本验证方式：browser_snapshot() 获取页面文本、check_server_status() 验证服务、read_file/grep 检查代码。`;
          }
        } else {
          this._screenshotStreak = 0;
        }
        // 写入时定长压缩（一次性；写入后字节不变 → 前缀缓存稳定）
        this.ctx.push({ role: "tool", tool_call_id: tc.id, content: this.governor.finalizeToolResult(result) });
      }

      // ── Checkpoint: auto-save every N steps ──
      if (this.config.checkpointInterval > 0 &&
        stepNo % this.config.checkpointInterval === 0 &&
        this.sessionId && this._sessions) {
        this._autoSave();
      }
      // 上下文压缩由循环头部的 govern() 按 token 预算统一触发（不再按条数）

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

    // 非瞬态错误（认证/模型不存在）提前退出，避免无意义的级联重试
    if (/401|403|invalid_api_key|model_not_found|authentication/i.test(this.lastLlmError)) {
      return { text: null, toolCalls: null, reasoning: "" };
    }

    // ── Level 2: 关闭推理模式（解决 finishReason=length） ──
    await new Promise(r => setTimeout(r, 500));
    try {
      const { text, toolCalls } = await doCallWithRetry(false);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning: "" };
      }
    } catch (e: any) { this.lastLlmError = `[L2] ${e?.message || e}`; /* fall through */ }

    // ── Level 3: 压缩上下文后重试（减少输入 token 压力） ──
    await new Promise(r => setTimeout(r, 500));
    const compressedCtx = this.governor.compact([...this.ctx], 8);  // 强制压缩一轮
    try {
      const { text, toolCalls } = await doCallWithRetry(false, compressedCtx);
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
      const { text, toolCalls, reasoning } = await doCallWithRetry(false);
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
