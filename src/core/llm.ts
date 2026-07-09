/**
 * LLM Provider — DeepSeek / OpenAI / GLM（智谱）/ Anthropic（Claude）流式 + 非流式
 * 与 Python llm.py 完全对应
 *
 * Anthropic Claude 使用独立的 Messages API（非 OpenAI 兼容格式），
 * 内部自动完成 OpenAI ↔ Anthropic 消息格式转换。
 */
import { Message, FunctionSchema, CacheStats } from './types.js';

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  tools: FunctionSchema[];
  timeout: number;
  maxTokens: number;
}

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type { ParsedToolCall };

interface LLMResponse {
  text: string;
  toolCalls: ParsedToolCall[] | null;
  reasoning: string;
  finishReason: string;
}

interface ProviderCfg { baseUrl: string; models: Record<string, string>; }

const DEFAULT_PROVIDERS: Record<string, ProviderCfg> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: {
      // ── GPT-5.4 系列 (最新旗舰) ──
      "5.4":       "gpt-5.4",
      "5.4-mini":  "gpt-5.4-mini",
      // ── GPT-5.2 系列 ──
      "5.2":       "gpt-5.2",
      "5.2-pro":   "gpt-5.2-pro",
      // ── GPT-4.1 系列 (1M 上下文) ──
      "4.1":       "gpt-4.1",
      "4.1-mini":  "gpt-4.1-mini",
      // ── 经典 ──
      "4o":        "gpt-4o",
      "4o-mini":   "gpt-4o-mini",
    },
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: {
      "5.2":       "glm-5.2",
      "5.1":       "glm-5.1",
      "turbo":     "glm-5-turbo",
      "4.7":       "glm-4.7",
      "4.7-flash": "glm-4.7-flash",
      "4-long":    "glm-4-long",
    },
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    models: {
      // ── 最新旗舰系列 ──
      fable:    "claude-fable-5",        // Fable 5 — 最强旗舰
      mythos:   "claude-mythos-5",       // Mythos 5 — 新一代推理
      sonnet:   "claude-sonnet-5",       // Sonnet 5 — 均衡高效
      // ── Opus 系列 ──
      opus:     "claude-opus-4-8",       // Opus 4.8 — 顶级编码
      "opus-pro": "claude-opus-4-7",     // Opus 4.7
      // ── 其他 ──
      haiku:    "claude-haiku-4-5",      // Haiku 4.5 — 快速轻量
    },
  },
};

// ── Model Capabilities Registry ──
// 每个模型的实际上下文窗口和最大输出 token 数。
// contextLimit=0 或 maxTokens=0 时自动从此注册表解析。
interface ModelCaps { contextWindow: number; maxOutputTokens: number; }

