/**
 * Terminal display — 与 Python terminal.py 对应
 * thinking 深灰 / answer 亮色 / 长思考折叠 / 多轮分隔 / 步骤编号 / 代码写入打字机效果
 */

// 代码写入流式显示的配置
const CODE_STREAM_CONFIG = {
  // 小文件 (≤50行): 每行延迟 5ms
  smallLineDelay: 5,
  smallThreshold: 50,
  // 中文件 (≤200行): 每行延迟 2ms
  mediumLineDelay: 2,
  mediumThreshold: 200,
  // 大文件 (>200行): 只显示首尾，每行延迟 1ms
  largeLineDelay: 1,
  largeHeadLines: 30,
  largeTailLines: 10,
  // 最小内容长度（太短不流式）
  minLength: 30,
};

export class Terminal {
  private buf: string[] = [];
  private shownReasoning = false;
  private showingAnswer = false;
  private round = 0;
  private step = 0;
  private codeStreamEnabled = true;

  static readonly DEEP  = "\x1b[38;5;239m";
  static readonly CYAN  = "\x1b[38;5;51m";
  static readonly GREEN = "\x1b[38;5;82m";
  static readonly YELLOW= "\x1b[38;5;220m";
  static readonly RED   = "\x1b[38;5;196m";
  static readonly GRAY  = "\x1b[38;5;240m";
  static readonly DIM   = "\x1b[38;5;245m";
  static readonly BOLD  = "\x1b[1m";
  static readonly RESET = "\x1b[0m";
  static readonly FOLD_LEN = 200;
  static readonly FOLD_PREVIEW = 80;

  write(s: string) { process.stdout.write(s); }

  // Think phase — deep grey
  thinkToken(token: string) {
    if (!this.shownReasoning) {
      this.shownReasoning = true;
      this.write(`\n${Terminal.DEEP}`);
    }
    this.buf.push(token);
    this.write(token);
  }

  // Answer phase — bright with separator
  answerToken(token: string) {
    if (!this.showingAnswer) {
      if (this.shownReasoning) {
        const reasoning = this.buf.join("");
        this.write(Terminal.RESET);
        if (reasoning.length > Terminal.FOLD_LEN) {
          const flat = reasoning.replace(/\n/g, " ").trim();
          const preview = flat.length > Terminal.FOLD_PREVIEW
            ? flat.slice(0, Terminal.FOLD_PREVIEW - 3) + "..."
            : flat;
          this.write(`\n  ${Terminal.DIM}💭 ${preview}${Terminal.RESET}\n\n`);
        } else {
          this.write("\n");
        }
      }
      this.buf = [];
      this.showingAnswer = true;
    }
    this.write(token);
  }

  // Tool call — step number + name + params
  toolStart(name: string, args: Record<string, unknown>) {
    this.step++;
    const argsStr = fmtArgs(args);
    if (argsStr) {
      this.write(`\n  ${Terminal.GRAY}[${this.step}]${Terminal.RESET} ${Terminal.CYAN}▸ ${name}${Terminal.RESET} ${Terminal.DIM}(${argsStr})${Terminal.RESET}`);
    } else {
      this.write(`\n  ${Terminal.GRAY}[${this.step}]${Terminal.RESET} ${Terminal.CYAN}▸ ${name}${Terminal.RESET}`);
    }
  }

  toolDone(success: boolean, latencyMs: number, preview: string) {
    const icon = success ? `${Terminal.GREEN}✓${Terminal.RESET}` : `${Terminal.RED}✗${Terminal.RESET}`;
    const short = preview.replace(/\n/g, " ").trim().slice(0, 80);
    if (short) {
      this.write(` ${icon} ${Terminal.GRAY}[${latencyMs.toFixed(0)}ms]${Terminal.RESET} ${Terminal.DIM}${short}${Terminal.RESET}\n`);
    } else {
      this.write(` ${icon} ${Terminal.GRAY}[${latencyMs.toFixed(0)}ms]${Terminal.RESET}\n`);
    }
  }

  // ── 子代理进度显示 ──

  /** 子代理派遣开始 — 显示总数 */
  subagentDispatch(count: number) {
    const label = count === 1 ? "派遣子代理..." : `派遣 ${count} 个子代理...`;
    this.write(`\n  ${Terminal.YELLOW}⚡ ${label}${Terminal.RESET}\n`);
  }

