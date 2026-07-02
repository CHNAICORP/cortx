/**
 * Terminal display — 与 Python terminal.py 对应
 * thinking 深灰 / answer 亮色 / 长思考折叠
 */
export class Terminal {
  private buf: string[] = [];
  private shownReasoning = false;
  private showingAnswer = false;
  private round = 0;

  static readonly DEEP  = "\x1b[38;5;239m";
  static readonly CYAN  = "\x1b[38;5;51m";
  static readonly GREEN = "\x1b[38;5;82m";
  static readonly YELLOW= "\x1b[38;5;220m";
  static readonly RED   = "\x1b[38;5;196m";
  static readonly GRAY  = "\x1b[38;5;240m";
  static readonly RESET = "\x1b[0m";
  static readonly FOLD_LEN = 200;

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

  // Answer phase — bright
  answerToken(token: string) {
    if (!this.showingAnswer) {
      if (this.shownReasoning) {
        const reasoning = this.buf.join("");
        this.write(Terminal.RESET);
        if (reasoning.length > Terminal.FOLD_LEN) {
          const flat = reasoning.replace(/\n/g, " ").trim();
          const preview = flat.length > 80 ? flat.slice(0, 77) + "..." : flat;
          this.write(`\n  ${Terminal.GRAY}● ${preview}${Terminal.RESET}\n\n`);
        } else {
          this.write("\n\n");
        }
      }
      this.buf = [];
      this.showingAnswer = true;
    }
    this.write(token);
  }

  // Tool call
  toolStart(name: string, _args: Record<string, unknown>) {
    this.write(`\n  ${Terminal.CYAN}▸ ${name}${Terminal.RESET}`);
  }

  toolDone(success: boolean, latencyMs: number, preview: string) {
    const icon = success ? `${Terminal.GREEN}OK${Terminal.RESET}` : `${Terminal.RED}FAIL${Terminal.RESET}`;
    const short = preview.replace(/\n/g, " ").slice(0, 60);
    this.write(` ${icon} ${Terminal.GRAY}[${latencyMs.toFixed(0)}ms]${Terminal.RESET} ${Terminal.GRAY}${short}${Terminal.RESET}\n`);
  }

  closeThinking() {
    if (this.shownReasoning && !this.showingAnswer) {
      this.write(Terminal.RESET);
    }
  }

  nextRound() {
    this.round++;
    this.buf = [];
    this.shownReasoning = false;
    this.showingAnswer = false;
  }

  banner(model: string, tools: number, workDir: string, mode: string, sessionId?: string) {
    const modeColors: Record<string, string> = { standard: Terminal.GREEN, "auto-edit": Terminal.YELLOW, yolo: Terminal.RED };
    const modeIcons: Record<string, string> = { standard: "🛡️", "auto-edit": "✏️", yolo: "⚠️" };
    this.write(`\n${Terminal.CYAN}${"=".repeat(48)}${Terminal.RESET}\n`);
    this.write(`  Cortex Agent  ${Terminal.GREEN}${model}${Terminal.RESET}  ${Terminal.GRAY}${tools} tools  🟦 TypeScript${Terminal.RESET}\n`);
    this.write(`  权限: ${modeColors[mode] || Terminal.GRAY}${modeIcons[mode] || "?"} ${mode}${Terminal.RESET}  ${Terminal.GRAY}(Shift+Tab 切换)${Terminal.RESET}\n`);
    if (sessionId) this.write(`  Session: ${Terminal.GRAY}${sessionId}${Terminal.RESET}\n`);
    this.write(`  ${Terminal.GRAY}${workDir}${Terminal.RESET}\n`);
    this.write(`${Terminal.CYAN}${"=".repeat(48)}${Terminal.RESET}\n`);
  }

  error(msg: string) {
    this.write(`\n  ${Terminal.RED}${msg}${Terminal.RESET}\n`);
  }
}
