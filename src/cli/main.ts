#!/usr/bin/env node
/**
 * Cortex Agent CLI — TypeScript 入口
 * 与 Python main.py 完全对应
 */
import * as readline from "readline";
import { CortexAgent, LLMProvider } from "../core/loop";
import { registry } from "../core/registry";
import { loadSettings, getApiKey, getBaseUrl } from "../config";

// Register tools (lazy import to avoid circular deps)
async function loadTools(): Promise<void> {
  await import("../tools/file");
  await import("../tools/net");
  await import("../tools/exec");
  await import("../tools/memory");
  await import("../tools/mcp");
  await import("../tools/browser");
  await import("../tools/proxy");
  console.error(`[cortex] ${registry.schemaList.length} tools loaded`);
}

const USAGE = `
Cortex Agent — Harness Agent 架构 + Agentic Loop 引擎

用法:
  ctx                         交互 REPL
  ctx --model pro             指定模型
  ctx -q "hello"             单次查询
  ctx --no-stream            关闭流式输出
  ctx --new-session          强制新会话
  ctx --mode yolo            全部放行模式
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  await loadTools();

  const settings = loadSettings();
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? (args[modelIdx + 1] || "pro") : (settings.model || "pro");
  const queryIdx = args.indexOf("-q");
  const query = queryIdx >= 0 ? args[queryIdx + 1] : null;
  const noStream = args.includes("--no-stream");
  const modeIdx = args.indexOf("--mode");
  const permissionMode = (modeIdx >= 0 ? args[modeIdx + 1] : settings.permission_mode || "standard") as "standard" | "auto-edit" | "yolo";

  const agent = new CortexAgent({
    apiKey: getApiKey(settings),
    baseUrl: getBaseUrl(settings),
    model: LLMProvider.resolve(model),
    workDir: (settings.work_dir as string) || "./cortex_workspace",
    permissionMode,
    contextLimit: (settings.context_limit as number) || 1_000_000,
  });

  if (query) {
    const answer = await agent.run(query);
    if (noStream) console.log(answer);
    const trace = agent.lastTrace;
    if (trace?.steps.length) {
      const totalMs = trace.steps.reduce((s, st) => s + st.latencyMs, 0);
      console.error(`\n[审计] ${trace.steps.length} 步, ${totalMs.toFixed(0)}ms`);
    }
    return;
  }

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    const pct = agent.contextPct;
    rl.setPrompt(`[s ${pct}%]> `);
  };

  console.log("Cortex Agent REPL — /help /exit\n");
  prompt();
  rl.prompt();

  for await (const line of rl) {
    const q = line.trim();
    if (!q) { prompt(); rl.prompt(); continue; }
    if (["/exit", "/quit", "/q"].includes(q)) break;
    if (["/help", "/h"].includes(q)) { console.log(USAGE); prompt(); rl.prompt(); continue; }

    try {
      const answer = await agent.run(q);
      if (noStream) console.log(answer);
    } catch (e) {
      console.error(`[ERROR] ${e}`);
    }
    prompt();
    rl.prompt();
  }
  console.log("Bye.");
  rl.close();
}

main().catch(console.error);
