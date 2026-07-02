"""
Cortex Agent LLM Provider — 多 Provider 支持
══════════════════════════════════════════════

支持 DeepSeek / OpenAI，流式 + 非流式调用。
模型别名解析 + base_url 配置。
"""

import json, time, httpx
from openai import OpenAI
from typing import List, Dict, Callable, Optional, Tuple


# ══════════════════════════════════════════════════════════════
# LLM Provider
# ══════════════════════════════════════════════════════════════

class LLMProvider:
    # 默认提供者注册表：settings.json 中 providers 段可覆盖
    DEFAULT_PROVIDERS = {
        "deepseek": {
            "name": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "models": {
                "flash": "deepseek-v4-flash",
                "pro":   "deepseek-v4-pro",
            },
        },
        "openai": {
            "name": "openai",
            "base_url": "https://api.openai.com/v1",
            "models": {},
        },
    }
    # 当前激活的提供者（首次使用前由 AgentConfig.setup_providers 初始化）
    _active = None
    _provider_name = None

    @classmethod
    def setup(cls, providers: dict = None, active: str = None):
        """从 settings.json 注册 provider 列表，并设置当前使用的 provider。
        providers 结构: { name: { base_url, api_key?, models: { alias: model_id } } }
        """
        if providers:
            for name, cfg in providers.items():
                cls.DEFAULT_PROVIDERS[name] = {
                    "name": name,
                    "base_url": cfg.get("base_url", ""),
                    "models": dict(cfg.get("models", {})),
                }
        cls._provider_name = active or "deepseek"
        cls._active = cls.DEFAULT_PROVIDERS.get(cls._provider_name, cls.DEFAULT_PROVIDERS["deepseek"])

    @classmethod
    def resolve(cls, name: str) -> str:
        """将别名解析为真实 model id。先查当前 provider 的 models 映射，再查全局。"""
        active = cls._active or cls.DEFAULT_PROVIDERS.get("deepseek", {})
        models = active.get("models", {})
        if name in models:
            return models[name]
        # 回退：跨 provider 查找
        for p in cls.DEFAULT_PROVIDERS.values():
            if name in p.get("models", {}):
                return p["models"][name]
        return name  # 按原始值传递（可能是完整 model id）

    @classmethod
    def base_url(cls) -> str:
        active = cls._active or cls.DEFAULT_PROVIDERS.get("deepseek", {})
        return active.get("base_url", "https://api.deepseek.com/v1")

    @classmethod
    def provider_name(cls) -> str:
        return cls._provider_name or "deepseek"

    def __init__(self, api_key: str, model: str, tools: List[Dict],
                 timeout: float = 60.0):
        self.client = OpenAI(api_key=api_key, base_url=self.base_url(),
                             timeout=httpx.Timeout(timeout, connect=10.0))
        self.model = model; self.tools = tools
        # ── 缓存命中率追踪 ──
        self._call_count: int = 0
        self._cache_hits: int = 0
        self._total_input_tokens: int = 0
        self._total_cached_tokens: int = 0

    @property
    def cache_stats(self) -> dict:
        """返回缓存统计信息。"""
        rate = (self._cache_hits / self._call_count * 100) if self._call_count > 0 else 0
        return {
            "calls": self._call_count,
            "cache_hits": self._cache_hits,
            "hit_rate": rate,
            "total_input_tokens": self._total_input_tokens,
            "total_cached_tokens": self._total_cached_tokens,
        }

    def _track_usage(self, resp):
        """从 API 响应中提取 usage 信息更新缓存统计。"""
        try:
            usage = getattr(resp, 'usage', None)
            if usage:
                self._call_count += 1
                self._total_input_tokens += getattr(usage, 'prompt_tokens', 0) or 0
                cached = getattr(usage, 'prompt_tokens_details', None)
                if cached:
                    ct = getattr(cached, 'cached_tokens', 0) or 0
                    self._total_cached_tokens += ct
                    if ct > 0:
                        self._cache_hits += 1
        except Exception:
            self._call_count += 1  # 至少计数

    def switch(self, alias: str): self.model = self.resolve(alias)

    def call(self, messages: List[Dict]) -> Tuple[str, Optional[List[Dict]], Optional[str]]:
        resp = self.client.chat.completions.create(
            model=self.model, messages=messages, tools=self.tools,
            extra_body={"thinking": {"type": "enabled"}}, reasoning_effort="max")
        self._track_usage(resp)
        msg = resp.choices[0].message
        text = msg.content or ""
        reasoning = getattr(msg, 'reasoning_content', None) or None
        tcs = None
        if msg.tool_calls:
            tcs = [{"id": tc.id, "name": tc.function.name,
                    "args": json.loads(tc.function.arguments) if tc.function.arguments else {}}
                   for tc in msg.tool_calls]
        return text, tcs, reasoning

    def call_stream(self, messages: List[Dict],
                    on_text: Callable[[str], None] = None,
                    on_answer: Callable[[str], None] = None,
                    on_tool: Callable[[str, dict], None] = None
                    ) -> Tuple[str, Optional[List[Dict]], str]:
        """流式调用：返回 (text, tool_calls, reasoning_text)"""
        resp = self.client.chat.completions.create(
            model=self.model, messages=messages, tools=self.tools,
            extra_body={"thinking": {"type": "enabled"}}, reasoning_effort="max",
            stream=True)
        reasoning_parts, text_parts = [], []
        tool_buf: Dict[int, dict] = {}
        reasoning_done = False
        tool_seen = False
        for chunk in resp:
            delta = chunk.choices[0].delta if chunk.choices else None
            if not delta: continue
            if getattr(delta, 'reasoning_content', None):
                reasoning_parts.append(delta.reasoning_content)
                if on_text: on_text(delta.reasoning_content)        # thinking tokens → deep grey
            if delta.content:
                if on_answer and not reasoning_done:
                    on_answer("")  # signal: flush reasoning, switch to bright
                    reasoning_done = True
                text_parts.append(delta.content)
                if on_answer: on_answer(delta.content)               # answer tokens → bright
            if delta.tool_calls:
                if not tool_seen and on_tool:
                    on_tool("", {})  # sentinel: close reasoning before tool labels
                    tool_seen = True
                for tcd in delta.tool_calls:
                    idx = tcd.index
                    if idx not in tool_buf:
                        tool_buf[idx] = {"id": tcd.id or "", "name": "", "args_json": ""}
                    if tcd.id: tool_buf[idx]["id"] = tcd.id
                    if tcd.function:
                        if tcd.function.name: tool_buf[idx]["name"] += tcd.function.name
                        if tcd.function.arguments: tool_buf[idx]["args_json"] += tcd.function.arguments
        text = "".join(text_parts); reasoning = "".join(reasoning_parts)
        tcs = None
        if tool_buf:
            tcs = []
            for idx in sorted(tool_buf.keys()):
                tb = tool_buf[idx]
                try: args = json.loads(tb["args_json"])
                except json.JSONDecodeError: args = {}
                tcs.append({"id": tb["id"], "name": tb["name"], "args": args})
        # 流式调用：至少计数 + 估算 token
        self._call_count += 1
        total_chars = sum(len(m.get("content", "") or "") for m in messages)
        self._total_input_tokens += int(total_chars * 0.4)
        return text, tcs, reasoning

