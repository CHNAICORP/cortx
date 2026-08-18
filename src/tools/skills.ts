/**
 * 技能工具 — list_skills / use_skill / skill_install / skill_remove
 *
 * 与 Python tools.py 中的技能工具对齐
 */
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { getToolContext } from '../core/tool_context.js';

// ── 下载辅助 ──

function downloadText(url: string, redirects = 0): Promise<string> {
  if (redirects > 5) return Promise.reject(new Error("重定向次数过多"));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "cortex-agent/skill-install" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        if (loc) { downloadText(loc, redirects + 1).then(resolve).catch(reject); return; }
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("下载超时")); });
  });
}

/** 从 source 解析下载 URL 和技能名称 */
function resolveSource(source: string): { urls: string[]; name: string; sourceType: string } {
  // 直接 URL
  if (source.startsWith("http://") || source.startsWith("https://")) {
    if (source.includes("raw.githubusercontent.com")) {
      const parts = source.split("/");
      const name = parts[4] || source.split("/").pop()?.replace(".md", "") || "skill";
      return { urls: [source], name, sourceType: "github" };
    }
    if (source.includes("github.com/")) {
      const m = source.match(/github\.com\/([^/]+\/[^/]+)/);
      if (m) {
        const repo = m[1].replace(/\.git$/, "").replace(/\/$/, "");
        const name = repo.split("/")[1];
        return {
          urls: [
            `https://raw.githubusercontent.com/${repo}/main/SKILL.md`,
            `https://raw.githubusercontent.com/${repo}/master/SKILL.md`,
          ],
          name, sourceType: "github",
        };
      }
    }
    const name = source.split("/").pop()?.replace(/\.md$/, "") || "custom-skill";
    return { urls: [source], name, sourceType: "url" };
  }
  // GitHub 简写: owner/repo
  if (source.includes("/") && !source.startsWith(".")) {
    const name = source.split("/")[1];
    return {
      urls: [
        `https://raw.githubusercontent.com/${source}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${source}/master/SKILL.md`,
      ],
      name, sourceType: "github",
    };
  }
  return { urls: [], name: source, sourceType: "unknown" };
}

// ── 工具注册 ──

registry.register(
  "列出所有可用的技能（Skills）。技能是可复用的专家级指引模板，能为特定任务提供专业方法论\n"
  + "（如代码审查、PPT 制作、Office 文档处理、安全审计等）。无需参数。\n"
  + "用法: list_skills()",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "工作目录" },
  function list_skills(_workDir: string): string {
    const mgr = getToolContext().skillManager;
    if (!mgr) return "(x) 技能系统不可用";
    const cats = mgr.listByCategory();
    const total = mgr.listAll().length;
    if (total === 0) return "(没有可用技能)";
    const lines: string[] = [`可用技能 (${total} 个):\n`];
    for (const cat of Object.keys(cats).sort()) {
      lines.push(`  [${cat}]`);
      for (const s of cats[cat]) {
        const desc = s.description || "(无描述)";
        lines.push(`    • ${s.name} — ${desc}`);
      }
      lines.push("");
    }
    lines.push('用 use_skill(name="技能名") 加载某技能的完整指引。');
    return lines.join("\n");
  },
);

registry.register(
  "加载指定技能的完整内容（专家指引/prompt）到上下文。先用 list_skills 查看可用技能名。\n"
  + "加载后请按技能指引执行用户任务。\n"
  + '用法: use_skill(name="code-review")',
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "工作目录", name: "技能名称" },
  function use_skill(_workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"] || "").trim();
    if (!name) return "(x) 请提供技能名称。用 list_skills() 查看可用技能。";
    const mgr = getToolContext().skillManager;
    if (!mgr) return "(x) 技能系统不可用";
    const skill = mgr.get(name);
    if (!skill) {
      const available = mgr.listAll().map(s => s.name).sort().join(", ");
      return `(x) 技能不存在: ${name}\n可用技能: ${available}`;
    }
    return skill.toPrompt();
  },
);

