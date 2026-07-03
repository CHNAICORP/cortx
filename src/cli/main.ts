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
  ctx --list-sessions        列出已保存会话
  ctx --resume <SESSION_ID>  恢复到指定会话
  ctx --init-config           创建默认 .cortx/settings.json
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
    const { execSync } = require("child_process");
    try {
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
      console.error(`更新失败: ${e}`);
      execSync("npm update -g @chnaicorp/cortx", { stdio: "inherit" });
    }
    return;
  }

  if (args.includes("--init-config")) {
    const cfgPath = path.join(process.cwd(), ".cortx", "settings.json");
    const template = {
      model: "pro", provider: "deepseek",
      providers: { deepseek: { api_key: "", base_url: "https://api.deepseek.com/v1", models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" } } },
      web_search: { provider: "duckduckgo", brave_api_key: "", serpapi_api_key: "", tavily_api_key: "", max_results: 5, timeout: 10 },
      max_steps: 10, context_limit: 1000000, permission_mode: "standard",
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
    };
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(template, null, 2), "utf-8");
    console.log(`已创建默认配置: ${cfgPath}`);
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
    Object.assign(settings, newSettings);
  }

  await loadTools();
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? (args[modelIdx + 1] || "pro") : (settings.model || "pro");
  const queryIdx = args.indexOf("-q");
  const query = queryIdx >= 0 ? args[queryIdx + 1] : null;
  const noStream = args.includes("--no-stream");
  const modeIdx = args.indexOf("--mode");
  const permissionMode = (modeIdx >= 0 ? args[modeIdx + 1] : settings.permission_mode || "standard") as "standard" | "auto" | "yolo";
  const maxStepsIdx = args.indexOf("--max-steps");
  const maxSteps = maxStepsIdx >= 0 ? parseInt(args[maxStepsIdx + 1]) || 10 : (settings.max_steps as number) || 10;
  const workDirIdx = args.indexOf("--work-dir");
  const workDir = workDirIdx >= 0 ? args[workDirIdx + 1] : (settings.work_dir as string) || require("../core/types.js").defaultWorkDir() as string;

  const agent = new CortexAgent({
    apiKey: getApiKey(settings),
    baseUrl: getBaseUrl(settings),
    model: LLMProvider.resolve(model),
    workDir,
    permissionMode,
    contextLimit: (settings.context_limit as number) || 1_000_000,
    memoryEnabled: settings.memory_enabled !== false,
    sessionsEnabled: settings.sessions_enabled !== false,
    autoExtractMemory: settings.auto_extract_memory !== false,
    maxSteps,
  });

  const term = new Terminal();
  agent.setTerm(term);

  // ── List sessions ──
  if (args.includes("--list-sessions")) {
    // @ts-ignore — sessions is private but we need it for CLI
    const sessions = agent.sessions;
    if (!sessions) { console.log("(会话系统不可用)"); return; }
    const list = sessions.listSessions();
    if (!list.length) { console.log("(无已保存的会话)"); return; }
    console.log(`\n${"ID".padEnd(24)} ${"Q".padEnd(5)} ${"MODEL".padEnd(22)} ${"LAST ACTIVE".padEnd(20)}`);
    console.log("-".repeat(75));
    for (const s of list) {
      const sid = String(s.session_id || "").slice(0, 22);
      const qcnt = s.query_count || 0;
      const m = String(s.model || "").slice(0, 20);
      const la = String(s.last_active || "").slice(0, 19);
      console.log(`  ${sid.padEnd(22)} ${String(qcnt).padEnd(5)} ${m.padEnd(22)} ${la}`);
    }
    return;
  }

  if (!noStream) {
    term.banner(agent.config.model, registry.schemaList.length, agent.config.workDir, agent.config.permissionMode);
  }

  // ── Session init ──
  const resumeIdx = args.indexOf("--resume");
  const newSession = args.includes("--new-session");
  if (resumeIdx >= 0) {
    agent.initSession(args[resumeIdx + 1], true);
  } else {
    agent.initSession(undefined, !newSession);
  }

  if (query) {
    const answer = await agent.run(query);
    if (noStream) console.log(answer);
    const trace = agent.lastTrace;
    if (trace?.steps.length) {
      const totalMs = trace.steps.reduce((s, st) => s + st.latencyMs, 0);
      console.error(`\n[审计] ${trace.steps.length} 步, ${totalMs.toFixed(0)}ms`);
    }
    if (agent.sessionIdStr) {
      console.error(`[会话] ${agent.sessionIdStr}`);
    }
    return;
  }

  // ── REPL ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const modeLabels: Record<string, string> = { standard: "s", auto: "a", yolo: "y" };

  const showPrompt = () => {
    const pct = agent.contextPct;
    const ml = modeLabels[agent.config.permissionMode] || "?";
    rl.setPrompt(`[${ml} ${pct}%]> `);
  };

  // Shift+Tab to cycle permission mode
  process.stdin.on("keypress", (_str, key) => {
    if (key && key.name === "tab" && key.shift) {
      const modes = ["standard", "auto", "yolo"];
      const idx = modes.indexOf(agent.config.permissionMode);
      const next = modes[(idx + 1) % 3] as "standard" | "auto" | "yolo";
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
    if (["/exit", "/quit", "/q"].includes(q)) {
      agent.saveSession();
      console.log(`\x1b[33mBye.\x1b[0m  \x1b[90mSession: ${agent.sessionIdStr || "?"}\x1b[0m`);
      break;
    }
    if (["/help", "/h", "/?"].includes(q)) {
      console.log(`  \x1b[36m═══ 会话管理 ═══\x1b[0m`);
      console.log(`  \x1b[36m/save\x1b[0m           保存会话`);
      console.log(`  \x1b[36m/sessions\x1b[0m       列出会话`);
      console.log(`  \x1b[36m/reset\x1b[0m          重置上下文`);
      console.log(`  \x1b[36m═══ 工具 & 模型 ═══\x1b[0m`);
      console.log(`  \x1b[36m/tools\x1b[0m          列出工具`);
      console.log(`  \x1b[36m/model [pro]\x1b[0m    切换模型`);
      console.log(`  \x1b[36m/mode [s|a|y]\x1b[0m   切换权限模式`);
      console.log(`  \x1b[36m═══ 上下文 & 记忆 ═══\x1b[0m`);
      console.log(`  \x1b[36m/context\x1b[0m       上下文容量 + 缓存命中率`);
      console.log(`  \x1b[36m/memory\x1b[0m        列出记忆`);
      console.log(`  \x1b[36m/forget <name>\x1b[0m  删除记忆`);
      console.log(`  \x1b[36m═══ 目标 & 规划 ═══\x1b[0m`);
      console.log(`  \x1b[36m/goal [目标]\x1b[0m    设置/查看持久化目标`);
      console.log(`  \x1b[36m/plan [描述]\x1b[0m    进入规划模式`);
      console.log(`  \x1b[36m═══ 快捷操作 ═══\x1b[0m`);
      console.log(`  \x1b[36m@filename\x1b[0m       引用文件内容到上下文`);
      console.log(`  \x1b[36m/q, /exit\x1b[0m       退出`);
      showPrompt(); rl.prompt(); continue;
    }
    // ── /tools ──
    if (["/tools", "/t"].includes(q)) {
      for (const s of registry.schemaList) {
        const n = s.function.name; const m = registry.meta(n);
        console.log(`  \x1b[36m${n}\x1b[0m [${m?.capability || "?"}]`);
        console.log(`    ${s.function.description}`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /model ──
    if (q === "/model" || q === "/m") { console.log(`当前: ${agent.config.model}\n可用: flash | pro`); showPrompt(); rl.prompt(); continue; }
    if (q.startsWith("/model ") || q.startsWith("/m ")) { agent.switchModel(q.split(" ", 2)[1]); console.log(`→ ${agent.config.model}`); showPrompt(); rl.prompt(); continue; }
    // ── /mode ──
    if (q === "/mode" || q === "/permissions") { console.log(`当前: ${agent.config.permissionMode}\n可用: s/standard | a/auto | y/yolo`); showPrompt(); rl.prompt(); continue; }
    if (q.startsWith("/mode ") || q.startsWith("/permissions ")) { console.log(agent.switchPermissionMode(q.split(" ", 2)[1])); showPrompt(); rl.prompt(); continue; }
    // ── /save ──
    if (q === "/save" || q === "/s") { agent.saveSession(); console.log(`会话已保存: ${agent.sessionIdStr}`); showPrompt(); rl.prompt(); continue; }
    // ── /sessions ──
    if (q === "/sessions" || q === "/ls") {
      // @ts-ignore
      const sessions = agent.sessions;
      if (!sessions) { console.log("(会话系统不可用)"); }
      else {
        const list = sessions.listSessions();
        if (!list.length) { console.log("(无已保存的会话)"); }
        else { for (const s of list) { console.log(`  ${String(s.session_id).slice(0, 22)}  Q=${s.query_count || 0}  ${String(s.last_active || "").slice(0, 19)}`); } }
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /memory ──
    if (q === "/memory" || q === "/mem") {
      // @ts-ignore
      if (!agent.memory) { console.log("(记忆系统不可用)"); }
      else {
        // @ts-ignore
        const facts = agent.memory.listAll();
        if (!facts.length) console.log("(没有记住任何事实)");
        else for (const f of facts) console.log(`  \x1b[36m${f}\x1b[0m`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /forget ──
    if (q.startsWith("/forget ")) {
      const name = q.split(" ", 2)[1].trim();
      // @ts-ignore
      if (!agent.memory) { console.log("(记忆系统不可用)"); }
      else {
        // @ts-ignore
        if (agent.memory.remove(name)) console.log(`已忘记: ${name}`);
        else console.log(`(x) 未找到: ${name}`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /reset ──
    if (q === "/reset") { agent.reset(); console.log("上下文已重置（含拒绝计数和暂停状态）"); showPrompt(); rl.prompt(); continue; }
    // ── /context ──
    if (q === "/context") {
      const ctx = agent.contextTokens;
      const lim = agent.contextLimit;
      const pct = agent.contextPct;
      console.log(`  ═══ 上下文容量 ═══`);
      console.log(`  Token:   ${ctx.toLocaleString()} / ${lim.toLocaleString()}  (${pct}%)`);
      const cs = agent.cacheStats;
      if (cs.calls > 0) {
        console.log(`  ═══ 缓存统计 ═══`);
        console.log(`  API 调用: ${cs.calls} 次`);
        console.log(`  缓存命中: ${cs.hitRate.toFixed(0)}%  (${cs.cacheHits}/${cs.calls})`);
        console.log(`  输入 token: ${cs.totalInputTokens.toLocaleString()}`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /goal ──
    if (q === "/goal") {
      const g = agent.goal;
      if (g) console.log(`当前目标:\n  ${g}`);
      else console.log("(未设置目标)\n用法: /goal <描述>  设置目标\n      /goal clear   清除目标");
      showPrompt(); rl.prompt(); continue;
    }
    if (q.startsWith("/goal ")) {
      const gtext = q.slice(6).trim();
      if (["clear", "stop", "reset", "cancel", "none"].includes(gtext.toLowerCase())) {
        agent.setGoal(""); console.log("目标已清除");
      } else {
        console.log(`目标已设置:\n  ${agent.setGoal(gtext)}`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /plan ──
    if (q.startsWith("/plan")) {
      const planDesc = q.includes(" ") ? q.split(" ").slice(1).join(" ").trim() : "";
      let planMsg = "[规划模式] 请先分析问题，制定详细的实施方案，不要立即编写代码。";
      if (planDesc) planMsg += `\n\n任务: ${planDesc}`;
      console.log(`\x1b[36m进入规划模式...\x1b[0m`);
      try { await agent.run(planMsg); } catch (e) { console.error(`[ERROR] ${e}`); }
      showPrompt(); rl.prompt(); continue;
    }
    // ── @file reference ──
    if (q.startsWith("@")) {
      const parts = q.slice(1).trim().split(/\s+(.*)/);
      const fname = parts[0] || "";
      const rest = parts[1] || "";
      if (fname.includes("..") || fname.startsWith("/") || fname.startsWith("\\")) {
        console.log(`(x) @引用不支持路径穿越: ${fname}`);
        showPrompt(); rl.prompt(); continue;
      }
      // Simple file search in cwd
      let match = "";
      try {
        const walk = (dir: string): boolean => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (walk(full)) return true; }
            else if (entry.name === fname || entry.name.startsWith(fname)) { match = full; return true; }
          }
          return false;
        };
        walk(process.cwd());
      } catch { /* ignore */ }
      if (match) {
        try {
          const content = fs.readFileSync(match, "utf-8").slice(0, 3000);
          let ctxMsg = `[文件引用: ${match}]\n\n\`\`\`\n${content}\n\`\`\``;
          if (rest) ctxMsg += `\n\n${rest}`;
          console.log(`\x1b[90m@${match} (${content.length} 字符)\x1b[0m`);
          await agent.run(ctxMsg);
        } catch (e) { console.log(`(x) 读取失败: ${e}`); }
      } else {
        try { await agent.run(q); } catch (e) { console.error(`[ERROR] ${e}`); }
      }
      showPrompt(); rl.prompt(); continue;
    }

    // ── Normal query ──
    try {
      await agent.run(q, undefined, true);
    } catch (e) {
      console.error(`[ERROR] ${e}`);
    }
    showPrompt();
    rl.prompt();
  }
  agent.saveSession();
  console.log(`\x1b[33mBye.\x1b[0m  \x1b[90mSession: ${agent.sessionIdStr || "?"}\x1b[0m`);
  rl.close();
}

main().catch(console.error);