const MODEL_CAPABILITIES: Record<string, ModelCaps> = {
  // ── DeepSeek V4 系列 — 1M 上下文, 384K 最大输出 ──
  "deepseek-v4-flash":  { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  "deepseek-v4-pro":   { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  // ── GLM 系列 ──
  "glm-5.2":            { contextWindow: 1_000_000, maxOutputTokens: 8192 },   // 旗舰 1M
  "glm-5.1":            { contextWindow: 128_000,   maxOutputTokens: 8192 },
  "glm-5-turbo":        { contextWindow: 128_000,   maxOutputTokens: 8192 },
  "glm-5":              { contextWindow: 128_000,   maxOutputTokens: 8192 },
  "glm-4.7":            { contextWindow: 200_000,   maxOutputTokens: 8192 },
  "glm-4.7-flashx":    { contextWindow: 200_000,   maxOutputTokens: 8192 },
  "glm-4.7-flash":     { contextWindow: 200_000,   maxOutputTokens: 8192 },  // 免费
  "glm-4.5-air":        { contextWindow: 128_000,   maxOutputTokens: 8192 },
  "glm-4-long":         { contextWindow: 1_000_000, maxOutputTokens: 8192 },  // 1M 长文
  "glm-4-plus":         { contextWindow: 128_000,   maxOutputTokens: 8192 },
  // ── OpenAI GPT-5.x 系列 (最新) ──
  "gpt-5.4":            { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.4-mini":      { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.4-nano":      { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.2":            { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.2-pro":       { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.1":            { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.1-mini":      { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5.1-codex":     { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "gpt-5":              { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  "gpt-5-mini":        { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  "gpt-5-nano":        { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  // ── OpenAI GPT-4.1 系列 — 1M 上下文 ──
  "gpt-4.1":            { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  "gpt-4.1-mini":      { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  "gpt-4.1-nano":      { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  // ── OpenAI 推理模型 ──
  "o4-mini":            { contextWindow: 200_000,   maxOutputTokens: 100_000 },
  "o3":                { contextWindow: 200_000,   maxOutputTokens: 100_000 },
  "o3-mini":           { contextWindow: 200_000,   maxOutputTokens: 100_000 },
  // ── OpenAI 经典 ──
  "gpt-4o":             { contextWindow: 128_000,   maxOutputTokens: 16384 },
  "gpt-4o-mini":        { contextWindow: 128_000,   maxOutputTokens: 16384 },
  // ── Anthropic Claude 系列 ──
  // 旗舰系列 — 1M 上下文窗口
  "claude-fable-5":     { contextWindow: 1_000_000, maxOutputTokens: 32000 },
  "claude-mythos-5":    { contextWindow: 1_000_000, maxOutputTokens: 32000 },
  "claude-sonnet-5":    { contextWindow: 1_000_000, maxOutputTokens: 16000 },
  // Opus 系列 — 200K 上下文
  "claude-opus-4-8":    { contextWindow: 200_000,   maxOutputTokens: 32000 },
  "claude-opus-4-7":    { contextWindow: 200_000,   maxOutputTokens: 32000 },
  "claude-opus-4-6":    { contextWindow: 200_000,   maxOutputTokens: 32000 },
  "claude-opus-4-5":    { contextWindow: 200_000,   maxOutputTokens: 16000 },
  "claude-opus-4-1":    { contextWindow: 200_000,   maxOutputTokens: 8192 },
  // Sonnet 4.x — 1M 上下文（beta）
  "claude-sonnet-4-6":  { contextWindow: 1_000_000, maxOutputTokens: 16000 },
  "claude-sonnet-4-5":  { contextWindow: 1_000_000, maxOutputTokens: 16000 },
  // Haiku — 200K 上下文
  "claude-haiku-4-5":   { contextWindow: 200_000,   maxOutputTokens: 8192 },
  "claude-mythos-preview": { contextWindow: 200_000, maxOutputTokens: 16000 },
};

// 按前缀匹配的默认能力
const PREFIX_DEFAULTS: Array<[string, ModelCaps]> = [
  ["deepseek",  { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  ["glm",       { contextWindow: 128_000,   maxOutputTokens: 8192 }],
  ["gpt-5.4",   { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["gpt-5.2",   { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["gpt-5.1",   { contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  ["gpt-5",     { contextWindow: 1_000_000, maxOutputTokens: 32_000 }],
  ["gpt-4.1",   { contextWindow: 1_000_000, maxOutputTokens: 32_000 }],
  ["gpt-4",     { contextWindow: 128_000,   maxOutputTokens: 16384 }],
  ["gpt-3.5",   { contextWindow: 16_000,    maxOutputTokens: 4096 }],
  ["o4",        { contextWindow: 200_000,   maxOutputTokens: 100_000 }],
  ["o3",        { contextWindow: 200_000,   maxOutputTokens: 100_000 }],
  ["claude-fable",  { contextWindow: 1_000_000, maxOutputTokens: 32000 }],
  ["claude-mythos", { contextWindow: 1_000_000, maxOutputTokens: 32000 }],
  ["claude-sonnet", { contextWindow: 1_000_000, maxOutputTokens: 16000 }],
  ["claude-opus",   { contextWindow: 200_000,   maxOutputTokens: 32000 }],
  ["claude-haiku",  { contextWindow: 200_000,   maxOutputTokens: 8192 }],
];

const FALLBACK_CAPS: ModelCaps = { contextWindow: 128_000, maxOutputTokens: 8192 };

export function resolveCapabilities(model: string): ModelCaps {
  const m = model.toLowerCase().trim();
  if (MODEL_CAPABILITIES[m]) return MODEL_CAPABILITIES[m];
  for (const [prefix, caps] of PREFIX_DEFAULTS) {
    if (m.startsWith(prefix)) return caps;
  }
  return FALLBACK_CAPS;
}

let activeProvider = "deepseek";
let activeBaseUrl = "https://api.deepseek.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export function setupProviders(providers?: Record<string, ProviderCfg>, active?: string) {
  if (providers) Object.assign(DEFAULT_PROVIDERS, providers);
  if (active) {
    activeProvider = active;
    activeBaseUrl = DEFAULT_PROVIDERS[active]?.baseUrl || activeBaseUrl;
  }
}

export function resolveModel(name: string): string {
  const provider = DEFAULT_PROVIDERS[activeProvider];
  if (provider?.models[name]) return provider.models[name];
  for (const p of Object.values(DEFAULT_PROVIDERS)) {
    if (p.models[name]) return p.models[name];
  }
  return name;
}

export function isAnthropic(): boolean {
  return activeProvider === "anthropic";
}

export class LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  model: string;
  private tools: FunctionSchema[];
  private timeout: number;
  private maxTokens: number;

  /** 根据当前 provider 生成 thinking 参数。
   * GLM 使用 thinking_budget，DeepSeek/OpenAI 使用 reasoning_effort。
   * Anthropic 在 _callAnthropic 中独立处理。
   */
  private _thinkingBody(thinking: boolean): Record<string, unknown> {
    if (!thinking) return {};
    if (activeProvider === "glm") {
      return { extra_body: { thinking: { type: "enabled", thinking_budget: "max" } } };
    }
    if (activeProvider === "anthropic") {
      return {};  // Anthropic thinking 在 _callAnthropic 中处理
    }
    return { extra_body: { thinking: { type: "enabled" } }, reasoning_effort: "max" };
  }

  // 缓存统计
  private callCount = 0;
  private cacheHits = 0;
  private totalInputTokens = 0;
  private totalCachedTokens = 0;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.tools = config.tools;
    this.timeout = config.timeout;
    this.maxTokens = config.maxTokens;
  }

  get cacheStats(): CacheStats {
    return {
      calls: this.callCount,
      cacheHits: this.cacheHits,
      // 正确的平均缓存命中率 = 已缓存 token / 总输入 token
      hitRate: this.totalInputTokens > 0 ? (this.totalCachedTokens / this.totalInputTokens) * 100 : 0,
      totalInputTokens: this.totalInputTokens,
      totalCachedTokens: this.totalCachedTokens,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Anthropic Messages API 转换层
  // ══════════════════════════════════════════════════════════════

  private _convertToolsToAnthropic(): unknown[] {
    return this.tools.map(t => ({
      name: t.function?.name || "",
      description: t.function?.description || "",
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }));
  }

  private _convertMessagesToAnthropic(messages: Message[]): { system: string; msgs: unknown[] } {
    const systemParts: string[] = [];
    const anthropicMsgs: unknown[] = [];

    for (const msg of messages) {
      const role = msg.role;
      const content = msg.content || "";

      if (role === "system") {
        if (content) systemParts.push(content);
        continue;
      }

      if (role === "tool") {
        // OpenAI tool result → Anthropic user message with tool_result content block
        anthropicMsgs.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.tool_call_id || "",
            content: typeof content === "string" ? content : String(content),
          }],
        });
        continue;
      }

      if (role === "assistant") {
        const blocks: unknown[] = [];
        if (content) blocks.push({ type: "text", text: content });
        // Tool calls → tool_use blocks
        for (const tc of (msg.tool_calls || [])) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* malformed */ }
          blocks.push({
            type: "tool_use",
            id: tc.id || crypto.randomUUID(),
            name: tc.function?.name || "",
            input: args,
          });
        }
        if (blocks.length > 0) anthropicMsgs.push({ role: "assistant", content: blocks });
        continue;
      }

      if (role === "user") {
        anthropicMsgs.push({
          role: "user",
          content: typeof content === "string" ? content : String(content),
        });
        continue;
      }
    }

    return { system: systemParts.join("\n\n"), msgs: anthropicMsgs };
  }

  private _parseAnthropicResponse(data: Record<string, unknown>): LLMResponse {
    const contentBlocks = (data.content as Array<Record<string, unknown>>) || [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];
    const finishReason = (data.stop_reason as string) || "";

    for (const block of contentBlocks) {
      const btype = block.type as string;
      if (btype === "text") {
        textParts.push((block.text as string) || "");
      } else if (btype === "thinking") {
        reasoningParts.push((block.thinking as string) || "");
      } else if (btype === "tool_use") {
        toolCalls.push({
          id: (block.id as string) || "",
          name: (block.name as string) || "",
          args: (block.input as Record<string, unknown>) || {},
        });
      }
    }

    // 更新缓存统计
    this.callCount++;
    const usage = (data.usage as Record<string, number>) || {};
    this.totalInputTokens += usage.input_tokens || 0;
    const cached = usage.cache_read_input_tokens || 0;
    this.totalCachedTokens += cached;
    if (cached > 0) this.cacheHits++;

    return {
      text: textParts.join(""),
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      reasoning: reasoningParts.join(""),
      finishReason,
    };
  }

  /** 检查 HTTP 响应状态，非 2xx 抛出含状态码与错误信息的异常（避免静默吞掉 401/429/500）*/
  private async _checkHttp(resp: Response, label: string): Promise<void> {
    if (resp.ok) return;
    let detail = "";
    try { detail = JSON.stringify(await resp.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`${label} HTTP ${resp.status} ${resp.statusText}: ${detail}`);
  }

  private async _callAnthropic(messages: Message[], thinking: boolean): Promise<LLMResponse> {
    const { system, msgs } = this._convertMessagesToAnthropic(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: msgs,
    };
    if (system) body.system = system;
    if (this.tools.length > 0) body.tools = this._convertToolsToAnthropic();
    if (thinking) body.thinking = { type: "enabled", budget_tokens: Math.min(this.maxTokens, 16000) };

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    await this._checkHttp(resp, "Anthropic");
    const data = await resp.json() as Record<string, unknown>;
    return this._parseAnthropicResponse(data);
  }

  private async _callAnthropicStream(
    messages: Message[],
    onText?: (t: string) => void,
    onAnswer?: (t: string) => void,
    thinking: boolean = true,
    onTool?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<LLMResponse> {
    const { system, msgs } = this._convertMessagesToAnthropic(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: msgs,
      stream: true,
    };
    if (system) body.system = system;
    if (this.tools.length > 0) body.tools = this._convertToolsToAnthropic();
    if (thinking) body.thinking = { type: "enabled", budget_tokens: Math.min(this.maxTokens, 16000) };

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    await this._checkHttp(resp, "Anthropic-stream");
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBuf: Map<number, { id: string; name: string; argsJson: string }> = new Map();
    let reasoningDone = false;
    let toolSeen = false;
    let finishReason = "";
    let currentBlockType = "";
    let currentBlockIdx = -1;
    let anthropicInputTokens = 0;
    let anthropicCachedTokens = 0;

    if (!reader) return { text: "", toolCalls: null, reasoning: "", finishReason };

    let lineBuf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          const etype = evt.type as string;

          if (etype === "content_block_start") {
            const block = evt.content_block || {};
            currentBlockType = block.type || "";
            currentBlockIdx = evt.index ?? 0;
            if (currentBlockType === "tool_use") {
              if (!toolSeen && onTool) { onTool("", {}); toolSeen = true; }
              toolBuf.set(currentBlockIdx, {
                id: block.id || "",
                name: block.name || "",
                argsJson: "",
              });
            }
          } else if (etype === "content_block_delta") {
            const delta = evt.delta || {};
            const dtype = delta.type || "";

            if (dtype === "thinking_delta") {
              const text = delta.thinking || "";
              if (text) {
                reasoningParts.push(text);
                if (onText) onText(text);
              }
            } else if (dtype === "text_delta") {
              const text = delta.text || "";
              if (text) {
                if (!reasoningDone && onAnswer) { onAnswer(""); reasoningDone = true; }
                textParts.push(text);
                if (onAnswer) onAnswer(text);
              }
            } else if (dtype === "input_json_delta") {
              if (toolBuf.has(currentBlockIdx)) {
                const tb = toolBuf.get(currentBlockIdx)!;
                tb.argsJson += delta.partial_json || "";
              }
            }
          } else if (etype === "content_block_stop") {
            currentBlockType = "";
          } else if (etype === "message_start") {
            // Anthropic message_start 包含 input_tokens 和 cache_read_input_tokens
            const usage = evt.message?.usage || evt.usage || {};
            anthropicInputTokens = (usage.input_tokens as number) || 0;
            anthropicCachedTokens = (usage.cache_read_input_tokens as number) || 0;
          } else if (etype === "message_delta") {
            const delta = evt.delta || {};
            if (delta.stop_reason) finishReason = delta.stop_reason;
            // message_delta 可能包含更新后的 usage
            const usage = evt.usage || {};
            if (usage.input_tokens) anthropicInputTokens = usage.input_tokens;
            if (usage.cache_read_input_tokens) anthropicCachedTokens = usage.cache_read_input_tokens;
          } else if (etype === "message_stop") {
            // stream complete
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    this.callCount++;
    // 使用 Anthropic 流式返回的实际 token 数
    if (anthropicInputTokens > 0) {
      this.totalInputTokens += anthropicInputTokens;
      this.totalCachedTokens += anthropicCachedTokens;
      if (anthropicCachedTokens > 0) this.cacheHits++;
    } else {
      // fallback：估算
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      this.totalInputTokens += Math.floor(totalChars * 0.4);
    }

    const text = textParts.join("");
    const reasoning = reasoningParts.join("");
    let toolCalls: ParsedToolCall[] | null = null;
    if (toolBuf.size > 0) {
      toolCalls = [];
      for (const [, tb] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tb.argsJson || "{}"); } catch { /* malformed */ }
        toolCalls.push({ id: tb.id, name: tb.name, args });
      }
    }
    return { text, toolCalls, reasoning, finishReason };
  }

  // ══════════════════════════════════════════════════════════════
  // 统一调用入口 — 根据 provider 分发
  // ══════════════════════════════════════════════════════════════

  async call(messages: Message[], thinking = true): Promise<LLMResponse> {
    if (isAnthropic()) {
      return this._callAnthropic(messages, thinking);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      max_tokens: this.maxTokens,
    };
    Object.assign(body, this._thinkingBody(thinking));

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    await this._checkHttp(resp, "OpenAI");
    const data: Record<string, unknown> = await resp.json() as Record<string, unknown>;
    this.callCount++;
    if (data.usage) {
      const usage = data.usage as Record<string, unknown>;
      this.totalInputTokens += (usage.prompt_tokens as number) || 0;
      const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      const cached = (details?.cached_tokens as number) || 0;
      this.totalCachedTokens += cached;
      if (cached > 0) this.cacheHits++;
    }

    const choice = (data.choices as Array<{ message?: Record<string, unknown>; finish_reason?: string }>)?.[0];
    const msg = choice?.message;
    const text: string = (msg?.content as string) || "";
    const reasoning: string = (msg?.reasoning_content as string) || "";
    const finishReason: string = choice?.finish_reason || "";

    let toolCalls: ParsedToolCall[] | null = null;
    if (msg?.tool_calls) {
      toolCalls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>).map(tc => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* malformed JSON from LLM */ }
        return { id: tc.id, name: tc.function.name, args };
      });
    }

    return { text, toolCalls, reasoning, finishReason };
  }

  async callStream(
    messages: Message[],
    onText?: (t: string) => void,
    onAnswer?: (t: string) => void,
    thinking = true,
    onTool?: (name: string, args: Record<string, unknown>) => void,
  ): Promise<LLMResponse> {
    if (isAnthropic()) {
      return this._callAnthropicStream(messages, onText, onAnswer, thinking, onTool);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      max_tokens: this.maxTokens,
      stream: true,
    };
    Object.assign(body, this._thinkingBody(thinking));

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    await this._checkHttp(resp, "OpenAI-stream");
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBuf: Map<number, { id: string; name: string; argsJson: string }> = new Map();
    let reasoningDone = false;
    let toolSeen = false;
    let finishReason = "";
    let streamUsage: Record<string, unknown> | null = null;

    if (!reader) return { text: "", toolCalls: null, reasoning: "", finishReason };

    let lineBuf = "";  // 缓冲跨 chunk 的不完整 SSE 行
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      // 最后一个元素可能是不完整的行，保留到下次处理
      lineBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          // 提取 usage 信息（通常在最后一个 chunk）
          if (parsed.usage) streamUsage = parsed.usage;
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
            if (onText) onText(delta.reasoning_content);
          }
          if (delta.content) {
            if (!reasoningDone && onAnswer) { onAnswer(""); reasoningDone = true; }
            textParts.push(delta.content);
            if (onAnswer) onAnswer(delta.content);
          }
          if (delta.tool_calls) {
            if (!toolSeen && onTool) { onTool("", {}); toolSeen = true; }
            for (const tcd of delta.tool_calls) {
              const idx = tcd.index;
              if (!toolBuf.has(idx)) toolBuf.set(idx, { id: "", name: "", argsJson: "" });
              const tb = toolBuf.get(idx)!;
              if (tcd.id) tb.id = tcd.id;
              if (tcd.function?.name) tb.name += tcd.function.name;
              if (tcd.function?.arguments) tb.argsJson += tcd.function.arguments;
            }
          }
        } catch { /* skip malformed chunks */ }
      }
    }
    // 处理缓冲区中剩余的最后一行
    if (lineBuf.startsWith("data: ")) {
      const data = lineBuf.slice(6);
      if (data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          // 提取 usage 信息（通常在最后一个 chunk）
          if (parsed.usage) streamUsage = parsed.usage;
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
            if (onText) onText(delta.reasoning_content);
          }
          if (delta?.content) {
            if (!reasoningDone && onAnswer) { onAnswer(""); reasoningDone = true; }
            textParts.push(delta.content);
            if (onAnswer) onAnswer(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tcd of delta.tool_calls) {
              const idx = tcd.index;
              if (!toolBuf.has(idx)) toolBuf.set(idx, { id: "", name: "", argsJson: "" });
              const tb = toolBuf.get(idx)!;
              if (tcd.id) tb.id = tcd.id;
              if (tcd.function?.name) tb.name += tcd.function.name;
              if (tcd.function?.arguments) tb.argsJson += tcd.function.arguments;
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    this.callCount++;
    // 如果流式响应包含 usage 信息，使用实际 token 数；否则用估算
    if (streamUsage) {
      const usage = streamUsage as Record<string, unknown>;
      this.totalInputTokens += (usage.prompt_tokens as number) || 0;
      const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      const cached = (details?.cached_tokens as number) || 0;
      this.totalCachedTokens += cached;
      if (cached > 0) this.cacheHits++;
    } else {
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      this.totalInputTokens += Math.floor(totalChars * 0.4);
    }

    const text = textParts.join("");
    const reasoning = reasoningParts.join("");
    let toolCalls: ParsedToolCall[] | null = null;
    if (toolBuf.size > 0) {
      toolCalls = [];
      for (const [, tb] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tb.argsJson || "{}"); } catch { /* malformed JSON from LLM streaming */ }
        toolCalls.push({
          id: tb.id,
          name: tb.name,
          args,
        });
      }
    }
    return { text, toolCalls, reasoning, finishReason };
  }

  switch(alias: string): void {
    this.model = resolveModel(alias);
  }

  updateMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  static resolve = resolveModel;
  static setupProviders = setupProviders;
}
