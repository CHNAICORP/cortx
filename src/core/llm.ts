/**
 * LLM Provider — DeepSeek / OpenAI 流式 + 非流式
 * 与 Python llm.py 完全对应
 */
import { Message, FunctionSchema, CacheStats } from './types.js';

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  tools: FunctionSchema[];
  timeout: number;
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
}

const DEFAULT_PROVIDERS: Record<string, { baseUrl: string; models: Record<string, string> }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: {},
  },
};

let activeProvider = "deepseek";
let activeBaseUrl = "https://api.deepseek.com/v1";

export function setupProviders(providers?: Record<string, { baseUrl: string; models: Record<string, string> }>, active?: string) {
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

export class LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  model: string;
  private tools: FunctionSchema[];
  private timeout: number;

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
  }

  get cacheStats(): CacheStats {
    return {
      calls: this.callCount,
      cacheHits: this.cacheHits,
      hitRate: this.callCount > 0 ? (this.cacheHits / this.callCount) * 100 : 0,
      totalInputTokens: this.totalInputTokens,
      totalCachedTokens: this.totalCachedTokens,
    };
  }

  async call(messages: Message[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      extra_body: { thinking: { type: "enabled" } },
    };

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

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

    const msg = (data.choices as Array<{ message?: Record<string, unknown> }>)?.[0]?.message;
    const text: string = (msg?.content as string) || "";
    const reasoning: string = (msg?.reasoning_content as string) || "";

    let toolCalls: ParsedToolCall[] | null = null;
    if (msg?.tool_calls) {
      toolCalls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      }));
    }

    return { text, toolCalls, reasoning };
  }

  async callStream(
    messages: Message[],
    onText?: (t: string) => void,
    onAnswer?: (t: string) => void,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      extra_body: { thinking: { type: "enabled" } },
      stream: true,
    };

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBuf: Map<number, { id: string; name: string; argsJson: string }> = new Map();
    let reasoningDone = false;

    if (!reader) return { text: "", toolCalls: null, reasoning: "" };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
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

    this.callCount++;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    this.totalInputTokens += Math.floor(totalChars * 0.4);

    const text = textParts.join("");
    const reasoning = reasoningParts.join("");
    let toolCalls: ParsedToolCall[] | null = null;
    if (toolBuf.size > 0) {
      toolCalls = [];
      for (const [, tb] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({
          id: tb.id,
          name: tb.name,
          args: JSON.parse(tb.argsJson || "{}"),
        });
      }
    }
    return { text, toolCalls, reasoning };
  }

  static resolve = resolveModel;
  static setupProviders = setupProviders;
}
