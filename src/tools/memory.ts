/**
 * 记忆 + 辅助工具
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { getToolContext } from '../core/tool_context.js';

function getMemoryPath(workDir: string): string {
  return path.join(workDir, "memory.md");
}

registry.register("记住事实", RiskLevel.SAFE, Capability.FS_WRITE,
  {
    workDir: "工作目录",
    name: "事实名称",
    description: "详细描述"
  },
  function remember_fact(workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"]);
    const desc = String(args["description"]);
    const mp = getMemoryPath(workDir);
    const dir = path.dirname(mp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `- ${name} ${desc}\n`;
    // 去重
    if (fs.existsSync(mp) && fs.readFileSync(mp, "utf-8").includes(line.trim())) return "(已存在)";
    fs.appendFileSync(mp, line, "utf-8");
    return `已记住: ${name}`;
  },
);

registry.register("回忆事实", RiskLevel.SAFE, Capability.FS_READ,
  {
    workDir: "工作目录",
    query: "搜索关键词（可选，留空返回所有记忆）"
  },
  function recall_fact(workDir: string, args: Record<string, unknown>): string {
    const q = String(args["query"] || "").toLowerCase();
    const mp = getMemoryPath(workDir);
    if (!fs.existsSync(mp)) return "(没有记住任何事实)";
    const lines = fs.readFileSync(mp, "utf-8").split("\n").filter(l => l.startsWith("- "));
    if (!lines.length) return "(没有记住任何事实)";
    const filtered = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
    if (!filtered.length) return `(未找到包含 '${q}' 的记忆)`;
    return `记忆列表:\n${filtered.join("\n")}`;
  },
);

registry.register("删除记忆", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", name: "string" },
  function forget_fact(workDir: string, args: Record<string, unknown>): string {
    const name = String(args["name"]);
    const mp = getMemoryPath(workDir);
    if (!fs.existsSync(mp)) return "(x) 记忆系统不可用";
    let lines = fs.readFileSync(mp, "utf-8").split("\n");
    const before = lines.length;
    lines = lines.filter(l => !l.includes(name));
    if (lines.length === before) return `(x) 未找到: ${name}`;
    fs.writeFileSync(mp, lines.join("\n"), "utf-8");
    return `已忘记: ${name}`;
  },
);

registry.register(
  "弹出交互式询问面板（AskUserPanel）向用户提问并收集回答，支持一次最多 4 个问题。\n"
  + "每个问题可提供 2-6 个选项（单选/多选）或省略选项让用户自由输入文本。\n"
  + "questions_json 是 JSON 数组字符串，每个元素:\n"
  + "  {\"question\": \"完整问题(必填)\", \"header\": \"短标签(可选,≤12字)\", \"multiSelect\": false,\n"
  + "   \"options\": [{\"label\": \"选项文本\", \"description\": \"选项说明(可选)\"}]}\n"
  + "用法: ask_user(questions_json='[{\"question\":\"用哪种部署方式?\",\"header\":\"部署\",\"options\":[{\"label\":\"Docker\"},{\"label\":\"PM2\"}]}]')\n"
  + "仅当真正需要用户决策且无法从上下文推断时使用。用户取消(ESC)或非交互模式会返回相应标记，此时应自行决策并继续，不要重复调用。",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", questions_json: "string" },
  async function ask_user(_wd: string, args: Record<string, unknown>): Promise<string> {
    const questionsJson = String(args["questions_json"] ?? args["questionsJson"] ?? "");
    const ctx = getToolContext();
    if (ctx.askUserPanel) {
      return await ctx.askUserPanel(questionsJson);
    }
    // fallback: 没有设置交互回调
    return `[需要用户确认] ${questionsJson}`;
  },
);

registry.register(
  "用 Python AST 检查 Python 代码语法错误。支持文件路径或直接传入代码。",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string", code: "string" },
  function python_lint(workDir: string, args: Record<string, unknown>): string {
    const fp = String(args["filePath"] || "");
    const code = String(args["code"] || "");
    let source = "";
    if (code) {
      source = code;
    } else if (fp) {
      const d = path.resolve(path.isAbsolute(fp) ? fp : path.join(workDir, fp));
      if (!fs.existsSync(d)) return `(x) 文件不存在: ${fp}`;
      try {
        source = fs.readFileSync(d, "utf-8");
      } catch (e) {
        return `(x) 读取文件失败: ${e}`;
      }
    } else {
      return "(x) 需要 filePath 或 code 参数";
    }
    // 使用 Python AST 进行语法检查（与 Python 端对齐）
    try {
      const result = spawnSync(
        "python", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"],
        { input: source, timeout: 10000, encoding: "utf-8" }
      );
      if (result.status === 0) {
        return "OK — 语法检查通过";
      }
      const stderr = (result.stderr || "").trim();
      // 提取语法错误信息
      const m = stderr.match(/line (\d+).*?(?:SyntaxError:\s*(.*))/s);
      if (m) {
        return `语法错误 第${m[1]}行: ${m[2] || stderr.slice(0, 200)}`;
      }
      return `语法错误: ${stderr.slice(0, 300)}`;
    } catch (e) {
      // Python 不可用时使用简版检查
      return `(x) Python 不可用: ${e}`;
    }
  },
);