registry.register(
  "从 GitHub 仓库或 URL 安装技能（SKILL.md）。安装后自动注册到技能系统，立即可用。\n"
  + "参数:\n"
  + '  source — 技能来源，支持: GitHub 简写("owner/repo")、GitHub URL、raw URL、直接 .md URL\n'
  + '  name   — 技能名称覆盖（可选，默认从来源推断）\n'
  + "用法:\n"
  + '  skill_install(source="alchaincyf/huashu-design")\n'
  + '  skill_install(source="https://github.com/pengpengliu1212-art/humanize-write")\n'
  + '  skill_install(source="https://example.com/skills/my-skill.md", name="my-skill")',
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "工作目录", source: "技能来源URL或GitHub路径", name: "技能名称（可选）" },
  async function skill_install(workDir: string, args: Record<string, unknown>): Promise<string> {
    const source = String(args["source"] || "").trim();
    const nameOverride = String(args["name"] || "").trim();
    if (!source) return "(x) 请提供 skill 来源（GitHub owner/repo 或 URL）";

    const { urls, name: defaultName, sourceType } = resolveSource(source);
    const name = nameOverride || defaultName;
    if (!urls.length) return `(x) 无法解析来源: ${source}`;

    // 下载 SKILL.md
    let content = "";
    let lastErr = "";
    for (const url of urls) {
      try {
        content = await downloadText(url);
        if (content && content.length > 10 && !content.includes("404: Not Found")) break;
        lastErr = `内容无效或为 404: ${url}`;
      } catch (e) {
        lastErr = `${e}`;
      }
    }
    if (!content || content.length < 10) {
      return `(x) 下载失败: ${lastErr}\n请检查来源是否正确: ${source}`;
    }

    // 保存到 .cortx/skills/<name>/SKILL.md
    const skillDir = path.join(workDir, ".cortx", "skills", name);
    const skillPath = path.join(skillDir, "SKILL.md");
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, content, "utf-8");
    } catch (e) {
      return `(x) 写入文件失败: ${e}`;
    }

    // 计算 hash
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    // 更新 skills-lock.json
    try {
      const lockPath = path.join(workDir, "skills-lock.json");
      let lock: { version: number; skills: Record<string, unknown> } = { version: 1, skills: {} };
      if (fs.existsSync(lockPath)) {
        try { lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")); } catch { /* ignore */ }
      }
      lock.skills[name] = { source, sourceType, skillPath: "SKILL.md", computedHash: hash };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf-8");
    } catch { /* lock file update failure is non-critical */ }

    // 重新加载 SkillManager
    const mgr = getToolContext().skillManager;
    if (mgr) mgr.reload();

    // 提取 description
    const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m);
    const desc = descMatch ? descMatch[1] : "(从文件内容推断)";

    return `✅ 技能安装成功!\n  名称: ${name}\n  描述: ${desc}\n  来源: ${source}\n  路径: ${skillPath}\n\n用 use_skill(name="${name}") 加载该技能，或 list_skills() 查看所有技能。`;
  },
);

registry.register(
  "删除已安装的技能。从磁盘移除 SKILL.md 并更新 skills-lock.json。\n"
  + '用法: skill_remove(name="humanize-write")',
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "工作目录", name: "要删除的技能名称" },
  function skill_remove(workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"] || "").trim();
    if (!name) return "(x) 请提供要删除的技能名称";
    if (["code-review", "refactor", "test-writer", "doc-writer", "debug", "explain", "architect"].includes(name)) {
      return `(x) "${name}" 是内置技能，无法删除`;
    }

    const skillDir = path.join(workDir, ".cortx", "skills", name);
    const skillFile = path.join(workDir, ".cortx", "skills", name + ".md");
    let removed = false;

    if (fs.existsSync(skillDir)) {
      try { fs.rmSync(skillDir, { recursive: true }); removed = true; } catch (e) { return `(x) 删除失败: ${e}`; }
    } else if (fs.existsSync(skillFile)) {
      try { fs.unlinkSync(skillFile); removed = true; } catch (e) { return `(x) 删除失败: ${e}`; }
    }
    if (!removed) return `(x) 技能不存在: ${name}`;

    // 更新 skills-lock.json
    try {
      const lockPath = path.join(workDir, "skills-lock.json");
      if (fs.existsSync(lockPath)) {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        if (lock.skills && lock.skills[name]) {
          delete lock.skills[name];
          fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf-8");
        }
      }
    } catch { /* non-critical */ }

    // 重新加载
    const mgr = getToolContext().skillManager;
    if (mgr) mgr.reload();

    return `✅ 技能已删除: ${name}`;
  },
);
