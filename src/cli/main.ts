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
  await import("../tools/subagent.js");
  await import("../tools/git.js");
  await import("../tools/office.js");
  await import("../tools/skills.js");
  console.error(`[cortex] ${registry.schemaList.length} tools loaded`);
}

const USAGE = `
Cortex Agent — Harness Agent 架构 + Agentic Loop 引擎

用法:
  ctx                         交互 REPL
  ctx --model pro             指定模型
  ctx -q "hello"             单次查询
  ctx -p "prompt"            管道模式 (从 stdin 读取输入，非交互)
  cat file.ts | ctx -p       从管道读取文件内容作为输入
  ctx --no-stream            关闭流式输出
  ctx -r                    恢复会话（弹出选择器）
  ctx -r <id>               恢复指定会话
  ctx --resume [id]         同 -r，恢复上次/指定会话的完整上下文
  ctx --mode yolo            全部放行模式
  ctx --long "task"         长时运行模式（自动续行直到完成）
  ctx --max-rounds N        限制续行轮数（0=无限）
  ctx --allowed-tools T1,T2 仅允许指定的工具
  ctx --disallowed-tools T3 禁止指定的工具
  ctx --list-sessions        列出已保存会话
  ctx --init-config           创建默认 .cortx/settings.json
`;

// ════════════════════════════════════════════════════════
// 会话选择器 — `ctx -r` / `/resume` 不带 id 时调用
// ════════════════════════════════════════════════════════
const CY = "\x1b[36m", GR = "\x1b[90m", DM = "\x1b[2m", BD = "\x1b[1m", G = "\x1b[0m";
const GN = "\x1b[38;5;82m", YL = "\x1b[38;5;220m", RD = "\x1b[38;5;196m";

/** 从会话 .jsonl 提取首条 user 消息作为预览（与 memory_store.getHistorySummary 同款读取） */
function sessionPreview(sessionsDir: string, sessionId: string): string {
  try {
    const fpath = path.join(sessionsDir, `${path.basename(sessionId)}.jsonl`);
    if (!fs.existsSync(fpath)) return "";
    for (const line of fs.readFileSync(fpath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === "msg" && obj.role === "user") {
        return String(obj.content || "").replace(/\n/g, " ").trim().slice(0, 50);
      }
    }
  } catch { /* ignore */ }
  return "";
}

/** 格式化时间: ISO -> MM-DD HH:MM */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch { return String(iso).slice(0, 16); }
}

/** 渲染单行会话（带高亮选中项）。返回不含换行的行字符串。 */
function renderSessionRow(
  s: Record<string, unknown>, idx: number, total: number,
  sessionsDir: string, selected: boolean
): string {
  const sid = String(s.session_id || "").slice(0, 20);
  const la = fmtTime(String(s.last_active || ""));
  const q = String(s.query_count || 0).padEnd(2);
  const prev = sessionPreview(sessionsDir, String(s.session_id)) || "(空)";
  const num = String(idx + 1).padStart(2);
  // 选中行: ▸ + 绿底反色; 普通: 空格 + 灰色
  if (selected) {
    const HL = "\x1b[32m\x1b[1m";  // 绿色加粗
    const BG = "\x1b[48;5;238m";   // 深灰底
    return `${CY}│${G} ${BG}▸${HL}${num} ${sid.padEnd(20)} ${la.padEnd(11)} ${q} ${prev.slice(0, 24).padEnd(24)}${G}   ${CY}│${G}`;
  }
  const marker = idx === 0 ? `${GN}★${G}` : `${GR} ${G}`;
  return `${CY}│${G} ${marker}${GR}${num}${G} ${sid.padEnd(20)} ${la.padEnd(11)} ${q} ${DM}${prev.slice(0, 24)}${G}`;
}

/**
 * 弹出会话选择器，返回选中的 session_id。
 * - 返回 null 表示用户选择"新建会话"
 * - 非 TTY 环境直接返回 undefined（由调用方走默认逻辑）
 */

/** readline 的 closed 标志（类型定义未暴露，运行时存在） */
function rlClosed(rl: readline.Interface): boolean {
  return (rl as unknown as { closed?: boolean }).closed === true;
}

/** raw 按键会话：暂停主 rl 并暂存/摘除 stdin 的全部 keypress 监听（含 readline 内部的），
 *  防止 raw 会话按键泄漏进主 rl —— 字符混入行缓冲 / Enter 产生伪 line 事件 /
 *  Ctrl+C 触发 readline 无 SIGINT 监听时的默认 close()（后者导致 ERR_USE_AFTER_CLOSE 崩溃）。
 *  结束时恢复监听并 resume 主 rl。 */
function rawSession(rl: readline.Interface): {
  onKey: (h: (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void) => void;
  end: () => void;
} {
  const saved = process.stdin.listeners("keypress").slice();
  saved.forEach(l => process.stdin.removeListener("keypress", l));
  rl.pause();
  readline.emitKeypressEvents(process.stdin);
  const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void> = [];
  const hadRaw = typeof process.stdin.setRawMode === "function";
  if (hadRaw) process.stdin.setRawMode(true);
  process.stdin.resume();
  return {
    onKey: h => { handlers.push(h); process.stdin.on("keypress", h); },
    end: () => {
      handlers.forEach(h => process.stdin.removeListener("keypress", h));
      if (hadRaw) process.stdin.setRawMode(false);
      // raw 会话期间若外部已关闭 rl（如退出流程），不再恢复，避免 ERR_USE_AFTER_CLOSE
      saved.forEach(l => { if (!rlClosed(rl)) process.stdin.on("keypress", l); });
      if (!rlClosed(rl)) rl.resume();
    },
  };
}

/** 行输入（可退格编辑）。ESC/Ctrl+C 返回 null。与主 rl 按键隔离（rawSession）。 */
function askInput(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise(resolve => {
    const sess = rawSession(rl);
    process.stdout.write(prompt);
    let buf = "";
    sess.onKey((str, key) => {
      if (process.env.CORTEX_DEBUG_KEYS) console.error(`[askInput] key=${key.name} ctrl=${!!key.ctrl} str=${JSON.stringify(str)}`);
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        sess.end(); process.stdout.write("\n"); resolve(null); return;
      }
      if (key.name === "return") {
        sess.end(); process.stdout.write("\n"); resolve(buf.trim()); return;
      }
      if (key.name === "backspace") {
        if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        return;
      }
      if (str && !key.ctrl && !key.meta) { buf += str; process.stdout.write(str); }
    });
  });
}

/** 通用方向键列表选择器（↑↓ 移动 · Enter 确定 · ESC 取消）。返回选中索引；ESC 返回 null。 */
async function selectList(
  rl: readline.Interface,
  title: string,
  items: string[],
): Promise<number | null> {
  // raw mode 不可用（非 TTY）→ 退化为数字输入
  if (typeof process.stdin.setRawMode !== "function") {
    console.log(title);
    items.forEach((it, i) => console.log(`  [${i + 1}] ${it}`));
    const ans = await new Promise<string>(r => { const t = readline.createInterface({ input: process.stdin, output: process.stdout }); t.question("输入编号 (回车=取消): ", a => { t.close(); r(a.trim()); }); });
    if (!ans) return null;
    const idx = parseInt(ans) - 1;
    return idx >= 0 && idx < items.length ? idx : null;
  }
  const sess = rawSession(rl);
  let sel = 0;
  const hint = "\x1b[90m  ↑↓ 选择 · Enter 确定 · ESC 取消\x1b[0m";
  const render = () => {
    // 初始渲染与 redraw 的结束光标位置必须一致（提示行尾、无换行），
    // 否则下一次方向键的上移锚点错位，列表逐次下移产生重复渲染
    process.stdout.write(title + "\n");
    items.forEach((it, i) => process.stdout.write((i === sel ? `\x1b[7m  ${it}\x1b[0m` : `  ${it}`) + "\n"));
    process.stdout.write(hint);
  };
  const redraw = () => {
    // 锚点：光标在提示行尾。上移 items.length 到首个列表项（标题行无需重绘），
    // 重写 items（各带换行）+ 提示行（无换行）→ 光标回到提示行尾，净位移 0 无漂移
    process.stdout.write(`\x1b[${items.length}A`);
    items.forEach((it, i) => {
      process.stdout.write(`\r\x1b[2K${i === sel ? `\x1b[7m  ${it}\x1b[0m` : `  ${it}`}\n`);
    });
    process.stdout.write(`\r\x1b[2K${hint}`);
  };
  render();
  return await new Promise<number | null>(resolve => {
    const onKey = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        sess.end(); process.stdout.write("\n"); resolve(null); return;
      }
      if (key.name === "return") {
        sess.end(); process.stdout.write("\n"); resolve(sel); return;
      }
      if (key.name === "up") { sel = (sel - 1 + items.length) % items.length; redraw(); return; }
      if (key.name === "down") { sel = (sel + 1) % items.length; redraw(); return; }
    };
    sess.onKey(onKey);
  });
}

