/**
 * AskUserPanel — Agent 询问面板（ask_user 工具的交互实现）
 * 与 Python ask_panel.py 完全对应
 *
 * 支持一次最多 4 个问题；每个问题可带 1-6 个选项（单选 ●○ / 多选 [x][ ]，
 * 数字键快捷选择），或省略选项转为自由文本输入。ESC/Ctrl+C 取消整个面板。
 * raw 会话按键隔离（暂存并摘除 stdin 全部 keypress 监听 + 主 rl pause/resume）
 * —— 同 v2.9.14 rawSession 机制，防止面板按键泄漏进主 rl 行缓冲。
 * 非交互环境（非 TTY / 子代理 / 管道 CI）不阻塞，直接返回标记文本。
 */
import * as readline from "readline";

export interface AskPanelOption {
  label: string;
  description?: string;
}

export interface AskPanelQuestion {
  question: string;
  header?: string;
  options?: AskPanelOption[];
  multiSelect?: boolean;
}

// ── ANSI（与 main.ts 同款配色）──
const CY = "\x1b[36m";
const GR = "\x1b[90m";
const GN = "\x1b[38;5;82m";
const YL = "\x1b[38;5;220m";
const R = "\x1b[0m";
const REV = "\x1b[7m";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_LINE = 64; // 显示截断长度：防止长行折行破坏重绘锚点（光标上移行数假设每行不换行）

export const ASK_CANCELLED =
  "用户取消了询问面板（ESC/Ctrl+C），未回答任何问题。请基于已有上下文自行决策并继续，不要重复调用 ask_user 弹出面板。";

// ── 主 rl 绑定：main.ts 创建 rl 后调用 bindMainRl()，
//    raw 会话才能 pause/resume 主 rl（按键隔离的一部分；core 层 wiring 无 rl 时仍可用）──
let _mainRl: readline.Interface | null = null;
export function bindMainRl(rl: readline.Interface | null): void {
  _mainRl = rl;
}

/** readline 的 closed 标志（类型定义未暴露，运行时存在） */
export function rlClosed(rl: readline.Interface): boolean {
  return (rl as unknown as { closed?: boolean }).closed === true;
}

type KeyHandler = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void;

/** raw 按键会话：暂存/摘除 stdin 的全部 keypress 监听（含 readline 内部的），
 *  防止 raw 会话按键泄漏进主 rl —— 字符混入行缓冲 / Enter 产生伪 line 事件 /
 *  Ctrl+C 触发 readline 无 SIGINT 监听时的默认 close()（后者导致 ERR_USE_AFTER_CLOSE 崩溃）。
 *  rl 为空（core 层默认 wiring）时跳过 pause/resume，监听隔离仍然完整。
 *  结束时恢复监听。 */
export function rawSession(rl: readline.Interface | null): {
  onKey: (h: KeyHandler) => void;
  end: () => void;
} {
  const saved = process.stdin.listeners("keypress").slice();
  saved.forEach(l => process.stdin.removeListener("keypress", l));
  if (rl) rl.pause();
  readline.emitKeypressEvents(process.stdin);
  const handlers: KeyHandler[] = [];
  const hadRaw = typeof process.stdin.setRawMode === "function";
  if (hadRaw) process.stdin.setRawMode(true);
  process.stdin.resume();
  return {
    onKey: h => { handlers.push(h); process.stdin.on("keypress", h); },
    end: () => {
      handlers.forEach(h => process.stdin.removeListener("keypress", h));
      if (hadRaw) process.stdin.setRawMode(false);
      // raw 会话期间若外部已关闭 rl（如退出流程），不再恢复，避免 ERR_USE_AFTER_CLOSE
      saved.forEach(l => { if (!rl || !rlClosed(rl)) process.stdin.on("keypress", l); });
      if (rl && !rlClosed(rl)) rl.resume();
    },
  };
}

// ── payload 解析与校验（与 Python parse_ask_payload 对应）──

