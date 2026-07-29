/**
 * Cortex Agent Skills 技能系统 — 与 Python skills.py 完全对应
 *
 * 参考 Claude Code Custom Slash Commands 设计：
 *   - Skills 存储在 .cortx/skills/*.md
 *   - 每个 Skill 是一个 Markdown 文件，包含 prompt 模板
 *   - /skill <name> 加载技能 prompt 到上下文
 *   - /skills 列出所有可用技能
 */

import * as fs from "fs";
import * as path from "path";

// ════════════════════════════════════════════
// Skill — 一个可复用的技能模块
// ════════════════════════════════════════════

export class Skill {
  name: string;
  description: string;
  prompt: string;
  category: string;
  filepath: string;

  constructor(name: string, description: string, prompt: string,
              category = "general", filepath = "") {
    this.name = name;
    this.description = description;
    this.prompt = prompt;
    this.category = category;
    this.filepath = filepath;
  }

  /** 将技能 prompt 注入到系统消息中 */
  toPrompt(userInput = ""): string {
    let base = `[技能: ${this.name}]\n${this.prompt}`;
    if (userInput) base += `\n\n用户请求: ${userInput}`;
    return base;
  }
}

// ════════════════════════════════════════════
// SkillManager — 技能管理器 — 加载/列表/调用
// ════════════════════════════════════════════

