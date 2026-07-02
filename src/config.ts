/**
 * 配置加载器 — 读取 .cortex/settings.json
 */
import * as fs from "fs";
import * as path from "path";

function findUpwards(filename: string, startDir: string): string | null {
  let d = path.resolve(startDir);
  while (true) {
    const candidate = path.join(d, filename);
    if (fs.existsSync(candidate)) return candidate;
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

export function loadSettings(): Settings {
  const merged: Record<string, unknown> = {};
  // 1. Project-level
  const proj = findUpwards(".cortex/settings.json", process.cwd());
  if (proj) {
    try { Object.assign(merged, JSON.parse(fs.readFileSync(proj, "utf-8"))); } catch { /* ignore */ }
  }
  // 2. User-level
  const user = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".cortex", "settings.json");
  if (fs.existsSync(user)) {
    try { Object.assign(merged, JSON.parse(fs.readFileSync(user, "utf-8"))); } catch { /* ignore */ }
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