async function promptSessionResume(
  agent: CortexAgent,
  rl: readline.Interface,
  maxShow = 15
): Promise<string | null | undefined> {
  // @ts-ignore — sessions is private but accessible for CLI
  const sessions = agent.sessions;
  if (!sessions) { console.log("(会话系统不可用)"); return undefined; }
  const list = sessions.listSessions() as Array<Record<string, unknown>>;
  if (!list.length) {
    console.log(`${GR}(无已保存的会话，将创建新会话)${G}`);
    return null;
  }
  // 非 TTY 直接用最近会话
  if (!process.stdin.isTTY) {
    console.error(`${YL}[resume] 非交互环境，恢复最近会话: ${String(list[0].session_id)}${G}`);
    return String(list[0].session_id);
  }
  const top = list.slice(0, maxShow);
  // @ts-ignore
  const sessionsDir = path.join(agent.config.workDir, "sessions");
  const n = top.length;

  // ── 渲染表头 ──
  const headerLines: string[] = [
    `\n${CY}╭${"─".repeat(58)}╮${G}`,
    `${CY}│${G}  📂 历史会话 (最近 ${top.length}/${list.length} 条)${" ".repeat(Math.max(0, 58 - 22 - String(top.length).length - String(list.length).length - 8))}${CY}│${G}`,
    `${CY}├${"─".repeat(58)}┤${G}`,
    `${CY}│${G} ${GR}#${G}  ${GR}${"SESSION_ID".padEnd(20)}${G} ${GR}${"时间".padEnd(11)}${G} ${GR}Q${G}  ${GR}预览${G}`,
  ];
  for (const l of headerLines) process.stdout.write(l + "\n");
  // 列表行（首次渲染，高亮第 0 项）
  const renderList = (selected: number): void => {
    for (let i = 0; i < n; i++) {
      process.stdout.write(renderSessionRow(top[i], i, n, sessionsDir, i === selected) + "\n");
    }
  };
  // 重绘列表：光标上移 n 行，从行首重写
  const redrawList = (selected: number): void => {
    process.stdout.write(`\x1b[${n}A`);
    for (let i = 0; i < n; i++) {
      process.stdout.write(`\r\x1b[2K` + renderSessionRow(top[i], i, n, sessionsDir, i === selected) + "\n");
    }
  };
  const footerHint = `  ${DM}↑↓ 移动 · 回车=确认 · 0/new=新建 · 数字快捷 · 或粘贴 session_id${G}`;

  // ── 文本输入回退（raw 模式不可用时）──
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
  async function textInputLoop(): Promise<string | null> {
    renderList(0);
    process.stdout.write(`${CY}╰${"─".repeat(58)}╯${G}\n${footerHint}\n`);
    for (;;) {
      const input = (await ask(`  ${GN}选择:${G} `)).trim();
      if (!input) return String(top[0].session_id);
      if (input === "0" || input.toLowerCase() === "n" || input.toLowerCase() === "new") return null;
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= n) return String(top[num - 1].session_id);
      if (!isNaN(num)) { console.log(`  ${RD}(x) 序号超出范围 1-${n}${G}`); continue; }
      const matches = top.filter(s => String(s.session_id).startsWith(input) || String(s.session_id).includes(input));
      if (matches.length === 1) return String(matches[0].session_id);
      const fullMatch = list.find(s => String(s.session_id) === input);
      if (fullMatch) return String(fullMatch.session_id);
      console.log(`  ${RD}(x) 无匹配，请重试${G}`);
    }
  }

  // ── raw 模式不可用 → 文本输入回退 ──
  // @ts-ignore — setRawMode 仅 TTY 可用
  if (typeof process.stdin.setRawMode !== "function") {
    return await textInputLoop();
  }

  // ── 交互式高亮选择（raw 模式捕获按键）──
  // 只打印表头 + 列表（暂不打印底框/提示），光标停在列表末行之后
  renderList(0);
  let selected = 0;

  return await new Promise<string | null>((resolve) => {
    const stdin = process.stdin;
    // 摘除 stdin 的 keypress 监听（含主 rl 内部的）并暂停 rl —— 防止数字/回车
    // 泄漏进主 rl 行缓冲（REPL 中 /resume 场景）；会话结束后恢复
    const savedKp = stdin.listeners("keypress").slice();
    savedKp.forEach(l => stdin.removeListener("keypress", l));
    rl.pause();
    // @ts-ignore
    stdin.setRawMode(true);
    stdin.setEncoding("utf-8");
    stdin.resume();

    const cleanup = (finalSel: number) => {
      // @ts-ignore
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      savedKp.forEach(l => stdin.on("keypress", l));
      if (!rlClosed(rl)) rl.resume();
      // 光标已在列表末行之后；最后一次重绘确保选中态正确，再打印底框+提示
      redrawList(finalSel);
      process.stdout.write(`${CY}╰${"─".repeat(58)}╯${G}\n${footerHint}\n`);
    };

    const onData = (chunk: string | Buffer) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
      let keyName = "";
      if (data === "\r" || data === "\n") keyName = "return";
      else if (data === "\x03") keyName = "ctrl-c";
      else if (data === "\x1b[A") keyName = "up";
      else if (data === "\x1b[B") keyName = "down";
      else if (data === "\x1b[C") keyName = "right";
      else if (data === "\x1b[D") keyName = "left";
      else if (data === "\x1b") keyName = "escape";

      if (keyName === "up") {
        selected = (selected - 1 + n) % n;
        redrawList(selected);
      } else if (keyName === "down") {
        selected = (selected + 1) % n;
        redrawList(selected);
      } else if (keyName === "return") {
        cleanup(selected);
        resolve(String(top[selected].session_id));
      } else if (keyName === "ctrl-c" || keyName === "escape") {
        cleanup(selected);
        resolve(null);  // 放弃 → 新建会话
      } else if (data >= "1" && data <= "9") {
        const num = parseInt(data, 10);
        if (num >= 1 && num <= n) {
          selected = num - 1;
          cleanup(selected);
          resolve(String(top[selected].session_id));
        }
      } else if (data === "0") {
        cleanup(selected);
        resolve(null);  // 新建
      }
      // 其他按键忽略；用户可用回车确认当前高亮项
    };
    stdin.on("data", onData);
  });
}