  /** 单个子代理开始执行 */
  subagentStart(idx: number, total: number, task: string) {
    const preview = task.length > 50 ? task.slice(0, 47) + "..." : task;
    this.write(`  ${Terminal.GRAY}  └ [${idx}/${total}]${Terminal.RESET} ${Terminal.DIM}▶ ${preview}${Terminal.RESET}\n`);
  }

  /** 单个子代理完成 */
  subagentDone(idx: number, total: number, success: boolean, latencyMs?: number) {
    const icon = success ? `${Terminal.GREEN}✓${Terminal.RESET}` : `${Terminal.RED}✗${Terminal.RESET}`;
    const time = latencyMs != null ? ` ${Terminal.GRAY}[${(latencyMs / 1000).toFixed(1)}s]${Terminal.RESET}` : "";
    this.write(`  ${Terminal.GRAY}  └ [${idx}/${total}]${Terminal.RESET} ${icon}${time}\n`);
  }

  /** Check if answer text has been displayed to the user */
  isAnswerShown(): boolean {
    return this.showingAnswer;
  }

  /** Explicitly write answer text to terminal (fallback when streaming didn't work) */
  writeAnswer(text: string) {
    if (!this.showingAnswer) {
      this.closeThinking();
      this.showingAnswer = true;
    }
    this.write(text);
  }

  closeThinking() {
    if (this.shownReasoning && !this.showingAnswer) {
      const reasoning = this.buf.join("");
      this.write(Terminal.RESET);
      if (reasoning.length > Terminal.FOLD_LEN) {
        const flat = reasoning.replace(/\n/g, " ").trim();
        const preview = flat.length > Terminal.FOLD_PREVIEW
          ? flat.slice(0, Terminal.FOLD_PREVIEW - 3) + "..."
          : flat;
        this.write(`\n  ${Terminal.DIM}💭 ${preview}${Terminal.RESET}\n`);
      } else {
        this.write("\n");
      }
      this.buf = [];
    }
  }

  // ── 代码写入打字机效果 ──

  /** 启用/禁用代码流式显示 */
  setCodeStream(enabled: boolean) { this.codeStreamEnabled = enabled; }

  /**
   * 流式显示代码写入过程 — 打字机效果。
   * 
   * 策略:
   *   - 小文件 (≤50行): 全部显示，每行 5ms 延迟
   *   - 中文件 (≤200行): 全部显示，每行 2ms 延迟
   *   - 大文件 (>200行): 首尾显示 + 中间省略，每行 1ms 延迟
   *   - 极短内容 (<30字符): 不流式，直接显示
   */
  async codeStream(filePath: string, content: string): Promise<void> {
    if (!this.codeStreamEnabled || !content || content.length < CODE_STREAM_CONFIG.minLength) return;

    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const lines = content.split("\n");
    const totalLines = lines.length;
    const totalChars = content.length;

    // 代码颜色: 根据文件类型选色
    const codeColor = this._codeColor(ext);

    // 头部: 文件名 + 行数
    this.write(`\n  ${Terminal.DIM}✎ ${Terminal.RESET}${Terminal.CYAN}${fileName}${Terminal.RESET} ${Terminal.GRAY}(${totalLines} 行, ${totalChars.toLocaleString()} 字符)${Terminal.RESET}\n`);
    this.write(`  ${Terminal.GRAY}┌${"─".repeat(Math.min(fileName.length + 20, 60))}┐${Terminal.RESET}\n`);

    const cfg = CODE_STREAM_CONFIG;
    let displayLines: string[];
    let lineDelay: number;
    let omitted = 0;

    if (totalLines <= cfg.smallThreshold) {
      displayLines = lines;
      lineDelay = cfg.smallLineDelay;
    } else if (totalLines <= cfg.mediumThreshold) {
      displayLines = lines;
      lineDelay = cfg.mediumLineDelay;
    } else {
      // 大文件: 首尾显示
      const head = lines.slice(0, cfg.largeHeadLines);
      const tail = lines.slice(-cfg.largeTailLines);
      omitted = totalLines - cfg.largeHeadLines - cfg.largeTailLines;
      displayLines = [...head, `__OMITTED__${omitted}__`, ...tail];
      lineDelay = cfg.largeLineDelay;
    }

    // 流式输出每一行
    for (const line of displayLines) {
      if (line.startsWith("__OMITTED__")) {
        const count = parseInt(line.match(/\d+/)?.[0] || "0");
        this.write(`  ${Terminal.GRAY}│  ... 省略 ${count} 行 ...${Terminal.RESET}\n`);
      } else {
        // 截断超长行
        const displayLine = line.length > 120 ? line.slice(0, 117) + "..." : line;
        this.write(`  ${Terminal.GRAY}│${Terminal.RESET} ${codeColor}${displayLine}${Terminal.RESET}\n`);
      }
      if (lineDelay > 0) {
        await new Promise(r => setTimeout(r, lineDelay));
      }
    }

    // 底部
    this.write(`  ${Terminal.GRAY}└${"─".repeat(Math.min(fileName.length + 20, 60))}┘${Terminal.RESET}\n`);
  }

