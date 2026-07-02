/**
 * 配置加载器 — 读取 .cortx/settings.json
 */
import * as fs from "fs";
import * as path from "path";

function findUpwards(filename: string, startDir: string): string | null {
  let d = path.resolve(startDir);
  while (true) {
    const candidate = path.join(d, filename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

export interface Settings {
  model?: string;
  provider?: string;
  apiKey?: string;
  providers?: Record<string, { api_key?: string; base_url?: string; models?: Record<string, string> }>;
  permission_mode?: string;
  context_limit?: number;
  max_steps?: number;
  work_dir?: string;
  [key: string]: unknown;
}

function smartMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val === null || val === "" || val === 0 || val === undefined) {
      // Empty values do not override (matching Python _smart_merge)
      continue;
    }
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && !Array.isArray(result[key]) && result[key] !== null) {
      result[key] = smartMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function loadSettings(): Settings {
  const merged: Record<string, unknown> = {};
  // 1. Project-level
  const proj = findUpwards(".cortx/settings.json", process.cwd());
  if (proj) {
    try { Object.assign(merged, JSON.parse(fs.readFileSync(proj, "utf-8"))); } catch { /* ignore */ }
  }
  // 2. User-level (smart merge — deep merge, empty values don't override)
  const user = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".cortx", "settings.json");
  if (fs.existsSync(user)) {
    try {
      const userSettings = JSON.parse(fs.readFileSync(user, "utf-8"));
      const result = smartMerge(merged, userSettings);
      // Apply the merge result back
      for (const key of Object.keys(merged)) delete merged[key];
      Object.assign(merged, result);
    } catch { /* ignore */ }
  }
  // 3. 首次运行自动创建全局配置
  if (Object.keys(merged).length === 0 && !process.env.CORTEX_API_KEY) {
    const template: Record<string, unknown> = {
      model: "pro", provider: "deepseek",
      providers: { deepseek: { api_key: "", base_url: "https://api.deepseek.com/v1", models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" } } },
      web_search: {
        provider: "duckduckgo",          // duckduckgo | brave | serpapi | tavily
        brave_api_key: "",
        serpapi_api_key: "",
        tavily_api_key: "",
        max_results: 5,
        timeout: 10,
      },
      max_steps: 10, context_limit: 1000000, permission_mode: "standard",
      auto_extract_memory: true, memory_enabled: true, sessions_enabled: true,
    };
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, JSON.stringify(template, null, 2), "utf-8");
    console.error(`\n  📝 首次运行: 已创建全局配置 ${user}`);
    console.error(`  ⚙️  请在 providers.deepseek.api_key 填入你的 API Key\n`);
    Object.assign(merged, template);
  }
  // 3. Env override
  if (process.env.CORTEX_API_KEY) {
    const provider = (merged.provider as string) || "deepseek";
    const providers = (merged.providers || {}) as Record<string, Record<string, unknown>>;
    providers[provider] = providers[provider] || {};
    providers[provider].api_key = process.env.CORTEX_API_KEY;
    merged.providers = providers;
  }
  if (process.env.CORTEX_MODEL) merged.model = process.env.CORTEX_MODEL;
  return merged as Settings;
}

export function getApiKey(settings: Settings): string {
  const provider = settings.provider || "deepseek";
  const providers = settings.providers || {};
  const pcfg = providers[provider] || {};
  return (pcfg.api_key as string) || (settings.apiKey as string) || "";
}

export function getBaseUrl(settings: Settings): string {
  const provider = settings.provider || "deepseek";
  const providers = settings.providers || {};
  const pcfg = providers[provider] || {};
  return (pcfg.base_url as string) || "https://api.deepseek.com/v1";
}