export class SkillManager {
  skillsDir = ".cortx/skills";
  private skills = new Map<string, Skill>();
  private projectDir: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir || process.cwd();
    this._builtinSkills();
    this._loadFromDisk();
  }

  private _builtinSkills(): void {
    const builtins: Record<string, Skill> = {
      "code-review": new Skill(
        "code-review",
        "代码审查 — 分析代码质量、安全漏洞、性能问题",
        "你是一个资深代码审查专家。请对以下代码进行审查，关注：\n" +
        "1. 逻辑错误和边界情况\n" +
        "2. 安全漏洞（注入、越权、泄露）\n" +
        "3. 性能瓶颈\n" +
        "4. 可读性和维护性\n" +
        "5. 是否遵循项目现有代码风格\n\n" +
        "给出具体的修改建议和优先级（高/中/低）。",
        "development",
      ),
      "refactor": new Skill(
        "refactor",
        "代码重构 — 改进结构而不改变行为",
        "你是一个代码重构专家。请分析以下代码并提出重构方案：\n" +
        "1. 识别可以提取的函数/类\n" +
        "2. 简化复杂条件逻辑\n" +
        "3. 消除重复代码\n" +
        "4. 改善命名\n" +
        "5. 应用合适的设计模式\n\n" +
        "输出重构前后的对比，并解释每次改动的理由。",
        "development",
      ),
      "test-writer": new Skill(
        "test-writer",
        "测试编写 — 自动生成单元测试",
        "你是一个测试工程师。为以下代码编写全面的单元测试：\n" +
        "1. 覆盖正常路径和边界情况\n" +
        "2. 覆盖错误处理和异常路径\n" +
        "3. 使用项目已有的测试框架\n" +
        "4. 每个测试用例包含清晰的描述\n" +
        "5. Mock 外部依赖",
        "development",
      ),
      "doc-writer": new Skill(
        "doc-writer",
        "文档编写 — 生成 API 文档和注释",
        "你是一个技术文档撰写专家。为以下代码编写文档：\n" +
        "1. 模块/类的用途说明\n" +
        "2. 公共 API 的参数、返回值、异常说明\n" +
        "3. 使用示例\n" +
        "4. 注意事项和限制\n\n" +
        "输出格式使用 Markdown。",
        "documentation",
      ),
      "debug": new Skill(
        "debug",
        "调试分析 — 错误日志和堆栈跟踪分析",
        "你是一个调试专家。请分析以下错误/日志：\n" +
        "1. 定位根本原因\n" +
        "2. 解释错误发生的上下文\n" +
        "3. 提供修复方案（含代码）\n" +
        "4. 建议如何防止同类问题",
        "development",
      ),
      "explain": new Skill(
        "explain",
        "代码解释 — 逐行解释代码逻辑",
        "你是一个编程教师。请逐段解释以下代码：\n" +
        "1. 整体架构和数据流\n" +
        "2. 关键算法和数据结构\n" +
        "3. 重要的设计决策\n" +
        "4. 初学者容易困惑的地方\n\n" +
        "使用通俗易懂的语言，配合图表描述（用 ASCII art）。",
        "learning",
      ),
      "architect": new Skill(
        "architect",
        "架构设计 — 系统设计和技术方案",
        "你是一个系统架构师。请针对以下需求设计技术方案：\n" +
        "1. 整体架构图（用 ASCII art 描述）\n" +
        "2. 组件/模块划分及职责\n" +
        "3. 数据流和接口设计\n" +
        "4. 技术选型建议及理由\n" +
        "5. 潜在风险和权衡\n\n" +
        "输出结构化的设计文档。",
        "design",
      ),
    };
    for (const [k, v] of Object.entries(builtins)) this.skills.set(k, v);
  }

  private _loadFromDisk(): void {
    let dir = this.skillsDir;
    if (!path.isAbsolute(dir)) dir = path.join(this.projectDir, dir);
    if (!fs.existsSync(dir)) return;
    try {
      this._scanSkillsDir(dir);
    } catch { /* ignore */ }
  }

  /** Recursively scan for SKILL.md / *.md files in subdirectories */
  private _scanSkillsDir(dir: string): void {
    for (const fn of fs.readdirSync(dir)) {
      const fpath = path.join(dir, fn);
      let stat: fs.Stats;
      try { stat = fs.statSync(fpath); } catch { continue; }
      if (stat.isDirectory()) {
        // Recurse into subdirectory (e.g. officecli/SKILL.md)
        this._scanSkillsDir(fpath);
      } else if (fn.endsWith(".md")) {
        try {
          const skill = this._parseSkillFile(fpath);
          if (skill && !this.skills.has(skill.name)) this.skills.set(skill.name, skill);
        } catch { /* skip malformed */ }
      }
    }
  }

  private _parseSkillFile(fpath: string): Skill | null {
    const content = fs.readFileSync(fpath, "utf-8");
    const lines = content.split("\n");
    // Use parent directory name as skill name when file is SKILL.md
    let name = path.basename(fpath, ".md");
    if (name === "SKILL") name = path.basename(path.dirname(fpath));
    let description = "";
    let category = "custom";
    let promptStart = 0;
    // Support YAML front matter (--- name: ... ---) used by officecli skills
    if (lines.length > 0 && lines[0].trim() === "---") {
      // Find closing ---
      let endYaml = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { endYaml = i; break; }
      }
      if (endYaml > 0) {
        // Parse YAML front matter
        for (let i = 1; i < endYaml; i++) {
          const line = lines[i];
          const m = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
          if (m) {
            if (m[1] === "name") name = m[2];
            else if (m[1] === "description") description = m[2];
          }
        }
        promptStart = endYaml + 1;
      }
    }
    // Also support legacy format
    for (let i = promptStart; i < lines.length; i++) {
      const line = lines[i];
      if (i === promptStart && line.startsWith("# ") && !name) name = line.slice(2).trim();
      else if (line.startsWith("> ")) description = line.slice(2).trim();
      else if (line.startsWith("[category:")) {
        const m = line.match(/\[category:\s*(.+?)\s*\]/);
        if (m) category = m[1];
      } else if (line.trim() === "---") { promptStart = i + 1; break; }
      else break; // stop at first non-metadata line
    }
    let prompt = lines.slice(promptStart).join("\n").trim();
    if (!prompt) prompt = content;
    return new Skill(name, description, prompt, category, fpath);
  }

  listAll(): Skill[] { return [...this.skills.values()]; }

  listByCategory(): Record<string, Skill[]> {
    const cats: Record<string, Skill[]> = {};
    for (const s of this.skills.values()) {
      if (!cats[s.category]) cats[s.category] = [];
      cats[s.category].push(s);
    }
    return cats;
  }

  get(name: string): Skill | undefined { return this.skills.get(name); }

  register(skill: Skill): void { this.skills.set(skill.name, skill); }

  reload(): void {
    this.skills.clear();
    this._builtinSkills();
    this._loadFromDisk();
  }
}