export function parseAskPayload(questionsJson: string): { questions: AskPanelQuestion[] } | { error: string } {
  const s = String(questionsJson || "").trim();
  if (!s) {
    return { error: `questions_json 不能为空，需要 JSON 数组字符串，如 [{"question":"...","options":[{"label":"..."}]}]` };
  }
  let arr: unknown;
  try {
    arr = JSON.parse(s);
  } catch (e) {
    return { error: `questions_json 解析失败: ${e}` };
  }
  if (!Array.isArray(arr) || arr.length === 0) return { error: "questions_json 必须是非空 JSON 数组" };
  if (arr.length > MAX_QUESTIONS) return { error: `一次最多 ${MAX_QUESTIONS} 个问题（收到 ${arr.length} 个）` };
  const questions: AskPanelQuestion[] = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (typeof raw !== "object" || raw === null) return { error: `第 ${i + 1} 个问题必须是对象` };
    const o = raw as Record<string, unknown>;
    const question = String(o.question || "").trim();
    if (!question) return { error: `第 ${i + 1} 个问题缺少 question 字段` };
    const q: AskPanelQuestion = {
      question,
      header: String(o.header || "").trim().slice(0, 12) || undefined,
      multiSelect: o.multiSelect === true,
    };
    if (o.options !== undefined && o.options !== null) {
      if (!Array.isArray(o.options)) return { error: `第 ${i + 1} 个问题的 options 必须是数组` };
      if (o.options.length === 0) return { error: `第 ${i + 1} 个问题的 options 为空（省略 options 则为自由文本输入）` };
      if (o.options.length > MAX_OPTIONS) return { error: `每个问题最多 ${MAX_OPTIONS} 个选项（第 ${i + 1} 题给了 ${o.options.length} 个）` };
      const opts: AskPanelOption[] = [];
      for (const od of o.options) {
        if (typeof od !== "object" || od === null) return { error: `第 ${i + 1} 个问题的选项必须是对象` };
        const label = String((od as Record<string, unknown>).label || "").trim();
        if (!label) return { error: `第 ${i + 1} 个问题存在缺少 label 的选项` };
        opts.push({ label, description: String((od as Record<string, unknown>).description || "").trim() || undefined });
      }
      q.options = opts;
    }
    questions.push(q);
  }
  return { questions };
}

/** 非交互模式结果（子代理 / 管道 CI / 非 TTY） */
export function nonInteractiveAskResult(questionsJson: string): string {
  const parsed = parseAskPayload(questionsJson);
  const list = "questions" in parsed
    ? parsed.questions.map((q, i) => `${i + 1}) ${q.question}`).join(" ")
    : String(questionsJson).slice(0, 200);
  return `[非交互模式] 无法向用户提问。问题: ${list} — 请根据已有上下文自行决策并继续，不要再次调用 ask_user。`;
}

// ── 渲染辅助 ──

/** 显示截断（不影响返回给 LLM 的完整文本） */
function disp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function titleLine(idx: number, total: number, header?: string): string {
  return `${CY}  ╭─ 💬 Agent 询问 (${idx}/${total})${header ? ` ─ ${header}` : ""} ─────────${R}`;
}

// ── 选项题（单选/多选）。返回选中索引数组；ESC/Ctrl+C 返回 null ──

function askOptionQuestion(q: AskPanelQuestion, idx: number, total: number): Promise<number[] | null> {
  const sess = rawSession(_mainRl);
  const opts = q.options!;
  const n = opts.length;
  const multi = q.multiSelect === true && n > 1;
  let sel = 0;
  const checked: boolean[] = new Array(n).fill(false);
  let warn = false;

  const build = (): string[] => {
    const L: string[] = [
      titleLine(idx, total, q.header),
      `${CY}  │${R} ${disp(q.question, 60)}`,
      `${CY}  │${R}`,
    ];
    for (let j = 0; j < n; j++) {
      const marker = multi ? (checked[j] ? "[x]" : "[ ]") : (j === sel ? "●" : "○");
      const desc = opts[j].description ? ` — ${opts[j].description}` : "";
      if (j === sel) {
        // 反色整行；行内不再嵌 ANSI（reset 会提前终止反色）
        L.push(REV + disp(`  │ ${marker} ${j + 1}. ${opts[j].label}${desc}`, MAX_LINE) + R);
      } else {
        L.push(`${CY}  │${R} ${GR}${marker}${R} ${j + 1}. ${opts[j].label}${GR}${disp(desc, 40)}${R}`);
      }
    }
    L.push(`${CY}  │${R}`);
    const hint = warn
      ? `${YL}⚠ 多选题至少勾选一项后再按 Enter${R}`
      : multi
        ? `${GR}↑↓ 移动 · 空格 勾选 · Enter 确认 · ESC 取消${R}`
        : `${GR}↑↓ 选择 · Enter 确认 · ESC 取消${R}`;
    L.push(`${CY}  ╰─ ${hint}${R}`);
    return L;
  };

  // 渲染纪律（同 selectList）：初始渲染与 redraw 都以末行（提示行）结尾、无换行，
  // 光标停在提示行尾；redraw 上移 len-1 行、逐行 \r\x1b[2K 重写，净位移 0 无漂移
  const render = (): void => { process.stdout.write(build().join("\n")); };
  const redraw = (): void => {
    const L = build();
    process.stdout.write(`\x1b[${L.length - 1}A`);
    process.stdout.write(L.map(l => `\r\x1b[2K${l}`).join("\n"));
  };

  render();
  return new Promise<number[] | null>(resolve => {
    sess.onKey((str, key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        sess.end(); process.stdout.write("\n"); resolve(null); return;
      }
      if (key.name === "return") {
        if (multi && !checked.some(Boolean)) { warn = true; redraw(); return; }
        sess.end(); process.stdout.write("\n");
        resolve(multi ? checked.map((c, j) => (c ? j : -1)).filter(j => j >= 0) : [sel]);
        return;
      }
      if (key.name === "up") { sel = (sel - 1 + n) % n; warn = false; redraw(); return; }
      if (key.name === "down") { sel = (sel + 1) % n; warn = false; redraw(); return; }
      if (key.name === "space" || str === " ") {
        if (!multi) return;
        checked[sel] = !checked[sel]; warn = false; redraw(); return;
      }
      if (str && str >= "1" && str <= "9") {
        const j = parseInt(str, 10) - 1;
        if (j >= n) return;
        if (multi) { checked[j] = !checked[j]; sel = j; warn = false; redraw(); return; }
        sel = j; sess.end(); process.stdout.write("\n"); resolve([sel]); return;
      }
    });
  });
}