/** 单次运行（-q / 管道模式）结束后的审计与会话信息（原先在两处重复） */
function printRunEpilogue(agent: CortexAgent): void {
  const trace = agent.lastTrace;
  if (trace?.steps.length) {
    const totalMs = trace.steps.reduce((s, st) => s + st.latencyMs, 0);
    console.error(`\n[审计] ${trace.steps.length} 步, ${totalMs.toFixed(0)}ms`);
  }
  if (agent.sessionIdStr) {
    console.error(`[会话] ${agent.sessionIdStr}`);
  }
}

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
      web_search: { provider: "bing", brave_api_key: "", serpapi_api_key: "", tavily_api_key: "", zhipu_api_key: "", exa_api_key: "", firecrawl_api_key: "", max_results: 15, timeout: 10 },
      max_steps: 0, context_limit: 0, max_tokens: 0, max_input_tokens: 0, permission_mode: "standard",
      compress_threshold: 6000, compress_head: 2400, compress_tail: 1600, safety_margin: 4096,
      input_warn_pct: 80, input_force_pct: 90, compact_input_pct: 85, compact_keep_recent: 12,
      max_result_chars: 50000, memory_inject_count: 30,
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
      mcpServers: {
        "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], description: "Chrome DevTools — 浏览器导航/截图/DOM/性能分析" },
        "cua-driver": { command: "cua-driver", args: ["mcp"], description: "桌面控制 — 截图/点击/键盘/拖拽/滚动/应用管理" },
      },
      hooks: {},
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

    // ── 第 4 步: 联网搜索增强（可选）──
    console.log(`\n  ${C.YELLOW}🌐 联网搜索增强 (回车跳过 = 内置免费搜索):${C.RESET}`);
    const searchProviders: Array<[string, string, string, string, string]> = [
      ["1", "builtin",   "内置搜索（默认）", "Bing 抓取",            "完全免费 / 免配置"],
      ["2", "zhipu",     "智谱联网搜索",     "国内直连快 · 质量高",  "0.01元/次 · 需 API Key"],
      ["3", "tavily",    "Tavily",           "海外 · AI 优化搜索",   "1000次/月免费 · 需 Key"],
      ["4", "brave",     "Brave Search",     "海外 · 隐私搜索",      "$5/月免费额度 · 需 Key"],
      ["5", "exa",       "Exa",              "海外 · 神经搜索",      "注册送$20 · 需 Key"],
      ["6", "firecrawl", "Firecrawl",        "海外 · 搜索+抓取",     "1000次/月免费 · 需 Key"],
    ];
    for (const [k, , name, desc, pricing] of searchProviders) {
      const marker = k === "1" ? "★" : " ";
      console.log(`    ${C.GREEN}${marker} [${k}]${C.RESET} ${C.BOLD}${name.padEnd(12)}${C.RESET} ${C.DIM}${desc}${C.RESET}  ${C.GRAY}${pricing}${C.RESET}`);
    }
    const sChoice = (await ask(`  ${C.GREEN}请选择 (1-6):${C.RESET} `)).trim() || "1";
    const sEntry = searchProviders.find(p => p[0] === sChoice) || searchProviders[0];
    const searchProv = sEntry[1];
    const keyFieldMap: Record<string, string> = { zhipu: "zhipu_api_key", tavily: "tavily_api_key", brave: "brave_api_key", exa: "exa_api_key", firecrawl: "firecrawl_api_key" };
    const searchKeyUrls: Record<string, string> = {
      zhipu: "https://open.bigmodel.cn/console/apikeys",
      tavily: "https://app.tavily.com",
      brave: "https://api-dashboard.search.brave.com",
      exa: "https://dashboard.exa.ai/api-keys",
      firecrawl: "https://firecrawl.dev",
    };
    const searchKeys: Record<string, string> = {};
    if (searchProv !== "builtin") {
      console.log(`  ${C.GRAY}获取 Key: ${searchKeyUrls[searchProv] || ""}${C.RESET}`);
      const sk = (await ask(`  ${C.GREEN}API Key (回车跳过):${C.RESET} `)).trim();
      if (sk) searchKeys[keyFieldMap[searchProv]] = sk;
      else console.log(`  ${C.GRAY}已跳过 — 将使用内置免费搜索${C.RESET}`);
    }
    rl.close();
    const baseUrls: Record<string, string> = {
      deepseek: "https://api.deepseek.com/v1",
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com/v1",
      glm: "https://open.bigmodel.cn/api/paas/v4",
    };
    const userPath = path.join(os.homedir(), ".cortx", "settings.json");
    // 联网搜索配置：选了供应商且填了 key 才启用该引擎，否则回退内置 bing
    const effectiveSearchProv = (searchProv !== "builtin" && Object.keys(searchKeys).length > 0) ? searchProv : "bing";
    const webSearch: Record<string, unknown> = {
      provider: effectiveSearchProv,
      brave_api_key: "", serpapi_api_key: "", tavily_api_key: "",
      zhipu_api_key: "", exa_api_key: "", firecrawl_api_key: "",
      max_results: 15, timeout: 10,
      ...searchKeys,
    };
    // MCP 注册：内置预装 + 选用的搜索供应商
    const mcpServers: Record<string, unknown> = {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], description: "Chrome DevTools — 浏览器导航/截图/DOM/性能分析" },
      "cua-driver": { command: "cua-driver", args: ["mcp"], description: "桌面控制 — 截图/点击/键盘/拖拽/滚动/应用管理" },
    };
    if (searchProv === "zhipu" && searchKeys.zhipu_api_key) {
      mcpServers["zhipu-web-search"] = { url: "https://open.bigmodel.cn/api/mcp/web_search_pro/mcp", headers: { Authorization: `Bearer ${searchKeys.zhipu_api_key}` }, description: "智谱联网搜索 MCP — 国内直连" };
    } else if (searchProv === "tavily" && searchKeys.tavily_api_key) {
      mcpServers["tavily"] = { command: "npx", args: ["-y", "tavily-mcp@latest"], env: { TAVILY_API_KEY: searchKeys.tavily_api_key }, description: "Tavily 联网搜索 MCP" };
    } else if (searchProv === "brave" && searchKeys.brave_api_key) {
      mcpServers["brave-search"] = { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: searchKeys.brave_api_key }, description: "Brave Search MCP" };
    } else if (searchProv === "exa" && searchKeys.exa_api_key) {
      mcpServers["exa"] = { url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": searchKeys.exa_api_key }, description: "Exa 联网搜索 MCP" };
    } else if (searchProv === "firecrawl" && searchKeys.firecrawl_api_key) {
      mcpServers["firecrawl"] = { command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: searchKeys.firecrawl_api_key }, description: "Firecrawl 搜索+抓取 MCP" };
    }
    const newSettings = {
      model: modelAlias, provider: prov,
      providers: { [prov]: { api_key: apiKey, base_url: baseUrls[prov], models: { [modelAlias]: modelName } } },
      web_search: webSearch,
      max_steps: 0, context_limit: 0, max_tokens: 0, max_input_tokens: 0, permission_mode: "standard",
      compress_threshold: 6000, compress_head: 2400, compress_tail: 1600, safety_margin: 4096,
      input_warn_pct: 80, input_force_pct: 90, compact_input_pct: 85, compact_keep_recent: 12,
      max_result_chars: 50000, memory_inject_count: 30,
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
      mcpServers,
      hooks: {},
    };
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(newSettings, null, 2), "utf-8");
    console.log(`\n  ${C.GREEN}✅ 配置已保存${C.RESET}  ${C.GRAY}${userPath}${C.RESET}`);
    console.log(`  ${C.CYAN}▸ 提供商:${C.RESET} ${provName}  ${C.CYAN}▸ 模型:${C.RESET} ${modelAlias} (${modelName})`);
    console.log(`  ${C.CYAN}▸ 联网搜索:${C.RESET} ${effectiveSearchProv === "bing" ? "内置 Bing（免费）" : `${sEntry[2]} (${effectiveSearchProv})`}`);
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
    protocol: ((settings.providers?.[(settings.provider as string) || "deepseek"] as { protocol?: "openai-chat" | "openai-response" | "anthropic" } | undefined)?.protocol),
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
    compactInputPct: (settings.compact_input_pct as number) || 85,
    compactKeepRecent: (settings.compact_keep_recent as number) || 12,
  });

  // ── 加载 Hooks 配置 ──
  agent.hooks.loadFromConfig(settings);
  if (agent.hooks.count > 0) {
    console.error(`[cortex] ${agent.hooks.count} hooks loaded`);
  }

  // ── 工具白名单/黑名单 ──
  const allowedToolsIdx = args.indexOf("--allowed-tools");
  const disallowedToolsIdx = args.indexOf("--disallowed-tools");
  const allowedTools = allowedToolsIdx >= 0
    ? (args[allowedToolsIdx + 1] || "").split(",").map(s => s.trim()).filter(Boolean)
    : null;
  const disallowedTools = disallowedToolsIdx >= 0
    ? (args[disallowedToolsIdx + 1] || "").split(",").map(s => s.trim()).filter(Boolean)
    : null;
  if (allowedTools || disallowedTools) {
    agent.setToolFilter(allowedTools, disallowedTools);
    if (allowedTools) console.error(`[cortex] 工具白名单: ${allowedTools.join(", ")}`);
    if (disallowedTools) console.error(`[cortex] 工具黑名单: ${disallowedTools.join(", ")}`);
  }

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
  // 默认创建新会话（仅注入历史摘要）；-r/--resume 才恢复完整上下文
  // -r 不带 id 时弹出选择器；带 id 直接恢复
  const resumeIdx = args.findIndex(a => a === "--resume" || a === "-r");
  const isResume = resumeIdx >= 0;
  const isFlag = (s?: string) => !s || s.startsWith("-");
  const resumeArg = isResume ? args[resumeIdx + 1] : undefined;
  const resumeTarget = isResume && !isFlag(resumeArg) ? resumeArg : undefined;

  let resumeId: string | null | undefined = resumeTarget;
  if (isResume && !resumeTarget) {
    // 不带 id: 弹出选择器（banner 之前）
    const rlPick = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { resumeId = await promptSessionResume(agent, rlPick); }
    finally { rlPick.close(); }
  }

  if (isResume && resumeId) {
    // 有明确目标: 恢复完整上下文
    agent.initSession(resumeId, true);
  } else if (isResume && resumeId === null) {
    // 用户在选择器里选了"新建"
    agent.initSession(undefined, false);
  } else if (isResume) {
    // 非 TTY 等场景退回默认 (getLastSession)
    agent.initSession(undefined, true);
  } else {
    agent.initSession(undefined, false);
  }

  if (!noStream) {
    term.banner(agent.config.model, registry.schemaList.length, agent.config.workDir, agent.config.permissionMode, agent.sessionIdStr || undefined, agent.contextLimit, isResume);
  }

  // ── 管道模式 (-p) ──
  // 从 stdin 读取输入，非交互执行，输出结果到 stdout
  const pipeIdx = args.indexOf("-p");
  const isPipe = pipeIdx >= 0 || (!process.stdin.isTTY && !query);
  if (isPipe) {
    agent.setNonInteractive(true);
    const pipePrompt = pipeIdx >= 0 ? (args[pipeIdx + 1] || "") : "";
    let stdinData = "";
    if (!process.stdin.isTTY) {
      try {
        stdinData = await new Promise<string>((resolve, reject) => {
          let data = "";
          process.stdin.setEncoding("utf-8");
          let done = false;
          const finish = (err?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            process.stdin.removeListener("error", onError);
            if (err) reject(err); else resolve(data);
          };
          const onData = (chunk: string) => { data += chunk; };
          const onEnd = () => finish();
          const onError = (err: Error) => finish(err);
          // 5 秒超时（stdin 未关闭时兜底，如终端直接管道等待）
          const timer = setTimeout(() => finish(), 5000);
          process.stdin.on("data", onData);
          process.stdin.on("end", onEnd);
          process.stdin.on("error", onError);
        });
      } catch { /* ignore */ }
    }
    let combinedQuery = "";
    if (pipePrompt && stdinData.trim()) {
      combinedQuery = `${pipePrompt}\n\n--- stdin 内容 ---\n${stdinData.trim()}`;
    } else if (pipePrompt) {
      combinedQuery = pipePrompt;
    } else if (stdinData.trim()) {
      combinedQuery = stdinData.trim();
    } else {
      console.error('[cortex] 管道模式需要提供输入 (-p "prompt" 或 stdin)');
      return;
    }
    const answer = longMode
      ? await agent.runLong(combinedQuery)
      : await agent.run(combinedQuery);
    // 管道模式强制输出结果到 stdout（即使流式模式也输出最终文本）
    if (noStream) console.log(answer);
    printRunEpilogue(agent);
    return;
  }

  if (query) {
    const answer = longMode
      ? await agent.runLong(query)
      : await agent.run(query);
    if (noStream) console.log(answer);
    printRunEpilogue(agent);
    return;
  }

  // ── REPL ──
  // 斜杠命令列表（用于自动补全）
  // @ 引用功能入口（与文件/文件夹一起出现在 @ 补全列表；选中注入对应能力说明）
  const AT_ENTRIES: Array<{ name: string; icon: string; desc: string }> = [
    { name: "browser", icon: "🌐", desc: "浏览器控制 — 导航/快照/截图" },
    { name: "computer", icon: "🖥", desc: "电脑控制 — 桌面截图/鼠标点击" },
    { name: "skills", icon: "🧠", desc: "技能列表 — 可用专家指引" },
    { name: "mcp", icon: "🔌", desc: "MCP 服务器 — 已配置/注册表" },
  ];
  const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
    { cmd: "/help", desc: "显示帮助" },
    { cmd: "/tools", desc: "列出工具" },
    { cmd: "/skills", desc: "列出技能" },
    { cmd: "/skill ", desc: "调用技能 <name>" },
    { cmd: "/model ", desc: "切换模型/提供商 <别名|glm|glm/5.2>" },
    { cmd: "/mode ", desc: "切换权限 <s|a|y>" },
    { cmd: "/context", desc: "上下文容量+缓存" },
    { cmd: "/memory", desc: "查看记忆" },
    { cmd: "/forget ", desc: "删除记忆 <name>" },
    { cmd: "/save", desc: "保存会话" },
    { cmd: "/sessions", desc: "列出会话" },
    { cmd: "/resume ", desc: "恢复会话 [id]" },
    { cmd: "/reset", desc: "重置上下文" },
    { cmd: "/trace", desc: "最后轨迹" },
    { cmd: "/audit", desc: "审计轨迹" },
    { cmd: "/kb", desc: "查看知识库" },
    { cmd: "/init", desc: "初始化项目" },
    { cmd: "/goal ", desc: "设置目标" },
    { cmd: "/plan ", desc: "规划模式" },
    { cmd: "/hooks", desc: "钩子管理" },
    { cmd: "/subagents", desc: "查看子代理结果" },
    { cmd: "/subagent ", desc: "查看子代理详情 <id>" },
    { cmd: "/exit", desc: "退出" },
  ];

  // 自动补全提示渲染状态
  let _hintLines = 0;
  let _hintSelected = 0;
  let _hintItems: { text: string; completion: string }[] = [];
  // 补全提示配色：YL 用更醒目的黄色（33），其余复用模块级 CY/GR/G
  const YL = "\x1b[33m";
  const HL = "\x1b[7m"; // 反色高亮

  function clearHint() {
    if (_hintLines > 0) {
      for (let i = 0; i < _hintLines; i++) process.stdout.write(`\x1b[B\x1b[2K`);
      for (let i = 0; i < _hintLines; i++) process.stdout.write(`\x1b[A`);
      _hintLines = 0;
      _hintItems = [];
      _hintSelected = 0;
    }
  }

  function computeHints(line: string): { text: string; completion: string }[] {
    if (line.startsWith("/")) {
      const matches = SLASH_COMMANDS.filter(c => c.cmd.trim().startsWith(line.trim()));
      return matches.slice(0, 7).map(c => ({
        text: `  ${CY}${c.cmd.trim()}${G} ${GR}${c.desc}${G}`,
        completion: c.cmd.trim() + (c.cmd.endsWith(" ") ? "" : " "),
      }));
    }
    if (line.includes("@")) {
      const atIdx = line.lastIndexOf("@");
      const prefix = line.slice(atIdx + 1).split(/\s/)[0];
      const items: { text: string; completion: string }[] = [];
      // ── 功能入口（browser/computer/skills 等，前缀匹配）──
      for (const entry of AT_ENTRIES) {
        if (entry.name.startsWith(prefix.toLowerCase())) {
          items.push({
            text: `  ${entry.icon} ${YL}@${entry.name}${G} ${GR}${entry.desc}${G}`,
            completion: line.slice(0, atIdx + 1) + entry.name + " ",
          });
        }
      }
      // ── 文件/文件夹（📁 目录可继续层级导航）──
      try {
        // 注意：prefix 为空时保持空串（`prefix || "."` 会把空前缀变成 '.' 导致文件全被过滤）
        const dir = path.dirname(prefix) || ".";
        const filePrefix = path.basename(prefix);
        const searchDir = dir === "." ? workDir : path.resolve(workDir, dir);
        const files = fs.readdirSync(searchDir)
          .filter(f => f.startsWith(filePrefix) && !f.startsWith("."))
          .slice(0, 7 - items.length);
        for (const f of files) {
          const full = (dir === "." ? "" : dir + "/") + f;
          let isDir = false;
          try { isDir = fs.statSync(path.join(searchDir, f)).isDirectory(); } catch { /* ignore */ }
          items.push({
            text: `  ${isDir ? "📁" : "📄"} ${YL}@${full}${G}`,
            // 目录补全带 / 触发下一级 hints；文件带空格完成
            completion: line.slice(0, atIdx + 1) + full + (isDir ? "/" : " "),
          });
        }
      } catch { /* ignore */ }
      return items.slice(0, 7);
    }
    return [];
  }

  /** 渲染 hint 块（items + 底部操作提示行）——renderHint / reselectHint 共用 */
  function writeHintBlock() {
    const lines = _hintItems.map((item, i) => {
      // 选中项：加 ► 前缀 + 反色
      return i === _hintSelected
        ? `  ${HL}► ${item.text.replace(/^  /, "")}${G}`
        : `    ${item.text.replace(/^  /, "")}`;
    });
    lines.push(`  ${GR}↑↓ 选择 · Tab 确认补全 · Enter 提交 · ESC 关闭${G}`);
    process.stdout.write("\x1b[s\n" + lines.join("\n") + "\n\x1b[u");
  }

  function renderHint(line: string) {
    clearHint();
    _hintItems = computeHints(line);
    if (_hintSelected >= _hintItems.length) _hintSelected = 0;
    if (_hintItems.length > 0) {
      writeHintBlock();
      _hintLines = _hintItems.length + 2;
    }
  }

  function reselectHint(dir: "up" | "down") {
    if (_hintItems.length === 0) return;
    if (dir === "up") _hintSelected = (_hintSelected - 1 + _hintItems.length) % _hintItems.length;
    else _hintSelected = (_hintSelected + 1) % _hintItems.length;
    // 重绘提示（不清除 items，只重绘）
    if (_hintLines > 0) {
      for (let i = 0; i < _hintLines; i++) process.stdout.write(`\x1b[B\x1b[2K`);
      for (let i = 0; i < _hintLines; i++) process.stdout.write(`\x1b[A`);
      writeHintBlock();
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string): [string[], string] => {
      if (line.startsWith("/")) {
        const hits = SLASH_COMMANDS.map(c => c.cmd.trim()).filter(cmd => cmd.startsWith(line.trim()));
        return [hits.length ? hits : [], line];
      }
      if (line.includes("@")) {
        const atIdx = line.lastIndexOf("@");
        const prefix = line.slice(atIdx + 1).split(/\s/)[0];
        try {
          const dir = path.dirname(prefix || ".");
          const filePrefix = path.basename(prefix || ".");
          const searchDir = dir === "." ? workDir : path.resolve(workDir, dir);
          const files = fs.readdirSync(searchDir).filter(f => f.startsWith(filePrefix));
          const completions = files.map(f => line.slice(0, atIdx + 1) + (dir === "." ? "" : dir + "/") + f);
          return [completions, line];
        } catch {}
      }
      return [[], line];
    },
  });
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
    curPromptStr = `${mc}${ml}\x1b[0m ${pc}${pct}%\x1b[0m${cacheStr}> `;
  };
  // 当前 prompt 字符串（供 @ 补全的原地自绘使用）
  let curPromptStr = "";
  // 命令处理完重绘提示符（原 50 处 showPrompt(); rl.prompt(); 的统一封装）
  const reprompt = () => { showPrompt(); rl.prompt(); };

  // ── 补全会话（@ 引用 / 斜杠命令）──
  // 交互目标（对齐 Codex/Claude Code）：↑↓ 选择、Tab/Enter 确认补全（行内原地、光标在尾、
  // 可继续输入文字）、Enter 提交、ESC 关闭。含 URL/API 地址等任意文本的原行编辑。
  // 实现：会话期间把 rl.output 指向黑洞流 — readline 照常处理按键（其内部 line/cursor
  // 始终是唯一数据源），但显示全部被吞，由我们自绘行 + hints；结束会话时恢复 output
  // 并 rl.prompt() 一次同步显示（readline 状态与屏幕一致，无错位）。
  let _acActive = false;
  let _acOrigOut: NodeJS.WritableStream | null = null;
  const _blackhole = new (require("stream").Writable)({ write(_c: unknown, _e: unknown, cb: (err?: Error | null) => void) { cb(); } });
  const rlAny = rl as unknown as { line: string; cursor: number; output: NodeJS.WritableStream };

  function _acStart(): void {
    if (_acActive) return;
    _acActive = true;
    _acOrigOut = rlAny.output;
    rlAny.output = _blackhole as NodeJS.WritableStream;
  }
  function _acRedraw(): void {
    // 自绘当前行：\r 回行首 + 清行 + prompt + readline 的行内容（光标自然在行尾）
    _acOrigOut?.write(`\r\x1b[2K${curPromptStr}${rlAny.line}`);
  }
  function _acEnd(redraw = true): void {
    if (!_acActive) return;
    _acActive = false;
    rlAny.output = _acOrigOut!;
    clearHint();
    if (redraw) {
      rlAny.cursor = rlAny.line.length;
      // 自绘收尾（不用 rl.prompt()——readline 的增量光标计算在黑洞流干扰后不可靠，
      // 曾导致光标跳行首）。自绘写入的光标物理上就在行尾；且与 readline 后续
      // _refreshLine 的假设（光标在渲染行尾）一致，后续输入/退格正常。
      _acOrigOut!.write(`\r\x1b[2K${curPromptStr}${rlAny.line}`);
    }
  }
  /** 会话进入/保持条件：/ 开头（斜杠命令），或最后一个 @ 之后无空格（@ 引用尚未完成）。
   *  @ 引用后已接空格（用户正在输入正文/URL 等）→ 不保持会话，Enter 即提交 */
  function _acShouldStart(line: string): boolean {
    if (line.startsWith("/")) return true;
    if (!line.includes("@")) return false;
    const atIdx = line.lastIndexOf("@");
    return !/\s/.test(line.slice(atIdx));
  }

  // Shift+Tab to cycle permission mode + live autocomplete hints
  process.stdin.on("keypress", (_str: string, key: any) => {
    // Shift+Tab: 切换权限模式（会话中先结束会话，避免 prompt 输出进黑洞）
    if (key && key.name === "tab" && key.shift) {
      if (_acActive) _acEnd();
      const modes = ["standard", "auto", "yolo"];
      const idx = modes.indexOf(agent.config.permissionMode);
      const next = modes[(idx + 1) % 3] as "standard" | "auto" | "yolo";
      agent.config.permissionMode = next;
            reprompt();
      return;
    }
    // ── 会话中的按键处理 ──
    if (_acActive && key) {
      if (key.name === "up" || (key.name === "p" && key.ctrl)) { reselectHint("up"); return; }
      if (key.name === "down" || (key.name === "n" && key.ctrl)) { reselectHint("down"); return; }
      // ESC: 结束会话（行保留）
      if (key.name === "escape") { _acEnd(); return; }
      // Tab / Enter：确认选中项补全（不提交）
      if (key.name === "tab" || key.name === "return") {
        if (_hintItems.length > 0 && _hintSelected < _hintItems.length) {
          const completion = _hintItems[_hintSelected].completion;
          clearHint();
          // 通过 readline 通道同步状态（ctrl-u 清行 + 写入；echo 进黑洞）
          rl.write("", { ctrl: true, name: "u" });
          rl.write(completion);
          setImmediate(() => {
            _acRedraw();
            _hintSelected = 0;
            renderHint(rlAny.line);
            if (!completion.endsWith("/")) {
              // 文件/命令/功能项补全完成 → 结束会话，readline 接管后续输入
              _acEnd();
            }
            // 目录项（尾 / ）→ 会话继续，展示下一级
          });
          return;
        }
        // 无候选项：Enter → 提交（结束会话并让 readline 重发回车）
        if (key.name === "return") {
          _acEnd(false);
          rl.write("\r");
          return;
        }
      }
    }
    // 延迟一帧让 readline 更新 rl.line，然后驱动会话/hints
    setImmediate(() => {
      const line = rlAny.line || "";
      if (_acActive) {
        _acRedraw();
        _hintSelected = 0;
        renderHint(line);
        // 用户删掉了 @ 且不以 / 开头 → 会话自然结束
        if (!_acShouldStart(line)) _acEnd();
        return;
      }
      if (_acShouldStart(line) && (_str === "@" || (_str === "/" && line === "/") || line.includes("@") || line.startsWith("/"))) {
        _acStart();
        _acRedraw();
        _hintSelected = 0;
        renderHint(line);
        return;
      }
      if (line.startsWith("/") || line.includes("@")) {
        _hintSelected = 0;
        renderHint(line);
      } else {
        clearHint();
      }
    });
  });

  // ── Ctrl+C 处理 ──
  // readline 无 SIGINT 监听时的默认行为是 close() 接口 → 后续 rl.prompt() 抛
  // ERR_USE_AFTER_CLOSE。注册监听改为：补全会话中结束会话；单击清行提示；双击退出。
  let _lastSigint = 0;
  rl.on("SIGINT", () => {
    if (_acActive) { _acEnd(); return; }
    const now = Date.now();
    if (now - _lastSigint < 2000) {
      try { agent.saveSession(); } catch { /* ignore */ }
      console.log(`\n\x1b[33mBye.\x1b[0m  \x1b[90mSession: ${agent.sessionIdStr || "?"}\x1b[0m`);
      process.exit(0);
    }
    _lastSigint = now;
    rl.write("", { ctrl: true, name: "u" });
    process.stdout.write("\r\x1b[2K\x1b[90m(再按一次 Ctrl+C 退出)\x1b[0m\r\n");
    reprompt();
  });

  console.log("Cortex Agent REPL — /help /exit\n");
    reprompt();

  for await (const line of rl) {
    clearHint();
    // 补全会话中 readline 因 Enter 确认补全而 emit 的 line：丢弃（真实提交由
    // 会话的"无候选 Enter"路径显式触发 rl.write('\r')）
    if (_acActive) continue;
    const q = line.trim();
    if (!q) { reprompt(); continue; }
    if (["/exit", "/quit", "/q"].includes(q)) {
      agent.saveSession();
      console.log(`\x1b[33mBye.\x1b[0m  \x1b[90mSession: ${agent.sessionIdStr || "?"}\x1b[0m`);
      break;
    }
    if (["/help", "/h", "/?"].includes(q)) {
      console.log(`  \x1b[36m═══ 会话管理 ═══\x1b[0m`);
      console.log(`  \x1b[36m/save\x1b[0m           保存会话`);
      console.log(`  \x1b[36m/sessions\x1b[0m       列出会话`);
      console.log(`  \x1b[36m/resume [id]\x1b[0m     恢复会话 (无 id 弹选择器)`);
      console.log(`  \x1b[36m/reset\x1b[0m          重置上下文`);
      console.log(`  \x1b[36m═══ 工具 & 模型 ═══\x1b[0m`);
      console.log(`  \x1b[36m/tools\x1b[0m          列出工具`);
      console.log(`  \x1b[36m/model [glm/5.2]\x1b[0m  切换模型/提供商`);
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
      console.log(`  \x1b[36m═══ 子代理 ═══\x1b[0m`);
      console.log(`  \x1b[36m/subagents\x1b[0m     查看子代理结果摘要`);
      console.log(`  \x1b[36m/subagent <id>\x1b[0m  查看子代理完整输出`);
      console.log(`  \x1b[36m═══ 钩子 ═══\x1b[0m`);
      console.log(`  \x1b[36m/hooks\x1b[0m         查看/启停生命周期钩子`);
      reprompt(); continue;
    }
    // ── /hooks ──
    if (q === "/hooks") {
      const h = agent.hooks;
      console.log(`  \x1b[36mHooks 系统\x1b[0m (${h.count} 个钩子, ${h.isEnabled() ? "启用" : "禁用"})`);
      console.log(`  ${"\x1b[90m"}${"─".repeat(40)}${"\x1b[0m"}`);
      if (h.count === 0) {
        console.log("  (无已配置的钩子)");
        console.log(`  ${"\x1b[90m"}在 settings.json 中配置 "hooks" 字段${"\x1b[0m"}`);
      } else {
        console.log(`  /hooks on    启用钩子`);
        console.log(`  /hooks off   禁用钩子`);
      }
      reprompt(); continue;
    }
    if (q === "/hooks on") { agent.hooks.setEnabled(true); console.log("钩子已启用"); reprompt(); continue; }
    if (q === "/hooks off") { agent.hooks.setEnabled(false); console.log("钩子已禁用"); reprompt(); continue;
    }
    // ── /tools ──
    if (["/tools", "/t"].includes(q)) {
      for (const s of registry.schemaList) {
        const n = s.function.name; const m = registry.meta(n);
        console.log(`  \x1b[36m${n}\x1b[0m [${m?.capability || "?"}]`);
        console.log(`    ${s.function.description}`);
      }
      reprompt(); continue;
    }
    // ── /model ──
    if (q === "/model" || q === "/m") {
      // 方向键选择 selectList + 行输入 askInput（均与主 rl 按键隔离，ESC 取消）
      let curProvider = "deepseek";
      const providerModels: Record<string, { hasKey: boolean; models: string[]; current: boolean; builtin: boolean; baseUrl?: string; protocol?: string }> = {};
      try {
        const st = loadSettings();
        curProvider = (st.provider as string) || "deepseek";
        for (const [pid, pc] of Object.entries((st.providers || {}) as Record<string, Record<string, unknown>>)) {
          providerModels[pid] = {
            hasKey: !!pc.api_key,
            models: Object.keys((pc.models as Record<string, string>) || {}),
            current: pid === curProvider,
            builtin: false,
            baseUrl: pc.base_url as string,
            protocol: pc.protocol as string,
          };
        }
      } catch { /* ignore */ }
      // 合并内置表：已配置的补充全量模型；未配置的也列出（可现场添加 Key）
      try {
        const { DEFAULT_PROVIDERS } = await import("../core/llm.js");
        for (const [pid, cfg] of Object.entries(DEFAULT_PROVIDERS)) {
          if (providerModels[pid]) {
            const builtin = Object.keys(cfg.models || {});
            providerModels[pid].models = [...new Set([...providerModels[pid].models, ...builtin])];
          } else {
            providerModels[pid] = {
              hasKey: false,
              models: Object.keys(cfg.models || {}),
              current: pid === curProvider,
              builtin: true,
              baseUrl: cfg.baseUrl,
              protocol: (cfg as { protocol?: string }).protocol,
            };
          }
        }
      } catch { /* ignore */ }
      console.log(`当前: ${curProvider} → ${agent.config.model}\n`);
      const pids = Object.keys(providerModels);
      const provItems = pids.map(pid => {
        const info = providerModels[pid];
        const mark = info.current ? "★" : " ";
        const keyNote = info.hasKey ? "" : info.builtin ? "\x1b[90m (未配置 Key，选择后可添加)\x1b[0m" : "\x1b[90m (未配置 Key)\x1b[0m";
        return `${mark} \x1b[36m${pid.padEnd(15)}\x1b[0m ${info.models.slice(0, 4).join(", ")}${info.models.length > 4 ? " ..." : ""}${keyNote}`;
      }).concat("➕ \x1b[33m自定义提供商 (填入 API 地址和 Key)\x1b[0m");
      const provSel = await selectList(rl, "选择提供商:", provItems);
      if (provSel === null) { console.log("(已取消)"); reprompt(); continue; }
      // ── 自定义提供商流程 ──
      if (provSel === provItems.length - 1) {
        const baseUrl = await askInput(rl, "API 地址 base_url (如 https://api.example.com/v1): ");
        if (!baseUrl) { console.log("(已取消)"); reprompt(); continue; }
        const protoSel = await selectList(rl, "选择协议:", ["openai-chat（OpenAI Chat Completion，默认）", "openai-response（OpenAI Response 协议）", "anthropic（Anthropic Message 协议）"]);
        if (protoSel === null) { console.log("(已取消)"); reprompt(); continue; }
        const protocol = ["openai-chat", "openai-response", "anthropic"][protoSel];
        const apiKey = await askInput(rl, "API Key (回车=稍后配置): ");
        if (apiKey === null) { console.log("(已取消)"); reprompt(); continue; }
        const modelName = await askInput(rl, "模型名 (如 qwen-max / my-model): ");
        if (!modelName) { console.log("(已取消)"); reprompt(); continue; }
        // 保存自定义提供商条目
        try {
          const fsMod = require("fs");
          const userPath = require("path").join(require("os").homedir(), ".cortx", "settings.json");
          const data = JSON.parse(fsMod.readFileSync(userPath, "utf-8"));
          data.providers = data.providers || {};
          data.providers.custom = {
            api_key: apiKey || "",
            base_url: baseUrl,
            ...(protocol !== "openai-chat" ? { protocol } : {}),
            models: { [modelName]: modelName },
          };
          fsMod.writeFileSync(userPath, JSON.stringify(data, null, 2), "utf-8");
          console.log(`✅ 已保存自定义提供商 (custom): ${baseUrl}`);
          console.log(agent.switchProvider("custom", modelName));
        } catch (e) { console.log(`(x) 保存失败: ${e}`); }
        reprompt(); continue;
      }
      const selPid = pids[provSel];
      const selInfo = providerModels[selPid];
      // 未配置 Key：进入提供商配置向导（参考行业软件：API 地址 → Key → 选模型 → 保存切换）
      if (!selInfo.hasKey) {
        if (!selInfo.builtin) {
          console.log(`(x) 提供商 ${selPid} 未配置 API Key\n请在 ~/.cortx/settings.json 的 providers.${selPid}.api_key 填入`);
          reprompt(); continue;
        }
        const keyUrls: Record<string, string> = {
          deepseek: "https://platform.deepseek.com/api_keys",
          openai: "https://platform.openai.com/api-keys",
          glm: "https://open.bigmodel.cn/console/apikeys",
          "glm-responses": "https://open.bigmodel.cn/console/apikeys",
          "glm-anthropic": "https://open.bigmodel.cn/console/apikeys",
          anthropic: "https://console.anthropic.com/settings/keys",
        };
        console.log(`\n\x1b[36m══ 配置提供商 ${selPid} ══\x1b[0m`);
        console.log(`获取 Key: ${keyUrls[selPid] || "(查阅该提供商官网)"}\n`);
        // 步骤 1：API 地址（回车=默认，可自定义 OpenAI/Anthropic 兼容地址）
        const urlInput = await askInput(rl, `API 地址 (回车=默认 ${selInfo.baseUrl}): `);
        if (urlInput === null) { console.log("(已取消)"); reprompt(); continue; }
        const baseUrl = urlInput || selInfo.baseUrl!;
        // 协议：内置条目自带；自定义地址按规则推断（/anthropic→anthropic、智谱/api/v1→responses）
        let protocol = selInfo.protocol;
        if (urlInput && !protocol) {
          const { inferProtocol } = await import("../core/llm.js");
          protocol = inferProtocol(baseUrl);
        }
        // 步骤 2：API Key
        const newKey = await askInput(rl, "API Key: ");
        if (!newKey) { console.log("(已取消，未添加)"); reprompt(); continue; }
        // 步骤 3：选模型（方向键，来自内置表）
        let selAlias = selInfo.models[0];
        if (selInfo.models.length > 0) {
          const mSel = await selectList(rl, `选择 ${selPid} 模型:`, selInfo.models.map(m => `  ${m}`));
          if (mSel === null) { console.log("(已取消)"); reprompt(); continue; }
          selAlias = selInfo.models[mSel];
        }
        // 保存提供商条目（地址 + Key + 协议 + 全量模型映射）
        try {
          const fsMod = require("fs");
          const userPath = require("path").join(require("os").homedir(), ".cortx", "settings.json");
          const data = JSON.parse(fsMod.readFileSync(userPath, "utf-8"));
          data.providers = data.providers || {};
          data.providers[selPid] = {
            api_key: newKey,
            base_url: baseUrl,
            ...(protocol ? { protocol } : {}),
          };
          try {
            const { DEFAULT_PROVIDERS } = await import("../core/llm.js");
            const bm = DEFAULT_PROVIDERS[selPid]?.models || {};
            data.providers[selPid].models = { ...bm };
          } catch { /* ignore */ }
          fsMod.writeFileSync(userPath, JSON.stringify(data, null, 2), "utf-8");
          console.log(`✅ 已添加提供商 ${selPid} (${baseUrl})`);
        } catch (e) { console.log(`(x) 保存失败: ${e}`); reprompt(); continue; }
        console.log(agent.switchProvider(selPid, selAlias));
        reprompt(); continue;
      }
      // 二级：选模型（方向键）
      const selModels = providerModels[selPid].models;
      if (!selModels.length) { console.log("(该提供商无模型映射)"); reprompt(); continue; }
      const modelSel = await selectList(rl, `选择 ${selPid} 模型:`, selModels.map(m => `  ${m}`));
      if (modelSel === null) { console.log("(已取消)"); reprompt(); continue; }
      console.log(agent.switchProvider(selPid, selModels[modelSel]));
      reprompt(); continue;
    }
    if (q.startsWith("/model ") || q.startsWith("/m ")) {
      const arg = q.split(" ", 2)[1].trim();
      if (arg.includes("/")) {
        // provider/alias 形式：切换提供商 + 指定模型
        const [pid, alias] = arg.split("/", 2);
        console.log(agent.switchProvider(pid, alias));
      } else {
        // 纯 provider 名（且不是当前提供商的模型别名）→ 切提供商默认模型
        let curModels: string[] = [];
        let isProviderName = false;
        try {
          const st = loadSettings();
          isProviderName = !!st.providers?.[arg.toLowerCase()];
          curModels = Object.keys((st.providers?.[(st.provider as string) || "deepseek"]?.models as Record<string, string>) || {});
        } catch { /* ignore */ }
        if (isProviderName && !curModels.includes(arg)) {
          console.log(agent.switchProvider(arg));
        } else {
          agent.switchModel(arg);
          console.log(`→ ${agent.config.model}`);
        }
      }
      reprompt(); continue;
    }
    // ── /mode ──
    if (q === "/mode" || q === "/permissions") {
      console.log(`当前: ${agent.config.permissionMode}\n`);
      const modeSel = await selectList(rl, "切换权限模式:", [
        "\x1b[32mstandard\x1b[0m — 标准模式（文件操作全路径放行，SYSTEM 区内放行）",
        "\x1b[33mauto\x1b[0m    — 自动批准编辑 + SYSTEM 放行",
        "\x1b[31myolo\x1b[0m     — 全部放行（谨慎使用）",
      ]);
      if (modeSel === null) { console.log("(已取消)"); reprompt(); continue; }
      console.log(agent.switchPermissionMode(["standard", "auto", "yolo"][modeSel]));
      reprompt(); continue;
    }
    if (q.startsWith("/mode ") || q.startsWith("/permissions ")) { console.log(agent.switchPermissionMode(q.split(" ", 2)[1])); reprompt(); continue; }
    // ── /save ──
    if (q === "/save" || q === "/s") { agent.saveSession(); console.log(`会话已保存: ${agent.sessionIdStr}`); reprompt(); continue; }
    // ── /sessions ──
    if (q === "/sessions" || q === "/ls") {
      // @ts-ignore
      const sessions = agent.sessions;
      if (!sessions) { console.log("(会话系统不可用)"); }
      else {
        const list = sessions.listSessions();
        if (!list.length) { console.log("(无已保存的会话)"); }
        else {
          const sessSel = await selectList(rl, `会话 (${list.length} 个) — 选择恢复:`,
            list.slice(0, 15).map(s => `${String(s.session_id).slice(0, 20)}  Q=${s.query_count || 0}  ${String(s.last_active || "").slice(0, 19)}`));
          if (sessSel === null) { console.log("(已取消)"); }
          else {
            const sid = String(list[sessSel].session_id);
            if (agent.resumeSession(sid)) console.log(`\x1b[32m已恢复会话:\x1b[0m ${sid}`);
            else console.log(`\x1b[31m(x) 恢复失败:\x1b[0m ${sid}`);
          }
        }
      }
      reprompt(); continue;
    }
    // ── /resume [id] ──  不带 id 弹出选择器（与 CLI `ctx -r` 一致）
    if (q === "/resume" || q === "/r") {
      const picked = await promptSessionResume(agent, rl);
      if (picked && agent.resumeSession(picked)) {
        console.log(`${GN}已恢复会话:${G} ${picked}`);
      } else if (picked === null) {
        agent.initSession(undefined, false);  // 真正新建会话（与 CLI `ctx -r` 选"新建"一致）
        console.log(`${GN}已新建会话:${G} ${agent.sessionIdStr}`);
      } else if (picked) {
        console.log(`${RD}(x) 会话不存在或恢复失败:${G} ${picked}`);
      }
      reprompt(); continue;
    }
    if (q.startsWith("/resume ") || q.startsWith("/r ")) {
      const target = q.split(" ").slice(1).join(" ").trim();
      if (agent.resumeSession(target)) { console.log(`${GN}已恢复会话:${G} ${target}`); }
      else { console.log(`${RD}(x) 会话不存在或恢复失败:${G} ${target}`); }
      reprompt(); continue;
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
      reprompt(); continue;
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
      reprompt(); continue;
    }
    // ── /kb — 查看知识库 ──
    if (q === "/kb") {
      const kbPath = path.join(agent.config.workDir, "CORTEX.md");
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
      reprompt(); continue;
    }
    // ── /init — 初始化项目 CORTEX.md ──
    if (q === "/init") {
      const kbPath = path.join(agent.config.workDir, "CORTEX.md");
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
      reprompt(); continue;
    }
    // ── /memory ──
    if (q === "/memory" || q === "/mem") {
      if (!agent.memory) { console.log("(记忆系统不可用)"); }
      else {
        const facts = agent.memory.listAll();
        if (!facts.length) console.log("(没有记住任何事实)");
        else for (const f of facts) console.log(`  \x1b[36m${f}\x1b[0m`);
      }
      reprompt(); continue;
    }
    // ── /forget ──（无参 → 方向键选择删除）
    if (q === "/forget") {
      if (!agent.memory) { console.log("(记忆系统不可用)"); }
      else {
        const facts = agent.memory.listAll();
        if (!facts.length) console.log("(没有记住任何事实)");
        else {
          const fSel = await selectList(rl, `记忆条目 (${facts.length} 个) — 选择删除:`, facts.slice(0, 15).map(f => String(f).slice(0, 60)));
          if (fSel === null) { console.log("(已取消)"); }
          else if (agent.memory.remove(facts[fSel])) console.log(`已忘记: ${facts[fSel]}`);
          else console.log(`(x) 删除失败`);
        }
      }
      reprompt(); continue;
    }
    if (q.startsWith("/forget ")) {
      const name = q.split(" ", 2)[1].trim();
      if (!agent.memory) { console.log("(记忆系统不可用)"); }
      else {
        if (agent.memory.remove(name)) console.log(`已忘记: ${name}`);
        else console.log(`(x) 未找到: ${name}`);
      }
      reprompt(); continue;
    }
    // ── /reset ──
    if (q === "/reset") { agent.reset(); console.log("上下文已重置（含拒绝计数和暂停状态）"); reprompt(); continue; }
    // ── /context ──
    if (q === "/context") {
    const ctx = agent.contextTokens;
    const lim = agent.contextLimit;
    const pct = agent.contextPct;
    const inPct = agent.inputTokensPct;
    const color = pct < 50 ? "\x1b[38;5;82m" : (pct < 80 ? "\x1b[38;5;220m" : "\x1b[38;5;196m");
    const msgs = agent.contextMessages;
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
          const kbPath = path.join(agent.config.workDir, "CORTEX.md");
          const kbStatus = fs.existsSync(kbPath) ? `${GN}已加载${G}` : `${GR}未创建${G}`;
          console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
          console.log(`  ${CY}│${G}  📚 知识库                                    ${CY}│${G}`);
          console.log(`  ${CY}├${"─".repeat(46)}┤${G}`);
          console.log(`  ${CY}│${G}  CORTEX.md: ${kbStatus}                          ${CY}│${G}`);
          console.log(`  ${CY}╰${"─".repeat(46)}╯${G}`);
          reprompt(); continue;
        }
// ── /skills — 列出技能 ──
    if (q === "/skills" || q === "/skill") {
      const mgr = agent.skillMgr;
      if (!mgr || !mgr.listAll().length) { console.log("(无可用技能)"); }
      else {
        const all = mgr.listAll();
        console.log(`\x1b[36m可用技能 (${all.length} 个)\x1b[0m — 方向键选择并加载\n`);
        const skillSel = await selectList(rl, "选择技能:", all.map(s => `\x1b[36m${s.name.padEnd(18)}\x1b[0m ${s.description.slice(0, 40)}`));
        if (skillSel === null) { console.log("(已取消)"); reprompt(); continue; }
        const skill = all[skillSel];
        console.log(`\x1b[36m[技能] ${skill.name}\x1b[0m — ${skill.description}`);
        try { await agent.run(skill.toPrompt()); } catch (e) { console.error(`[ERROR] ${e}`); }
      }
      reprompt(); continue;
    }
    // ── /subagents — 列出子代理结果 ──
    if (q === "/subagents" || q === "/sub") {
      const results = agent.subagentResults;
      if (!results.length) {
        console.log("(无子代理记录 — 派遣子代理后可在此查看结果)");
      } else {
        console.log(`\x1b[36m子代理记录 (${results.length} 个):\x1b[0m\n`);
        for (const r of results) {
          const icon = r.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          const time = `${(r.latencyMs / 1000).toFixed(1)}s`;
          const task = r.task.slice(0, 40);
          const preview = r.answerPreview.replace(/\n/g, " ").trim().slice(0, 60);
          console.log(`  \x1b[36m#${r.id}\x1b[0m ${icon} \x1b[90m[${time}]\x1b[0m ${task}`);
          if (r.skill) console.log(`       \x1b[33mskill:\x1b[0m ${r.skill}`);
          if (r.toolCalls.length) console.log(`       \x1b[90m工具调用: ${r.toolCalls.length} 次\x1b[0m`);
          if (preview) console.log(`       \x1b[90m${preview}\x1b[0m`);
        }
        console.log(`\n用 \x1b[36m/subagent <id>\x1b[0m 查看完整输出`);
      }
      reprompt(); continue;
    }
    // ── /subagent <id> — 查看子代理详情 ──
    if (q.startsWith("/subagent ") || q.startsWith("/sub ")) {
      const sid = parseInt(q.split(" ")[1]);
      const results = agent.subagentResults;
      const r = results.find(x => x.id === sid);
      if (!r) {
        console.log(`(x) 子代理 #${sid} 不存在。用 /subagents 查看列表`);
      } else {
        console.log(`\x1b[36m═══ 子代理 #${r.id} ═══\x1b[0m`);
        console.log(`  任务: ${r.task}`);
        if (r.skill) console.log(`  技能: ${r.skill}`);
        if (r.tools) console.log(`  工具: ${r.tools}`);
        console.log(`  状态: ${r.success ? "✓ 成功" : "✗ 失败"}  耗时: ${(r.latencyMs / 1000).toFixed(1)}s`);
        console.log(`  工具调用: ${r.toolCalls.length} 次`);
        if (r.toolCalls.length) {
          console.log(`\n\x1b[90m── 工具调用历史 ──\x1b[0m`);
          for (const tc of r.toolCalls) {
            const tcIcon = tc.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
            const tcPreview = tc.result.replace(/\n/g, " ").trim().slice(0, 80);
            console.log(`  ${tcIcon} \x1b[36m${tc.name}\x1b[0m \x1b[90m[${tc.latencyMs.toFixed(0)}ms]\x1b[0m ${tcPreview}`);
          }
        }
        console.log(`\n\x1b[90m── 完整输出 ──\x1b[0m`);
        console.log(r.result);
      }
      reprompt(); continue;
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
      reprompt(); continue;
    }
    // ── /goal ──
    if (q === "/goal") {
      const g = agent.goal;
      if (g) console.log(`当前目标:\n  ${g}`);
      else console.log("(未设置目标)\n用法: /goal <描述>  设置目标\n      /goal clear   清除目标");
      reprompt(); continue;
    }
    if (q.startsWith("/goal ")) {
      const gtext = q.slice(6).trim();
      if (["clear", "stop", "reset", "cancel", "none"].includes(gtext.toLowerCase())) {
        agent.setGoal(""); console.log("目标已清除");
      } else {
        console.log(`目标已设置:\n  ${agent.setGoal(gtext)}`);
      }
      reprompt(); continue;
    }
    // ── /plan ──
    if (q.startsWith("/plan")) {
      const planDesc = q.includes(" ") ? q.split(" ").slice(1).join(" ").trim() : "";
      let planMsg = "[规划模式] 请先分析问题，制定详细的实施方案，不要立即编写代码。";
      if (planDesc) planMsg += `\n\n任务: ${planDesc}`;
      console.log(`\x1b[36m进入规划模式...\x1b[0m`);
      try { await agent.run(planMsg); } catch (e) { console.error(`[ERROR] ${e}`); }
      reprompt(); continue;
    }
    // ── @file reference ──
    if (q.startsWith("@")) {
      const parts = q.slice(1).trim().split(/\s+(.*)/);
      const fname = parts[0] || "";
      const rest = parts[1] || "";
      if (fname.includes("..") || fname.startsWith("/") || fname.startsWith("\\")) {
        console.log(`(x) @引用不支持路径穿越: ${fname}`);
        reprompt(); continue;
      }
      // ── 功能入口：@browser / @computer / @skills / @mcp → 注入能力清单 ──
      const entry = AT_ENTRIES.find(e => e.name === fname.toLowerCase());
      if (entry) {
        let ctxMsg = "";
        if (entry.name === "browser" || entry.name === "computer") {
          const capFilter = entry.name === "browser" ? "browser" : "computer";
          const tools = registry.schemaList
            .map(s => s.function.name)
            .filter(n => n.startsWith(capFilter + "_"));
          ctxMsg = `[${entry.icon} ${entry.desc}]\n可用工具 (${tools.length} 个):\n` +
            tools.map(n => {
              const m = registry.meta(n);
              const d = (m?.description || "").split("\n")[0].slice(0, 60);
              return `  • ${n} — ${d}`;
            }).join("\n") +
            `\n\n请根据以上工具能力回答用户的问题。` + (rest ? `\n\n${rest}` : "\n\n请说明你能用这些工具做什么，并给出使用示例。");
        } else if (entry.name === "skills") {
          const skills = agent.skillMgr?.listAll() || [];
          ctxMsg = `[🧠 可用技能 (${skills.length} 个)]\n` +
            skills.map(s => `  • ${s.name} — ${s.description.slice(0, 50)}`).join("\n") +
            `\n\n请根据以上技能列表回答。` + (rest ? `\n\n${rest}` : "\n\n请简要介绍这些技能分别适用什么场景。");
        } else if (entry.name === "mcp") {
          let configured = "";
          try {
            const { loadSettings } = await import("../config.js");
            const ms = (loadSettings().mcpServers || {}) as Record<string, unknown>;
            configured = Object.keys(ms).map(k => `  • ${k}`).join("\n") || "  (无)";
          } catch { configured = "  (读取失败)"; }
          ctxMsg = `[🔌 MCP 服务器配置]\n${configured}\n\n用 mcp_list_servers() 查看全部（含注册表），mcp_session_start() 启动会话后调用工具。` + (rest ? `\n\n${rest}` : "");
        }
        console.log(`\x1b[90m@${entry.name} — ${entry.desc}\x1b[0m`);
        try { await agent.run(ctxMsg); } catch (e) { console.error(`[ERROR] ${e}`); }
        reprompt(); continue;
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
      reprompt(); continue;
    }

    // ── Normal query ──
    try {
      await agent.run(q, undefined, true);
    } catch (e) {
      console.error(`[ERROR] ${e}`);
    }
        reprompt();
  }
  agent.saveSession();
  console.log(`\x1b[33mBye.\x1b[0m  \x1b[90mSession: ${agent.sessionIdStr || "?"}\x1b[0m`);
  rl.close();
}

main().catch(console.error);
