/**
 * Cortex Agent — Agentic Loop 引擎
 * 与 Python cortex_agent.py 完全对应: Think → Guard → Act → Reflect
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  AgentConfig, DEFAULT_CONFIG, Capability, AuditVerdict,
  Message, RunTrace, StepRecord, CacheStats,
} from './types.js';
import { registry } from './registry.js';
import { PolicyEngine } from './policy.js';
import { LLMProvider, ParsedToolCall } from './llm.js';

// ── 默认系统提示 ──
const DEFAULT_SYSTEM = [
  "你是 Cortex Agent，一个具备工具调用能力的 AI 助手。",
  "",
  "== 安全边界 ==",
  "1. 不得执行可能危害系统安全、泄露数据或破坏系统完整性的操作。",
  "2. 文件操作限于工作目录，不得修改系统配置或系统服务。",
  "3. 不得将文件内容通过外部网络发送。",
  "4. 不得读取系统敏感文件。",
  "5. 不得使用编码命令或混淆方式执行 shell。",
  "",
  "你有多种工具可用——文件读写、代码执行、网络搜索、数据库查询等。",
  "每次行动前先思考需要什么信息、哪个工具最合适。",
  "观察工具返回的结果（包括错误），据此调整后续行动，无需等待指令。",
].join("\n");

// ── ContextGovernor ──
class ContextGovernor {
  static TOKENS_PER_CHAR = 0.4;
  system: Message;
  maxMsgs: number;
  contextLimit: number;

  constructor(opts: {
    system?: string; workDir?: string; maxMsgs?: number;
    memoryContext?: string; historySummary?: string;
    kbContext?: string; contextLimit?: number;
  }) {
    const parts: string[] = [opts.system || DEFAULT_SYSTEM];
    if (opts.kbContext) parts.push(`\n[项目知识库]\n${opts.kbContext}`);
    if (opts.memoryContext) parts.push(`\n${opts.memoryContext}`);
    if (opts.historySummary) parts.push(`\n${opts.historySummary}`);
    if (opts.workDir) parts.push(`\n工作目录: ${opts.workDir}`);
    this.system = { role: "system", content: parts.join("\n") };
    this.maxMsgs = opts.maxMsgs || 24;
    this.contextLimit = opts.contextLimit || 1_000_000;
  }

  init(query: string): Message[] {
    return [this.system, { role: "user", content: query }];
  }

  appendUser(ctx: Message[], query: string): Message[] {
    ctx.push({ role: "user", content: query });
    return ctx;
  }

  govern(msgs: Message[]): Message[] {
    if (msgs.length <= this.maxMsgs) return msgs;
    const limit = this.maxMsgs - 1;
    let reserve = new Set<number>();
    let hasPair = false;
    for (let i = msgs.length - 1; i > 1; i--) {
      if (msgs[i].role === "tool" && msgs[i - 1].tool_calls) {
        reserve = new Set([i - 1, i]);
        hasPair = true;
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
    return [msgs[0], ...kept];
  }

  static estimateTokens(msgs: Message[]): number {
    let total = 0;
    for (const m of msgs) {
      let content = m.content || "";
      if (m.tool_calls) content += JSON.stringify(m.tool_calls);
      total += Math.floor(content.length * ContextGovernor.TOKENS_PER_CHAR);
    }
    return Math.max(total, 1);
  }

  static contextPct(msgs: Message[], limit: number): number {
    return Math.min(Math.floor(ContextGovernor.estimateTokens(msgs) / limit * 100), 99);
  }

  static loadKb(projectDir: string): string {
    const kbPath = path.join(projectDir, "CORTEX.md");
    if (fs.existsSync(kbPath)) {
      try {
        return fs.readFileSync(kbPath, "utf-8");
      } catch { /* ignore */ }
    }
    return "";
  }
}

// ── Observer ──
class Observer {
  traces: RunTrace[] = [];

  createTrace(query: string): RunTrace {
    const t: RunTrace = {
      query,
      steps: [],
      startTime: Date.now(),
      finalAnswer: "",
      stepLimitReached: false,
      error: "",
    };
    this.traces.push(t);
    return t;
  }

  record(
    trace: RunTrace, step: number, name: string, args: Record<string, unknown>,
    result: string, success: boolean, cap: string, latencyMs: number,
  ): void {
    trace.steps.push({
      step,
      timestamp: Date.now(),
      toolName: name,
      toolArgs: args,
      resultPreview: result.slice(0, 200),
      success,
      riskLevel: "",
      capability: cap,
      latencyMs,
    });
  }
}

// ── ToolExecutor ──
class ToolExecutor {
  static MAX_RESULT_CHARS = 3000;
  private workDir: string;
  private timeout: number;

  constructor(workDir: string, timeout: number) {
    this.workDir = workDir;
    this.timeout = timeout;
  }