  /** 根据文件扩展名返回代码颜色 */
  private _codeColor(ext: string): string {
    const map: Record<string, string> = {
      ts: "\x1b[38;5;75m",   // 蓝
      tsx: "\x1b[38;5;75m",
      js: "\x1b[38;5;221m",  // 黄
      jsx: "\x1b[38;5;221m",
      py: "\x1b[38;5;114m",  // 绿
      html: "\x1b[38;5;209m", // 橙
      css: "\x1b[38;5;141m",  // 紫
      json: "\x1b[38;5;215m", // 浅橙
      md: "\x1b[38;5;250m",   // 浅灰
      yml: "\x1b[38;5;215m",
      yaml: "\x1b[38;5;215m",
      sql: "\x1b[38;5;117m",
      sh: "\x1b[38;5;114m",
      go: "\x1b[38;5;81m",
      rs: "\x1b[38;5;173m",
      vue: "\x1b[38;5;114m",
    };
    return map[ext] || Terminal.DIM;
  }

  nextRound() {
    this.round++;
    this.step = 0;
    this.buf = [];
    this.shownReasoning = false;
    this.showingAnswer = false;
    // Multi-round separator (skip first round)
    if (this.round > 1) {
      this.write(`\n  ${Terminal.GRAY}${"─".repeat(44)}${Terminal.RESET}\n`);
    }
  }

  // 权限模式元数据
  private static readonly MODE_META: Record<string, {color: string; icon: string; label: string; desc: string}> = {
    standard: { color: Terminal.GREEN,  icon: "🛡", label: "Standard", desc: "安全模式" },
    auto:     { color: Terminal.YELLOW, icon: "✎", label: "Auto",     desc: "自动模式" },
    yolo:     { color: Terminal.RED,    icon: "⚠", label: "YOLO",    desc: "无限制" },
  };

  banner(model: string, tools: number, workDir: string, mode: string, sessionId?: string, contextLimit?: number, isResume?: boolean) {
    const meta = Terminal.MODE_META[mode] || { color: Terminal.GRAY, icon: "?", label: mode, desc: "" };
    // 格式化上下文容量
    let ctxStr = "";
    if (contextLimit && contextLimit > 0) {
      ctxStr = contextLimit >= 1_000_000
        ? `${Math.floor(contextLimit / 1_000_000)}M ctx`
        : `${Math.floor(contextLimit / 1000)}K ctx`;
    }
    this.write(`\n${Terminal.CYAN}╔${"═".repeat(52)}╗${Terminal.RESET}\n`);
    // 模型行
    let modelLine = `  ${Terminal.BOLD}Cortex Agent${Terminal.RESET}  ${Terminal.GREEN}${model}${Terminal.RESET}`;
    if (ctxStr) modelLine += `  ${Terminal.GRAY}${ctxStr}${Terminal.RESET}`;
    modelLine += `  ${Terminal.GRAY}${tools} tools  🟦${Terminal.RESET}`;
    this.write(modelLine + "\n");
    // 权限行
    this.write(`  ${meta.color}${meta.icon} ${meta.label}${Terminal.RESET}  ${Terminal.DIM}${meta.desc}${Terminal.RESET}  ${Terminal.GRAY}(Shift+Tab 切换)${Terminal.RESET}\n`);
    if (sessionId) this.write(`  ${Terminal.GRAY}Session: ${sessionId}${isResume ? " (已恢复)" : " (新会话)"}${Terminal.RESET}\n`);
    this.write(`  ${Terminal.GRAY}${workDir}${Terminal.RESET}\n`);
    this.write(`${Terminal.CYAN}╚${"═".repeat(52)}╝${Terminal.RESET}\n`);
  }

  error(msg: string) {
    this.write(`\n  ${Terminal.RED}✗ ${msg}${Terminal.RESET}\n`);
  }
}

function fmtArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "workDir" || k === "work_dir") continue;
    let s = String(v);
    if (s.length > 50) s = s.slice(0, 47) + "...";
    parts.push(`${k}=${s}`);
    if (parts.length >= 4) break; // max 4 params shown
  }
  return parts.join(", ");
}
