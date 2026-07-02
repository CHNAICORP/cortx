#!/usr/bin/env node
/**
 * Cortex Agent CLI — TypeScript 入口
 * 与 Python main.py 完全对应
 */
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CortexAgent, LLMProvider } from '../core/loop.js';
import { registry } from '../core/registry.js';
import { loadSettings, getApiKey, getBaseUrl } from '../config.js';
import { Terminal } from './terminal.js';

// Register tools (lazy import to avoid circular deps)
async function loadTools(): Promise<void> {
  await import("../tools/file.js");
  await import("../tools/net.js");
  await import("../tools/exec.js");
  await import("../tools/memory.js");
  await import("../tools/mcp.js");
  await import("../tools/browser.js");
  await import("../tools/proxy.js");
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

  if (args.includes("--version") || args.includes("-V")) {
    const pkg = require("../../package.json");
    console.log(`cortx ${pkg.version} (TypeScript/Node ${process.version})`);
    return;
  }

  if (args.includes("--update")) {
    const pkg = require("../../package.json");
    console.log(`当前: cortx ${pkg.version} (TypeScript)`);
    // 使用 npm-check-updates 或直接安装；Windows 上 npm config 的缓存可能导致 404
    // 显式指定版本防止 @latest 缓存过期
    const { execSync, exec } = require("child_process");
    try {
      // 方案1: 先获取最新版本，再安装
      const latest = execSync("npm view @chnaicorp/cortx version", { encoding: "utf-8", timeout: 10000 }).trim();
      if (latest && latest !== pkg.version) {
        console.log(`可用版本: ${latest}，正在更新...`);
        execSync(`npm install -g @chnaicorp/cortx@${latest} --force`, { stdio: "inherit" });
      } else if (latest === pkg.version) {
        console.log("已是最新版本。");
      } else {
        execSync("npm install -g @chnaicorp/cortx@latest --force", { stdio: "inherit" });
      }
    } catch (e) {
      // 回退: npm update
      console.error(`更新失败: ${e}`);
      execSync("npm update -g @chnaicorp/cortx", { stdio: "inherit" });
    }
    return;
  }

  // 首次运行配置向导
  const settings = loadSettings();
  const provider = (settings.provider as string) || "deepseek";
  const providers = (settings.providers || {}) as Record<string, Record<string, unknown>>;
  const hasApiKey = (providers[provider]?.api_key as string) || (settings.apiKey as string) || "";
  if (!hasApiKey) {
    const noStream = process.argv.includes("--no-stream");
    if (noStream) {
      console.error("\n  ⚠️  未配置 API Key。交互模式运行 ctx 进入配置向导，或编辑 ~/.cortx/settings.json\n");
      process.exit(1);
    }
    // Interactive setup wizard
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`    🎉 欢迎使用 Cortx！`);
    console.log(`    这是第一次运行，需要配置 AI 模型。`);
    console.log(`  ${"=".repeat(50)}\n`);
    console.log(`    选择模型提供商:`);
    console.log(`      [1] DeepSeek (推荐，国内可用)`);
    console.log(`      [2] OpenAI`);
    const choice = (await ask(`    请选择 (1/2): `)).trim() || "1";
    const prov = choice === "2" ? "openai" : "deepseek";
    console.log(`\n    输入 API Key:`);
    console.log(`    (DeepSeek: https://platform.deepseek.com/api_keys)`);
    let apiKey = (await ask(`    API Key: `)).trim();
    while (!apiKey) { apiKey = (await ask(`    API Key (不能为空): `)).trim(); }
    console.log(`\n    选择模型:`);
    const models = prov === "openai" ? { "1": ["gpt-4o", "gpt-4o"], "2": ["gpt-4o-mini", "gpt-4o-mini"] }
      : { "1": ["pro", "deepseek-v4-pro"], "2": ["flash", "deepseek-v4-flash"] };
    const modelsMap: Record<string, string[]> = models;
    for (const [k, v] of Object.entries(modelsMap)) {
      console.log(`      [${k}] ${v[0]} (${v[1]})`);
    }
    const mChoice = (await ask(`    请选择 (1/2): `)).trim() || "1";
    const [modelAlias, modelName] = modelsMap[mChoice] || modelsMap["1"];
    rl.close();
    // Save
    const userPath = path.join(os.homedir(), ".cortx", "settings.json");
    const newSettings = {
      model: modelAlias, provider: prov,
      providers: { [prov]: { api_key: apiKey, base_url: `https://api.${prov}.com/v1`, models: { [modelAlias]: modelName } } },
      max_steps: 10, context_limit: 1000000, permission_mode: "standard",
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
    };
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(newSettings, null, 2), "utf-8");
    console.log(`\n    ✅ 配置已保存到 ${userPath}\n`);
    // Reload settings
    Object.assign(settings, newSettings);
  }

  await loadTools();
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

  const term = new Terminal();
  agent.setTerm(term);
  term.banner(agent.config.model, registry.schemaList.length, agent.config.workDir, agent.config.permissionMode);

  if (query) {
    const answer = await agent.run(query);
    console.log(answer);
    const trace = agent.lastTrace;
    if (trace?.steps.length) {
      const totalMs = trace.steps.reduce((s, st) => s + st.latencyMs, 0);
      console.error(`\n[审计] ${trace.steps.length} 步, ${totalMs.toFixed(0)}ms`);
    }
    return;
  }

  // REPL with Shift+Tab support
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let currentLine = "";
  
  const modeLabels: Record<string, string> = { standard: "s", "auto-edit": "a", yolo: "y" };
  const showPrompt = () => {
    const pct = agent.contextPct;
    const ml = modeLabels[agent.config.permissionMode] || "?";
    rl.setPrompt(`[${ml} ${pct}%]> `);
  };

  // Listen for Shift+Tab (\x1b[Z) to cycle permission mode
  process.stdin.on("keypress", (_str, key) => {
    if (key && key.name === "tab" && key.shift) {
      const modes = ["standard", "auto-edit", "yolo"];
      const idx = modes.indexOf(agent.config.permissionMode);
      const next = modes[(idx + 1) % 3] as "standard" | "auto-edit" | "yolo";
      agent.config.permissionMode = next;
      showPrompt();
      rl.prompt();
    }
  });

  console.log("Cortex Agent REPL — /help /exit\n");
  showPrompt();
  rl.prompt();

  for await (const line of rl) {
    const q = line.trim();
    if (!q) { showPrompt(); rl.prompt(); continue; }
    if (["/exit", "/quit", "/q"].includes(q)) break;
    if (["/help", "/h"].includes(q)) { console.log(USAGE); showPrompt(); rl.prompt(); continue; }

    try {
      const answer = await agent.run(q);
      console.log(answer);
    } catch (e) {
      console.error(`[ERROR] ${e}`);
    }
    showPrompt();
    rl.prompt();
  }
  console.log("Bye.");
  rl.close();
}

main().catch(console.error);