// ── 自由文本题。返回输入文本（可为空串）；ESC/Ctrl+C 返回 null ──

function askTextQuestion(q: AskPanelQuestion, idx: number, total: number): Promise<string | null> {
  const sess = rawSession(_mainRl);
  const lines = [
    titleLine(idx, total, q.header),
    `${CY}  │${R} ${disp(q.question, 60)}`,
    `${CY}  │${R} ${GR}(输入回答 · Enter 确认 · ESC 取消)${R}`,
    `${CY}  │${R}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  process.stdout.write(`${CY}  │${R} ${GN}>${R} `);
  let buf = "";
  return new Promise<string | null>(resolve => {
    sess.onKey((str, key) => {
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

// ── 面板主入口（ask_user 工具调用；返回给 LLM 的结果字符串）──

let _panelActive = false;

export async function runAskUserPanel(questionsJson: string): Promise<string> {
  const parsed = parseAskPayload(questionsJson);
  if ("error" in parsed) return `(x) ${parsed.error}`;
  if (_panelActive) {
    return "[询问面板正忙] 已有另一个问题正在等待用户回答，请稍后重试或自行决策。";
  }
  // 非 TTY（管道/CI/假终端）不阻塞等待按键，直接走非交互结果
  if (typeof process.stdin.setRawMode !== "function" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return nonInteractiveAskResult(questionsJson);
  }
  _panelActive = true;
  try {
    const { questions } = parsed;
    const total = questions.length;
    const answers: Array<{ q: AskPanelQuestion; answer: string }> = [];
    process.stdout.write("\n");
    for (let i = 0; i < total; i++) {
      const q = questions[i];
      let answer: string | null = null;
      if (q.options && q.options.length > 0) {
        const picked = await askOptionQuestion(q, i + 1, total);
        if (picked === null) {
          process.stdout.write(`  ${CY}│${R}\n  ${CY}╰─${R} ${YL}✗ 已取消${R}\n\n`);
          return ASK_CANCELLED;
        }
        answer = picked.map(j => q.options![j].label).join(", ");
      } else {
        const text = await askTextQuestion(q, i + 1, total);
        if (text === null) {
          process.stdout.write(`  ${CY}│${R}\n  ${CY}╰─${R} ${YL}✗ 已取消${R}\n\n`);
          return ASK_CANCELLED;
        }
        answer = text;
      }
      answers.push({ q, answer });
      process.stdout.write(`  ${GN}✓${R} 已记录\n${i < total - 1 ? "\n" : ""}`);
    }
    // 收尾摘要
    process.stdout.write(`\n  ${GN}✓${R} 已收到全部回答:\n`);
    for (const a of answers) {
      const h = a.q.header ? `[${a.q.header}] ` : "";
      process.stdout.write(`    ${GR}${h}${R}${disp(a.answer || "(未输入)", 70)}\n`);
    }
    process.stdout.write("\n");
    const lines = answers.map(a => `[${a.q.header || "问题"}] ${a.q.question} → ${a.answer || "(用户未输入)"}`);
    return `用户已回答 ${total} 个问题:\n${lines.join("\n")}`;
  } finally {
    _panelActive = false;
  }
}