  execute(name: string, args: Record<string, unknown>): string | Promise<string> {
    const fn = registry.get(name);
    if (!fn) return `(x) 未知工具: ${name}`;
    try {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (k !== "workDir") clean[k] = v;
      }
      const result = fn(this.workDir, clean);
      if (result instanceof Promise) {
        return result.then((r) => this.truncate(String(r)));
      }
      return this.truncate(String(result));
    } catch (e: unknown) {
      return `(x) ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private truncate(result: string): string {
    if (result.length > ToolExecutor.MAX_RESULT_CHARS) {
      return result.slice(0, ToolExecutor.MAX_RESULT_CHARS) + `\n\n[...已截断，原${result.length}字符]`;
    }
    return result;
  }
}

// ── CortexAgent ──
export class CortexAgent {
  config: AgentConfig;
  private policy: PolicyEngine;
  private executor: ToolExecutor;
  llm: LLMProvider;
  private governor!: ContextGovernor;
  private observer = new Observer();
  private ctx: Message[] = [];
  private trace: RunTrace | null = null;
  private rejectionCounts = new Map<Capability, number>();
  private suspendedCaps = new Set<Capability>();
  private permissionDecisions = new Map<string, boolean>();
  private sessionId: string | null = null;

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const wd = path.resolve(this.config.workDir);
    fs.mkdirSync(wd, { recursive: true });

    this.policy = new PolicyEngine(wd, { permissionMode: this.config.permissionMode });
    this.executor = new ToolExecutor(wd, this.config.toolTimeout);
    this.llm = new LLMProvider({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      model: LLMProvider.resolve(this.config.model),
      tools: registry.schemaList,
      timeout: this.config.thinkTimeout,
    });
    this._makeGovernor();
  }

  private _makeGovernor(): void {
    const kb = ContextGovernor.loadKb(process.cwd());
    this.governor = new ContextGovernor({
      system: this.config.systemPrompt,
      workDir: this.config.workDir,
      maxMsgs: this.config.maxContextMsgs,
      kbContext: kb,
      contextLimit: this.config.contextLimit,
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

  get lastTrace(): RunTrace | null { return this.trace; }

  async run(query: string, maxSteps?: number, keepHistory = false): Promise<string> {
    if (!keepHistory || this.ctx.length === 0) {
      this.ctx = this.governor.init(query);
    } else {
      this.ctx = this.governor.appendUser(this.ctx, query);
    }
    const result = await this._loop(maxSteps || this.config.maxSteps);
    return result ?? "";
  }

  reset(): void {
    this.ctx = [];
    this.rejectionCounts.clear();
    this.suspendedCaps.clear();
    this.permissionDecisions.clear();
    this.trace = null;
  }

  private async _loop(maxSteps: number): Promise<string> {
    this.trace = this.observer.createTrace(this.ctx[this.ctx.length - 1]?.content || "");

    for (let stepNo = 1; stepNo <= maxSteps; stepNo++) {
      this.ctx = this.governor.govern(this.ctx);
      const { text, toolCalls, reasoning } = await this._think();
      if (text === null && !toolCalls) {
        this.trace.error = "LLM 调用失败";
        return this.trace.error;
      }
      if (!toolCalls) {
        const finalText = text || "";
        this.ctx.push({ role: "assistant", content: finalText });
        this.trace!.finalAnswer = finalText;
        return finalText;
      }

      // Tool calls
      this.ctx.push({
        role: "assistant",
        content: text || "",
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tc of toolCalls) {
        const t0 = Date.now();
        const meta = registry.meta(tc.name);
        const capStr = meta?.capability || "?";
        const cap = meta?.capability || null;

        // Guard
        let ok: boolean;
        let reason: string;
        if (cap && this.suspendedCaps.has(cap)) {
          ok = false; reason = `能力 ${cap} 已被暂停`;
        } else {
          [ok, reason] = this.policy.audit(tc.name, tc.args);
        }

        // CONFIRM → auto-deny in non-interactive
        if (!ok && reason === "confirm") {
          ok = false; reason = "用户拒绝";
        }

        // Adaptive guard
        if (!ok && cap && !reason.includes("用户")) {
          const cnt = (this.rejectionCounts.get(cap) || 0) + 1;
          this.rejectionCounts.set(cap, cnt);
          if (cnt >= 3) {
            this.suspendedCaps.add(cap);
            reason = `(x) [Policy 拦截] ${cap} 能力已被暂停（连续 ${cnt} 次违规）`;
          } else {
            reason = `(x) [Policy 拦截] ${reason}`;
          }
        }

        let result: string;
        if (!ok) {
          result = reason;
        } else {
          result = await Promise.resolve(this.executor.execute(tc.name, tc.args));
        }

        const latency = Date.now() - t0;
        this.observer.record(this.trace, stepNo, tc.name, tc.args, result, ok, capStr, latency);
        this.ctx.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      const convergence = this._reflect(this.trace, stepNo, maxSteps);
      if (convergence !== null) return convergence;
    }

    this.trace.stepLimitReached = true;
    return "[超步数] 未能完成";
  }

  private _reflect(trace: RunTrace, stepNo: number, maxSteps: number): string | null {
    // 结构性收敛：末步给予最终回答机会（不注入行为指令）
    return null;
  }

  private async _think(): Promise<{ text: string | null; toolCalls: ParsedToolCall[] | null; reasoning: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await this.llm.call(this.ctx);
        return { text: resp.text || null, toolCalls: resp.toolCalls, reasoning: resp.reasoning };
      } catch (e) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return { text: null, toolCalls: null, reasoning: "" };
  }
}

// 导出 LLMProvider 供 CLI 使用
export { LLMProvider } from './llm.js';
