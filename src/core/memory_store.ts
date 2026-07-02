/**
 * Cortex Agent TypeScript — 记忆/会话引擎
 * 与 Python memory.py 完全对应
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ════════════════════════════════════════════
// MemoryStore — 单文件 memory.md
// ════════════════════════════════════════════

export class MemoryStore {
  private fpath: string;

  constructor(p: string) {
    this.fpath = p;
    this._ensure();
  }

  private _ensure(): void {
    const dir = path.dirname(this.fpath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.fpath)) {
      fs.writeFileSync(this.fpath, "# Memory\n", "utf-8");
    }
  }

  private _readLines(): string[] {
    if (!fs.existsSync(this.fpath)) return [];
    return fs.readFileSync(this.fpath, "utf-8")
      .split("\n")
      .filter(l => l.startsWith("- "));
  }

  append(fact: string): void {
    this._ensure();
    const existing = this._readLines();
    const line = `- ${fact.trim()}`;
    if (existing.some(e => e.trim() === line.trim())) return;
    fs.appendFileSync(this.fpath, line + "\n", "utf-8");
  }

  remove(fact: string): boolean {
    const existing = this._readLines();
    const newLines: string[] = [];
    let removed = false;
    for (const e of existing) {
      if (!removed && e.includes(fact.trim())) {
        removed = true;
        continue;
      }
      newLines.push(e);
    }
    if (removed) {
      fs.writeFileSync(this.fpath, "# Memory\n" + newLines.join("\n") + "\n", "utf-8");
    }
    return removed;
  }

  listAll(): string[] {
    return this._readLines();
  }

  toSystemContext(): string {
    const lines = this._readLines();
    if (!lines.length) return "";
    return "[记忆事实]\n" + lines.join("\n");
  }
}

// ════════════════════════════════════════════
// SessionStore — 每会话 .jsonl
// ════════════════════════════════════════════

export class SessionStore {
  private dir: string;
  private lastPath: string;

  constructor(p: string) {
    this.dir = p;
    this.lastPath = path.join(this.dir, "last_session.txt");
    this._ensure();
  }

  private _ensure(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  private _sessionPath(sessionId: string): string {
    // 消毒：取 basename 防止路径穿越
    const safeId = path.basename(sessionId);
    return path.join(this.dir, `${safeId}.jsonl`);
  }

  save(sessionId: string, ctx: Array<Record<string, unknown>>, metadata?: Record<string, unknown>): void {
    this._ensure();
    const fpath = this._sessionPath(sessionId);
    const lines: string[] = [];
    // 首行: meta
    const meta: Record<string, unknown> = { ...(metadata || {}) };
    meta.session_id = sessionId;
    meta.created_at = meta.created_at || new Date().toISOString();
    meta.last_active = new Date().toISOString();
    lines.push(JSON.stringify({ type: "meta", ...meta }));
    // 后续行: 消息 (跳过 ctx[0] system message)
    for (let i = 1; i < ctx.length; i++) {
      try {
        lines.push(JSON.stringify({ type: "msg", ...ctx[i] }));
      } catch { /* skip malformed */ }
    }
    fs.writeFileSync(fpath, lines.join("\n") + "\n", "utf-8");
    this.setLastSession(sessionId);
  }

  load(sessionId: string): [Array<Record<string, unknown>>, Record<string, unknown>] {
    const fpath = this._sessionPath(sessionId);
    if (!fs.existsSync(fpath)) throw new Error(`会话不存在: ${sessionId}`);
    const ctx: Array<Record<string, unknown>> = [];
    let meta: Record<string, unknown> = {};
    const lines = fs.readFileSync(fpath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "meta") {
          const { type, ...rest } = obj;
          meta = rest;
        } else {
          const { type, ...rest } = obj;
          ctx.push(rest);
        }
      } catch { /* skip malformed */ }
    }
    return [ctx, meta];
  }

  listSessions(): Array<Record<string, unknown>> {
    this._ensure();
    const result: Array<Record<string, unknown>> = [];
    for (const fn of fs.readdirSync(this.dir)) {
      if (!fn.endsWith(".jsonl")) continue;
      const fpath = path.join(this.dir, fn);
      let meta: Record<string, unknown> = { session_id: fn.slice(0, -6) };
      try {
        const first = fs.readFileSync(fpath, "utf-8").split("\n")[0].trim();
        if (first) {
          const obj = JSON.parse(first);
          if (obj.type === "meta") {
            const { type, ...rest } = obj;
            meta = rest;
          }
        }
      } catch { /* keep default */ }
      result.push(meta);
    }
    result.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
    return result;
  }

  delete(sessionId: string): boolean {
    const fpath = this._sessionPath(sessionId);
    if (!fs.existsSync(fpath)) return false;
    fs.unlinkSync(fpath);
    const last = this.getLastSession();
    if (last === sessionId) {
      const sessions = this.listSessions();
      if (sessions.length > 0) {
        this.setLastSession(String(sessions[0].session_id));
      } else if (fs.existsSync(this.lastPath)) {
        fs.unlinkSync(this.lastPath);
      }
    }
    return true;
  }

  generateId(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, "");
    const time = now.toISOString().slice(11, 19).replace(/:/g, "");
    const hex = crypto.randomBytes(2).toString("hex");
    return `${date}-${time}-${hex}`;
  }

  getLastSession(): string | null {
    if (!fs.existsSync(this.lastPath)) return null;
    const val = fs.readFileSync(this.lastPath, "utf-8").trim();
    return val || null;
  }

  setLastSession(sessionId: string): void {
    this._ensure();
    fs.writeFileSync(this.lastPath, sessionId, "utf-8");
  }

  getHistorySummary(sessionId: string, nExchanges = 5): string {
    const fpath = this._sessionPath(sessionId);
    if (!fs.existsSync(fpath)) return "";
    const exchanges: string[] = [];
    let userMsg: string | null = null;
    try {
      const lines = fs.readFileSync(fpath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type !== "msg") continue;
        const role = String(obj.role || "");
        if (role === "user") {
          userMsg = String(obj.content || "").slice(0, 80);
        } else if (role === "assistant" && userMsg) {
          const asst = String(obj.content || "").slice(0, 100).replace(/\n/g, " ").trim();
          if (asst) exchanges.push(`- 用户: ${userMsg.slice(0, 60)}... → Agent: ${asst}...`);
          userMsg = null;
        }
      }
    } catch { /* ignore */ }
    if (!exchanges.length) return "";
    const recent = exchanges.slice(-nExchanges);
    return "此前对话摘要:\n" + recent.join("\n");
  }
}
