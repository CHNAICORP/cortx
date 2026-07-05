/**
 * Terminal display — 与 Python terminal.py 对应
 * thinking 深灰 / answer 亮色 / 长思考折叠 / 多轮分隔 / 步骤编号
 */
export class Terminal {
  private buf: string[] = [];
  private shownReasoning = false;
  private showingAnswer = false;
  private round = 0;
  private step = 0;

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
