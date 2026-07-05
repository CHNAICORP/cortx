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
  ctx --resume [id]         恢复上次/指定会话的完整上下文
  ctx --mode yolo            全部放行模式
  ctx --long "task"         长时运行模式（自动续行直到完成）
  ctx --max-rounds N        限制续行轮数（0=无限）
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
      providers: { deepseek: { api_key: "", base_url: "https://api.deepseek.com/v1", models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" } },
                   openai: { api_key: "", base_url: "https://api.openai.com/v1", models: { "5.4": "gpt-5.4", "5.4-mini": "gpt-5.4-mini", "5.2": "gpt-5.2", "4.1": "gpt-4.1", "4o": "gpt-4o", "4o-mini": "gpt-4o-mini" } },
                   glm: { api_key: "", base_url: "https://open.bigmodel.cn/api/paas/v4", models: { "5.2": "glm-5.2", "5.1": "glm-5.1", "turbo": "glm-5-turbo", "4.7": "glm-4.7", "4.7-flash": "glm-4.7-flash", "4-long": "glm-4-long" } },
                   anthropic: { api_key: "", base_url: "https://api.anthropic.com", models: { fable: "claude-fable-5", mythos: "claude-mythos-5", sonnet: "claude-sonnet-5", opus: "claude-opus-4-8", "opus-pro": "claude-opus-4-7", haiku: "claude-haiku-4-5" } } },
      web_search: { provider: "duckduckgo", brave_api_key: "", serpapi_api_key: "", tavily_api_key: "", max_results: 5, timeout: 10 },
      max_steps: 0, context_limit: 0, max_tokens: 0, max_input_tokens: 0, permission_mode: "standard",
      compress_threshold: 1500, compress_head: 600, compress_tail: 400, safety_margin: 4096,
      input_warn_pct: 80, input_force_pct: 90, max_result_chars: 2000, memory_inject_count: 30,
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
    const C = { CYAN: '\x1b[36m', GREEN: '\x1b[32m', YELLOW: '\x1b[33m', RED: '\x1b[31m', GRAY: '\x1b[90m', DIM: '\x1b[2m', BOLD: '\x1b[1m', RESET: '\x1b[0m' };
    // ── 欢迎横幅 ──
    console.log(`\n${C.CYAN}╔${'═'.repeat(52)}╗${C.RESET}`);
    console.log(`${C.CYAN}║${C.RESET}  🎉 欢迎使用 Cortex Agent                                ${C.CYAN}║${C.RESET}`);
    console.log(`${C.CYAN}║${C.RESET}  首次运行，需要配置 AI 模型才能开始。                ${C.CYAN}║${C.RESET}`);
    console.log(`${C.CYAN}╚${'═'.repeat(52)}╝${C.RESET}\n`);
    // ── Provider 选择 ──
    const provList: Array<[string, string, string, string, string]> = [
      ["1", "deepseek",  "DeepSeek",   "V4 系列，国内可用",   "1M 上下文 / 384K 输出"],
      ["2", "anthropic", "Anthropic",  "Claude 模型",        "最高 1M 上下文"],
      ["3", "openai",    "OpenAI",     "GPT-5.x 系列",       "最高 1M 上下文"],
      ["4", "glm",       "GLM 智谱",   "GLM-5.2 国产旗舰",   "1M 上下文"],
    ];
    console.log(`  ${C.YELLOW}📋 选择模型提供商:${C.RESET}`);
    for (const [k, , name, desc, ctx] of provList) {
      const marker = k === "1" ? "★" : " ";
      console.log(`    ${C.GREEN}${marker} [${k}]${C.RESET} ${C.BOLD}${name.padEnd(14)}${C.RESET} ${C.DIM}${desc}${C.RESET}  ${C.GRAY}${ctx}${C.RESET}`);
    }
    const choice = (await ask(`  ${C.GREEN}请选择 (1/2/3/4):${C.RESET} `)).trim() || "1";
    const provEntry = provList.find(p => p[0] === choice) || provList[0];
    const prov = provEntry[1];
    const provName = provEntry[2];
    // ── API Key ──
    console.log(`\n  ${C.YELLOW}🔑 输入 API Key:${C.RESET}`);
    const keyUrls: Record<string, string> = {
      deepseek:  "https://platform.deepseek.com/api_keys",
      anthropic: "https://console.anthropic.com/settings/keys",
      openai:    "https://platform.openai.com/api-keys",
      glm:       "https://open.bigmodel.cn/console/apikeys",
    };
    console.log(`  ${C.GRAY}获取 Key: ${keyUrls[prov] || ''}${C.RESET}`);
    let apiKey = (await ask(`  ${C.GREEN}API Key:${C.RESET} `)).trim();
    while (!apiKey) { apiKey = (await ask(`  ${C.RED}✗ API Key 不能为空${C.RESET}\n  ${C.GREEN}API Key:${C.RESET} `)).trim(); }
    // ── 模型选择 ──
    const allModels: Record<string, Record<string, [string, string, string, string]>> = {
      deepseek: {
        "1": ["pro",   "deepseek-v4-pro",   "V4-Pro 旗舰",  "1M ctx / 384K out"],
        "2": ["flash", "deepseek-v4-flash", "V4-Flash 快速", "1M ctx / 384K out"],
      },
      anthropic: {
        "1": ["fable",  "claude-fable-5",    "Fable 5 — 最强旗舰",    "1M 上下文"],
        "2": ["sonnet", "claude-sonnet-5",   "Sonnet 5 — 均衡高效",   "1M 上下文"],
        "3": ["opus",   "claude-opus-4-8",   "Opus 4.8 — 顶级编码",   "200K 上下文"],
        "4": ["haiku",  "claude-haiku-4-5",  "Haiku 4.5 — 快速轻量",  "200K 上下文"],
        "5": ["mythos", "claude-mythos-5",   "Mythos 5 — 新一代推理", "1M 上下文"],
      },
      openai: {
        "1": ["5.4",       "gpt-5.4",       "GPT-5.4 旗舰",      "1M 上下文"],
        "2": ["5.4-mini",  "gpt-5.4-mini",  "GPT-5.4 Mini",     "1M 上下文"],
        "3": ["5.2",       "gpt-5.2",       "GPT-5.2",           "1M 上下文"],
        "4": ["4.1",       "gpt-4.1",       "GPT-4.1",           "1M 上下文"],
        "5": ["4.1-mini",  "gpt-4.1-mini",  "GPT-4.1 Mini",     "1M 上下文"],
        "6": ["4o",        "gpt-4o",        "GPT-4o",            "128K 上下文"],
      },
      glm: {
        "1": ["5.2",       "glm-5.2",       "GLM-5.2 旗舰",     "1M 上下文"],
        "2": ["5.1",       "glm-5.1",       "GLM-5.1",          "128K 上下文"],
        "3": ["turbo",     "glm-5-turbo",   "GLM-5-Turbo",      "128K 上下文"],
        "4": ["4.7",       "glm-4.7",       "GLM-4.7",          "200K 上下文"],
        "5": ["4.7-flash", "glm-4.7-flash", "GLM-4.7 Flash",   "200K 上下文 / 免费"],
        "6": ["4-long",    "glm-4-long",    "GLM-4-Long",       "1M 上下文"],
      },
    };
    console.log(`\n  ${C.YELLOW}🤖 选择模型:${C.RESET}`);
    const modelsMap = allModels[prov] || allModels.deepseek;
    for (const [k, [alias, , desc, ctx]] of Object.entries(modelsMap)) {
      console.log(`    ${C.GREEN}[${k}]${C.RESET} ${C.BOLD}${alias.padEnd(16)}${C.RESET} ${C.DIM}${desc}${C.RESET}  ${C.GRAY}${ctx}${C.RESET}`);
    }
    const mChoice = (await ask(`  ${C.GREEN}请选择 (${Object.keys(modelsMap).join('/')}):${C.RESET} `)).trim() || "1";
    const [modelAlias, modelName] = (modelsMap[mChoice] || modelsMap["1"]);
    rl.close();
    const baseUrls: Record<string, string> = {
      deepseek: "https://api.deepseek.com/v1",
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com/v1",
      glm: "https://open.bigmodel.cn/api/paas/v4",
    };
    const userPath = path.join(os.homedir(), ".cortx", "settings.json");
    const newSettings = {
      model: modelAlias, provider: prov,
      providers: { [prov]: { api_key: apiKey, base_url: baseUrls[prov], models: { [modelAlias]: modelName } } },
      max_steps: 0, context_limit: 0, max_tokens: 0, max_input_tokens: 0, permission_mode: "standard",
      compress_threshold: 1500, compress_head: 600, compress_tail: 400, safety_margin: 4096,
      input_warn_pct: 80, input_force_pct: 90, max_result_chars: 10000, memory_inject_count: 30,
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
    };
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(newSettings, null, 2), "utf-8");
    console.log(`\n  ${C.GREEN}✅ 配置已保存${C.RESET}  ${C.GRAY}${userPath}${C.RESET}`);
    console.log(`  ${C.CYAN}▸ 提供商:${C.RESET} ${provName}  ${C.CYAN}▸ 模型:${C.RESET} ${modelAlias} (${modelName})`);
    console.log(`  ${C.CYAN}启动 Cortex Agent...${C.RESET}\n`);
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
  const longMode = args.includes("--long");
  // --long 模式下每轮无限步数（由 maxRounds 控制续行，避免每轮步数耗尽中断企业级开发）
  const maxSteps = maxStepsIdx >= 0 ? parseInt(args[maxStepsIdx + 1]) || 0
    : longMode ? 0  // --long → 每轮无限步数，由轮次管理控制
    : (settings.max_steps as number) || 0;
  const maxRoundsIdx = args.indexOf("--max-rounds");
  const maxRounds = maxRoundsIdx >= 0 ? parseInt(args[maxRoundsIdx + 1]) || 0 : (settings.max_rounds as number) ?? 0;
  const workDirIdx = args.indexOf("--work-dir");
  const workDir = workDirIdx >= 0 ? args[workDirIdx + 1] : (settings.work_dir as string) || require("../core/types.js").defaultWorkDir() as string;

  const agent = new CortexAgent({
    apiKey: getApiKey(settings),
    baseUrl: getBaseUrl(settings),
    model: LLMProvider.resolve(model),
    workDir,
    permissionMode,
    contextLimit: (settings.context_limit as number) || 0,
    maxTokens: (settings.max_tokens as number) || 0,
    maxInputTokens: (settings.max_input_tokens as number) || 0,
    compressThreshold: (settings.compress_threshold as number) || 0,
    compressHead: (settings.compress_head as number) || 0,
    compressTail: (settings.compress_tail as number) || 0,
    safetyMargin: (settings.safety_margin as number) || 0,
    inputWarnPct: (settings.input_warn_pct as number) || 0,
    inputForcePct: (settings.input_force_pct as number) || 0,
    maxResultChars: (settings.max_result_chars as number) || 0,
    memoryInjectCount: (settings.memory_inject_count as number) || 0,
    memoryEnabled: settings.memory_enabled !== false,
    sessionsEnabled: settings.sessions_enabled !== false,
    autoExtractMemory: settings.auto_extract_memory !== false,
    maxSteps,
    thinkTimeout: (settings.think_timeout as number) ?? 600,
    loopTimeout: (settings.loop_timeout as number) ?? 0,
    maxRounds,
    checkpointInterval: (settings.checkpoint_interval as number) || 5,
    retryMax: (settings.retry_max as number) ?? 5,
    retryBaseDelay: (settings.retry_base_delay as number) || 2,
    compactThreshold: (settings.compact_threshold as number) || 60,
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

  // ── Session init ──
  // 默认创建新会话（仅注入历史摘要），--resume 才恢复完整上下文
  const resumeIdx = args.indexOf("--resume");
  const isResume = resumeIdx >= 0;
  if (isResume) {
    agent.initSession(args[resumeIdx + 1], true);
  } else {
    agent.initSession(undefined, false);
  }

  if (!noStream) {
    term.banner(agent.config.model, registry.schemaList.length, agent.config.workDir, agent.config.permissionMode, agent.sessionIdStr || undefined, agent.contextLimit, isResume);
  }

  if (query) {
    const answer = longMode
      ? await agent.runLong(query)
      : await agent.run(query);
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
  const modeLabels: Record<string, string> = { standard: "🛡", auto: "✎", yolo: "⚠" };
  const modeColors: Record<string, string> = { standard: "\x1b[38;5;82m", auto: "\x1b[38;5;220m", yolo: "\x1b[38;5;196m" };

  const showPrompt = () => {
    const pct = agent.contextPct;
    const ml = modeLabels[agent.config.permissionMode] || "?";
    const mc = modeColors[agent.config.permissionMode] || "\x1b[90m";
    const pc = pct < 50 ? "\x1b[38;5;82m" : (pct < 80 ? "\x1b[38;5;220m" : "\x1b[38;5;196m");
    // 缓存命中率实时显示
    const cs = agent.cacheStats;
    let cacheStr = "";
    if (cs.calls > 0) {
      const hr = cs.hitRate;
      const hc = hr > 80 ? "\x1b[38;5;82m" : (hr > 50 ? "\x1b[38;5;220m" : "\x1b[38;5;196m");
      cacheStr = ` ${hc}⚡${hr.toFixed(0)}%\x1b[0m`;
    }
    rl.setPrompt(`${mc}${ml}\x1b[0m ${pc}${pct}%\x1b[0m${cacheStr}> `);
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
      console.log(`  \x1b[36m/resume <id>\x1b[0m     恢复会话`);
      console.log(`  \x1b[36m/reset\x1b[0m          重置上下文`);
      console.log(`  \x1b[36m═══ 工具 & 模型 ═══\x1b[0m`);
      console.log(`  \x1b[36m/tools\x1b[0m          列出工具`);
      console.log(`  \x1b[36m/model [pro]\x1b[0m    切换模型`);
      console.log(`  \x1b[36m/mode [s|a|y]\x1b[0m   切换权限模式`);
      console.log(`  \x1b[36m═══ 上下文 & 记忆 ═══\x1b[0m`);
      console.log(`  \x1b[36m/context\x1b[0m       上下文容量 + 缓存命中率`);
      console.log(`  \x1b[36m/memory\x1b[0m        列出记忆`);
      console.log(`  \x1b[36m/forget <name>\x1b[0m  删除记忆`);
      console.log(`  \x1b[36m═══ 审计 & 调试 ═══\x1b[0m`);
      console.log(`  \x1b[36m/trace\x1b[0m          最后轨迹`);
      console.log(`  \x1b[36m/a, /audit\x1b[0m      审计轨迹`);
      console.log(`  \x1b[36m═══ 知识库 ═══\x1b[0m`);
      console.log(`  \x1b[36m/kb\x1b[0m            查看项目知识库 CORTEX.md`);
      console.log(`  \x1b[36m/init\x1b[0m           初始化项目 CORTEX.md`);
      console.log(`  \x1b[36m═══ 技能系统 ═══\x1b[0m`);
      console.log(`  \x1b[36m/skills\x1b[0m         列出技能`);
      console.log(`  \x1b[36m/skill <name>\x1b[0m   调用技能`);
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
    // ── /resume ──
    if (q.startsWith("/resume ") || q.startsWith("/r ")) {
      const target = q.split(" ").slice(1).join(" ").trim();
      if (agent.resumeSession(target)) { console.log(`已恢复会话: ${target}`); }
      else { console.log(`(x) 会话不存在或恢复失败: ${target}`); }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /trace — 最后轨迹 ──
    if (q === "/trace") {
      const t = agent.lastTrace;
      if (!t || !t.steps.length) { console.log("(无轨迹)"); }
      else {
        for (const s of t.steps) {
          const status = s.success ? "\x1b[38;5;82mOK\x1b[0m" : "\x1b[38;5;196mFAIL\x1b[0m";
          console.log(`  [${s.step}] ${s.toolName} ${s.capability} ${s.latencyMs.toFixed(0)}ms ${status}`);
        }
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /audit — 审计轨迹 ──
    if (q === "/audit" || q === "/a") {
      const traces = agent.allTraces;
      if (!traces.length) { console.log("(无审计记录)"); }
      else {
        traces.forEach((t, ti) => {
          console.log(`\n  \x1b[36m--- 查询 ${ti + 1}: ${t.query.slice(0, 60)}\x1b[0m`);
          for (const s of t.steps) {
            const status = s.success ? "\x1b[38;5;82mOK\x1b[0m" : "\x1b[38;5;196mFAIL\x1b[0m";
            console.log(`  [${s.step}] ${s.toolName} ${s.capability} ${s.latencyMs.toFixed(0)}ms ${status}`);
          }
          if (t.error) console.log(`  ERROR: ${t.error}`);
          if (t.stepLimitReached) console.log(`  结果: 超步数`);
        });
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /kb — 查看知识库 ──
    if (q === "/kb") {
      const kbPath = path.join(process.cwd(), "CORTEX.md");
      if (fs.existsSync(kbPath)) {
        const content = fs.readFileSync(kbPath, "utf-8");
        const lines = content.split("\n");
        console.log(`  \x1b[36mCORTEX.md (${lines.length} 行, ${content.length} 字符)\x1b[0m`);
        console.log(`  \x1b[90m${"─".repeat(40)}\x1b[0m`);
        for (const line of lines.slice(0, 20)) console.log(`  \x1b[90m${line}\x1b[0m`);
        if (lines.length > 20) console.log(`  \x1b[90m... (${lines.length - 20} 行省略) ...\x1b[0m`);
        console.log(`\n  编辑: 直接修改 CORTEX.md 文件即可`);
        console.log(`  支持 @import 导入其他文件`);
      } else {
        console.log(`  (CORTEX.md 不存在)`);
        console.log(`  创建: /init 或手动创建项目根目录的 CORTEX.md`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /init — 初始化项目 CORTEX.md ──
    if (q === "/init") {
      const kbPath = path.join(process.cwd(), "CORTEX.md");
      console.log(`\x1b[36m正在分析项目...\x1b[0m`);
      let pyCount = 0, tsCount = 0;
      try {
        pyCount = fs.readdirSync(process.cwd()).filter(f => f.endsWith(".py")).length;
        tsCount = fs.readdirSync(process.cwd()).filter(f => f.endsWith(".ts")).length;
      } catch { /* ignore */ }
      console.log(`  发现 ${pyCount} 个 Python 文件, ${tsCount} 个 TypeScript 文件`);
      if (fs.existsSync(kbPath)) {
        console.log(`  CORTEX.md 已存在 — 跳过创建`);
      } else {
        const template = `# CORTEX.md\n\n## 项目概述\n\n<!-- 描述项目目的、架构和关键设计决策 -->\n\n## 开发指南\n\n<!-- 代码风格、测试命令、构建步骤 -->\n\n## 注意事项\n\n<!-- 安全约束、已知问题、禁用操作 -->\n`;
        fs.writeFileSync(kbPath, template, "utf-8");
        console.log(`  \x1b[38;5;82m已创建 CORTEX.md\x1b[0m`);
      }
      console.log(`  提示: 使用 @CORTEX.md 查看/编辑项目记忆`);
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
const inPct = agent.inputTokensPct;
const color = pct < 50 ? "\x1b[38;5;82m" : (pct < 80 ? "\x1b[38;5;220m" : "\x1b[38;5;196m");
const msgs = agent.contextMessages;
const G = "\x1b[0m";
const CY = "\x1b[36m";
const GR = "\x1b[90m";
const DM = "\x1b[2m";
const BD = "\x1b[1m";
const GN = "\x1b[38;5;82m";
const YL = "\x1b[38;5;220m";
const RD = "\x1b[38;5;196m";
const fmtTok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.floor(n / 1000)}K` : String(n);
const inColor = inPct < 80 ? GN : (inPct < 90 ? YL : RD);
const barLen = 30; const filled = Math.floor(barLen * pct / 100);
const bar = `${color}${"█".repeat(filled)}${GR}${"░".repeat(barLen - filled)}${G}`;
console.log(`  ${CY}╭${"─".repeat(46)}╮${G}`);
console.log(`  ${CY}│${G}  📊 上下文容量                                ${CY}│${G}`);
console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
console.log(`  ${CY}│${G}  消息数:    ${BD}${msgs}${G} 条                          ${CY}│${G}`);
console.log(`  ${CY}│${G}  Token:     ${color}${ctx.toLocaleString()}${G} / ${GR}${lim.toLocaleString()}${G}  (${color}${pct}%${G})          ${CY}│${G}`);
console.log(`  ${CY}│${G}  [${bar}]                       ${CY}│${G}`);
console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
console.log(`  ${CY}│${G}  📐 Token 预算                                ${CY}│${G}`);
console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
console.log(`  ${CY}│${G}  输入上限:  ${inColor}${fmtTok(agent.maxInputTokens)}${G}  (已用 ${inColor}${inPct}%${G})           ${CY}│${G}`);
console.log(`  ${CY}│${G}  输出上限:  ${GN}${fmtTok(agent.maxTokens)}${G}                              ${CY}│${G}`);
console.log(`  ${CY}│${G}  上下文窗:  ${DM}${fmtTok(lim)}${G}  (输入+输出+安全余量)        ${CY}│${G}`);
const cs = agent.cacheStats;
      if (cs.calls > 0) {
        const hitRate = cs.hitRate;
        const hitColor = hitRate > 80 ? GN : (hitRate > 50 ? YL : RD);
        const hitBarLen = 20; const hitFilled = Math.floor(hitBarLen * hitRate / 100);
        const hitBar = `${hitColor}${"█".repeat(hitFilled)}${GR}${"░".repeat(hitBarLen - hitFilled)}${G}`;
        console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
        console.log(`  ${CY}│${G}  ⚡ 缓存统计                                  ${CY}│${G}`);
        console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
        console.log(`  ${CY}│${G}  API 调用:  ${BD}${cs.calls}${G} 次                             ${CY}│${G}`);
        console.log(`  ${CY}│${G}  缓存命中:  ${hitColor}${hitRate.toFixed(0)}%${G}  (${cs.cacheHits}/${cs.calls})                       ${CY}│${G}`);
        console.log(`  ${CY}│${G}  [${hitBar}]                     ${CY}│${G}`);
        console.log(`  ${CY}│${G}  输入 token: ${DM}${cs.totalInputTokens.toLocaleString()}${G}                          ${CY}│${G}`);
        if (cs.totalCachedTokens > 0) {
          console.log(`  ${CY}│${G}  缓存 token: ${GN}${cs.totalCachedTokens.toLocaleString()}${G}                          ${CY}│${G}`);
        }
      }
      // ── 知识库状态 ──
      const kbPath = path.join(process.cwd(), "CORTEX.md");
      const kbStatus = fs.existsSync(kbPath) ? `${GN}已加载${G}` : `${GR}未创建${G}`;
      console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
      console.log(`  ${CY}│${G}  📚 知识库                                    ${CY}│${G}`);
      console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
      console.log(`  ${CY}│${G}  CORTEX.md: ${kbStatus}                          ${CY}│${G}`);
      console.log(`  ${CY}╰${"─".repeat(46)}╯${G}`);
      showPrompt(); rl.prompt(); continue;
    }
    // ── /skills — 列出技能 ──
    if (q === "/skills" || q === "/skill") {
      const mgr = agent.skillMgr;
      if (!mgr || !mgr.listAll().length) { console.log("(无可用技能)"); }
      else {
        const cats = mgr.listByCategory();
        console.log(`\x1b[36m可用技能 (${mgr.listAll().length} 个):\x1b[0m\n`);
        for (const cat of Object.keys(cats).sort()) {
          console.log(`  \x1b[33m[${cat}]\x1b[0m`);
          for (const s of cats[cat]) {
            console.log(`    \x1b[36m${s.name.padEnd(20)}\x1b[0m — ${s.description}`);
          }
        }
        console.log(`\n用法: /skill <name>  调用技能`);
      }
      showPrompt(); rl.prompt(); continue;
    }
    // ── /skill <name> — 调用技能 ──
    if (q.startsWith("/skill ")) {
      const sname = q.split(" ").slice(1).join(" ").trim();
      const mgr = agent.skillMgr;
      if (!mgr) { console.log("(技能系统不可用)"); }
      else {
        const skill = mgr.get(sname);
        if (!skill) { console.log(`(x) 技能不存在: ${sname}`); }
        else {
          console.log(`\x1b[36m[技能] ${skill.name}\x1b[0m — ${skill.description}`);
          try { await agent.run(skill.toPrompt()); } catch (e) { console.error(`[ERROR] ${e}`); }
        }
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
