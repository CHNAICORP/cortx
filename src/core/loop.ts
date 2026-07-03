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
import { LLMProvider, ParsedToolCall } from './llm.js';
export { LLMProvider } from './llm.js';
import { MemoryStore, SessionStore } from './memory_store.js';

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
  "联网搜索或查询实时信息前，先调用 get_current_time 获取当前时间以确保时效性。\n"
    + "搜索时务必将获取到的具体年份和月份直接写入搜索关键词中（例如搜 '2026年7月 TypeScript 最新版本' 而非 'TypeScript 最新版本'），"
    + "否则搜索结果可能过期。",
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
    const est = ContextGovernor.estimateTokens(msgs);
    return Math.min(Math.floor(est / limit * 100), 99);
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

  govern(msgs: Message[]): Message[] {
    if (msgs.length <= this.maxMsgs) return msgs;
    const limit = this.maxMsgs - 1;
    // Guard against corrupt contexts with very low maxMsgs
    if (limit <= 0) {
      // Keep system + last message
      return [msgs[0], msgs[msgs.length - 1]];
    }
    let reserve: Set<number> = new Set();
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
    if (kept.length === 0) {
      kept.push(msgs[msgs.length - 1]);
    }
    return [msgs[0], ...kept];
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
class ToolExecutor {
  static MAX_RESULT_CHARS = 3000;
  private reg: typeof registry;
  private workDir: string;
  private timeout: number;

  constructor(workDir: string, timeout = 10) {
    this.reg = registry;
    this.workDir = workDir;
    this.timeout = timeout;
  }

  execute(name: string, args: Record<string, unknown>): string | Promise<string> {
    const fn = this.reg.get(name);
    if (!fn) return `(x) 未知工具: ${name}`;
    try {
      const result = fn(this.workDir, args);
      if (result instanceof Promise) {
        return result.then(r => this.truncate(r));
      }
      return this.truncate(result);
    } catch (e) {
      return `(x) ${e}`;
    }
  }

  private truncate(result: string): string {
    if (result.length > ToolExecutor.MAX_RESULT_CHARS) {
      return result.slice(0, ToolExecutor.MAX_RESULT_CHARS) + `\n\n[...已截断，原${result.length}字符]`;
    }
    return result;
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
  private rejectionCounts = new Map<Capability, number>();
  private suspendedCaps = new Set<Capability>();
  private permissionDecisions = new Map<string, boolean>();
  private sessionId: string | null = null;
  private queryCount = 0;
  private stepCountTotal = 0;
  private _memory: MemoryStore | null = null;
  private _sessions: SessionStore | null = null;
  private term: {
    thinkToken: (t: string) => void;
    answerToken: (t: string) => void;
    toolStart: (n: string, a: Record<string, unknown>) => void;
    toolDone: (ok: boolean, ms: number, p: string) => void;
    closeThinking: () => void;
    nextRound: () => void;
    write: (s: string) => void;
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
    this.executor = new ToolExecutor(wd, this.config.toolTimeout);

    // ── 记忆 + 会话存储 ──
    const memoryPath = this.config.memoryDir || path.join(wd, "memory.md");
    const sessionsDir = this.config.sessionsDir || path.join(wd, "sessions");
    this._memory = this.config.memoryEnabled ? new MemoryStore(memoryPath) : null;
    this._sessions = this.config.sessionsEnabled ? new SessionStore(sessionsDir) : null;

    this.llm = new LLMProvider({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      model: LLMProvider.resolve(this.config.model),
      tools: registry.schemaList,
      timeout: this.config.thinkTimeout,
      maxTokens: this.config.maxTokens,
    });
    this._makeGovernor();
  }

  private _makeGovernor(): void {
    const kb = ContextGovernor.loadKb(process.cwd());
    const memoryCtx = this._memory?.toSystemContext() || "";
    const historySummary = (this._sessions && this.sessionId)
      ? (this._sessions.getHistorySummary(this.sessionId) || "") : "";
    this.governor = new ContextGovernor({
      system: this.config.systemPrompt,
      workDir: this.config.workDir,
      maxMsgs: this.config.maxContextMsgs,
      memoryContext: memoryCtx,
      historySummary: historySummary,
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
    const sid = sessionId || (this._sessions?.generateId() || "default");
    this.sessionId = sid;
    this.queryCount = 0;
    this.stepCountTotal = 0;
    this.ctx = [];
    return sid;
  }

  get sessionIdStr(): string | null { return this.sessionId; }

  get lastTrace(): RunTrace | null { return this.trace; }

  get contextLimit(): number { return this.config.contextLimit; }

  /** @internal Public for CLI access — matches Python's public attribute */
  get sessions(): SessionStore | null { return this._sessions; }
  get memoryStore(): MemoryStore | null { return this._memory; }

  switchModel(alias: string): void {
    this.llm.switch(alias); this.config.model = this.llm.model;
  }

  switchPermissionMode(mode: string): string {
    const m = mode.toLowerCase().trim();
    if (["s", "std", "standard"].includes(m)) {
      this.config.permissionMode = "standard";
      return "standard — SAFE自动 / WRITE区内 / SYSTEM需确认";
    } else if (["a", "auto", "auto-edit", "edit"].includes(m)) {
      this.config.permissionMode = "auto";
      return "auto — 自动批准编辑 + SYSTEM放行";
    } else if (["y", "yolo", "full", "bypass"].includes(m)) {
      this.config.permissionMode = "yolo";
      return "yolo — 全部放行（⚠️ 路径穿越不设防）";
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
   * Auto-extract key facts from the current exchange so they persist
   * across sessions.  Uses a lightweight heuristic rather than a full LLM
   * call (the Python side stubs this to a pass).  We capture:
   *   - Explicit remember_fact calls that went through the executor
   *   - The query itself as a session bookmark
   *   - Key search/fetch results as condensed memory entries
   */
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
    for (let stepNo = 1; stepNo <= maxSteps; stepNo++) {
      this.ctx = this.governor.govern(this.ctx);
      const { text, toolCalls, reasoning } = await this._think();
      if (text === null && !toolCalls) {
        this.trace.error = "LLM 调用失败（空响应，已重试3次+注入提示）";
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
        if (cap && this.suspendedCaps.has(cap)) {
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
        if (!ok) { result = reason; }
        else { result = await Promise.resolve(this.executor.execute(tc.name, tc.args)); }

        const latency = Date.now() - t0;
        if (this.term) this.term.toolDone(ok, latency, result);
        this.observer.record(this.trace, stepNo, tc.name, tc.args, result, ok, capStr, latency);
        this.ctx.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      const convergence = await this._reflect(this.trace, stepNo, maxSteps);
      if (convergence !== null) return convergence;
    }
    this.trace.stepLimitReached = true;
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
     * Think 阶段 — 调用 LLM，带渐进降级恢复。
     *
     * 3 级降级策略（每级改变策略，不做无意义重试）:
     *   Level 1: thinking=true  — 正常推理模式
     *   Level 2: thinking=false — 关闭推理，全部 token 留给 content/tool_calls
     *   Level 3: thinking=false + nudge — 注入提示消息强制生成回答
     */

    const doCall = async (thinking: boolean = true) => {
      if (this.term) {
        return this.llm.callStream(this.ctx,
          t => this.term!.thinkToken(t),
          t => this.term!.answerToken(t),
          thinking,
        );
      }
      return this.llm.call(this.ctx, thinking);
    };

    // ── Level 1: 正常推理模式 ──
    try {
      const { text, toolCalls, reasoning } = await doCall(true);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning };
      }
    } catch { /* fall through */ }

    // ── Level 2: 关闭推理模式（解决 finishReason=length） ──
    await new Promise(r => setTimeout(r, 500));
    try {
      const { text, toolCalls } = await doCall(false);
      if (text || toolCalls) {
        return { text, toolCalls, reasoning: "" };
      }
    } catch { /* fall through */ }

    // ── Level 3: 关闭推理 + 注入 nudge ──
    await new Promise(r => setTimeout(r, 500));
    const nudge: Message = { role: "user", content: "请根据以上工具返回的信息，直接给出你的回答。" };
    this.ctx.push(nudge);
    try {
      const { text, toolCalls, reasoning } = await doCall(false);
      this.ctx.pop();
      if (text || toolCalls) {
        return { text, toolCalls, reasoning };
      }
    } catch { /* ignore */ }
    this.ctx.pop();

    return { text: null, toolCalls: null, reasoning: "" };
  }
}
