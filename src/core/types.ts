/**
 * Cortex Agent — 核心类型定义
 * 与 Python cortex_agent.py 完全对应
 */

import { homedir } from "os";

// ── 风险等级 ──
export enum RiskLevel {
  SAFE = 0,
  WRITE = 1,
  SYSTEM = 2,
}

// ── 审计判决 ──
export enum AuditVerdict {
  ALLOW = "allow",
  WARN = "warn",
  CONFIRM = "confirm",
  DENY = "deny",
}

export const PERMISSION_MODES = ["standard", "auto", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// ── 能力令牌 ──
export enum Capability {
  FS_READ = "fs:read",
  FS_WRITE = "fs:write",
  DB_READ = "db:read",
  SHELL = "shell",
  PYTHON = "python",
  NET_HTTP = "net:http",
  NET_SEARCH = "net:search",
  MCP = "mcp",
  BROWSER = "browser",
}

// ── 工具元数据 ──
export interface ToolMeta {
  description: string;
  risk: RiskLevel;
  capability: Capability;
}

// ── OpenAI Function Schema ──
export interface FunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ── 工具实现 ──
export type ToolFn = (workDir: string, args: Record<string, unknown>) => string | Promise<string>;

// ── 步记录 ──
export interface StepRecord {
  step: number;
  timestamp: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resultPreview: string;
  success: boolean;
  riskLevel: string;
  capability: string;
  latencyMs: number;
}

// ── 轨迹 ──
export interface RunTrace {
  query: string;
  steps: StepRecord[];
  startTime: number;
  finalAnswer: string;
  stepLimitReached: boolean;
  error: string;
}

// ── LLM 消息 ──
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── 缓存统计 ──
export interface CacheStats {
  calls: number;
  cacheHits: number;
  hitRate: number;
  totalInputTokens: number;
  totalCachedTokens: number;
}

// ── AgentConfig ──
export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  workDir: string;
  maxSteps: number;
  toolTimeout: number;
  systemPrompt: string;
  maxContextMsgs: number;
  loopTimeout: number;
  thinkTimeout: number;
  memoryDir: string;
  sessionsDir: string;
  skillsDir: string;
  autoExtractMemory: boolean;
  memoryEnabled: boolean;
  sessionsEnabled: boolean;
  permissionMode: PermissionMode;
  permissionRemember: boolean;
  workspaceOnly: boolean;
  contextLimit: number;
  maxTokens: number;
  maxInputTokens: number;
  // ── ContextGovernor 可调参数 (均可在 settings.json 中自定义) ──
  compressThreshold: number;
  compressHead: number;
  compressTail: number;
  safetyMargin: number;
  inputWarnPct: number;
  inputForcePct: number;
  // ── ToolExecutor 可调参数 ──
  maxResultChars: number;
  // ── Memory 注入控制 ──
  memoryInjectCount: number;
  // ── 长时运行参数 ──
  maxRounds: number;
  checkpointInterval: number;
  retryMax: number;
  retryBaseDelay: number;
  compactThreshold: number;
}

export function defaultWorkDir(): string {
  const { join } = require("path") as typeof import("path");
  return join(homedir(), ".cortx", "workspace");
}

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  workDir: defaultWorkDir(),
  maxSteps: 0,               // 0=unlimited (24h continuous operation)
  toolTimeout: 30,           // Default 30s tool execution timeout (prevents blocking commands)
  systemPrompt: "",
  maxContextMsgs: 50,
  loopTimeout: 0,            // 0=no timeout (24h continuous operation)
  thinkTimeout: 600,         // single LLM call timeout (10 min for complex reasoning)
  // ── Long-run parameters ──
  maxRounds: 0,              // 0=unlimited auto-continue
  checkpointInterval: 5,    // auto-save every N steps
  retryMax: 5,              // transient error retry count (enhanced resilience)
  retryBaseDelay: 2.0,      // exponential backoff base delay (seconds)
  compactThreshold: 60,     // context compaction trigger
  memoryDir: "",
  sessionsDir: "",
  skillsDir: "",
  autoExtractMemory: true,
  memoryEnabled: true,
  sessionsEnabled: true,
  permissionMode: "standard",
  permissionRemember: true,
  workspaceOnly: false,
  contextLimit: 0,
  maxTokens: 0,
  maxInputTokens: 0,
  // ── ContextGovernor 可调参数 ──
  compressThreshold: 1500,
  compressHead: 600,
  compressTail: 400,
  safetyMargin: 4096,
  inputWarnPct: 80,
  inputForcePct: 90,
  // ── ToolExecutor 可调参数 ──
  maxResultChars: 10000,      // tool result truncation (supports large code files)
  // ── Memory 注入控制 ──
  memoryInjectCount: 30,
};
