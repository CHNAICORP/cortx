/**
 * 工具注册表 — 与 Python ToolRegistry 完全对应
 */
import { ToolFn, ToolMeta, FunctionSchema, RiskLevel, Capability } from './types.js';

const TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
};

interface RegisteredTool {
  fn: ToolFn;
  meta: ToolMeta;
  schema: FunctionSchema;
}

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  public schemas: FunctionSchema[] = [];

  register(
    description: string,
    risk: RiskLevel,
    capability: Capability,
    paramTypes: Record<string, string>,
    fn: ToolFn,
  ): void {
    const name = fn.name;
    const meta: ToolMeta = { description, risk, capability };
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const [pn, jt] of Object.entries(paramTypes)) {
      properties[pn] = { type: TYPE_MAP[jt] || "string", description: pn };
      required.push(pn);
    }
    // workDir is injected by executor, not exposed to LLM
    if (properties["workDir"]) {
      delete properties["workDir"];
      const idx = required.indexOf("workDir");
      if (idx >= 0) required.splice(idx, 1);
    }

    const schema: FunctionSchema = {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    };

    this.tools.set(name, { fn, meta, schema });
    // 去重：如果同名工具已注册，替换而非追加到 schemas 数组
    const existingIdx = this.schemas.findIndex(s => s.function.name === name);
    if (existingIdx >= 0) {
      this.schemas[existingIdx] = schema;
    } else {
      this.schemas.push(schema);
    }
  }

  get(name: string): ToolFn | undefined {
    return this.tools.get(name)?.fn;
  }

  meta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.meta;
  }

  get schemaList(): FunctionSchema[] {
    return this.schemas;
  }
}

export const registry = new ToolRegistry();
