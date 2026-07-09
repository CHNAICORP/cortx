"""
Cortex Agent LLM Provider — 多 Provider 支持
══════════════════════════════════════════════

支持 DeepSeek / OpenAI / GLM（智谱）/ Anthropic（Claude），流式 + 非流式调用。
模型别名解析 + base_url 配置 + provider 感知的 thinking 参数。

Anthropic Claude 使用独立的 Messages API（非 OpenAI 兼容格式），
内部自动完成 OpenAI ↔ Anthropic 消息格式转换。
"""

import json, time, httpx, uuid
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
            "models": {
                # ── GPT-5.4 系列 (最新旗舰) ──
                "5.4":       "gpt-5.4",
                "5.4-mini":  "gpt-5.4-mini",
                # ── GPT-5.2 系列 ──
                "5.2":       "gpt-5.2",
                "5.2-pro":   "gpt-5.2-pro",
                # ── GPT-4.1 系列 (1M 上下文) ──
                "4.1":       "gpt-4.1",
                "4.1-mini":  "gpt-4.1-mini",
                # ── 经典 ──
                "4o":        "gpt-4o",
                "4o-mini":   "gpt-4o-mini",
            },
        },
        "glm": {
            "name": "glm",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "models": {
                "5.2":       "glm-5.2",
                "5.1":       "glm-5.1",
                "turbo":     "glm-5-turbo",
                "4.7":       "glm-4.7",
                "4.7-flash": "glm-4.7-flash",
                "4-long":    "glm-4-long",
            },
        },
        "anthropic": {
            "name": "anthropic",
            "base_url": "https://api.anthropic.com",
            "models": {
                # ── 最新旗舰系列 ──
                "fable":      "claude-fable-5",        # Fable 5 — 最强旗舰
                "mythos":     "claude-mythos-5",       # Mythos 5 — 新一代推理
                "sonnet":     "claude-sonnet-5",       # Sonnet 5 — 均衡高效
                # ── Opus 系列 ──
                "opus":       "claude-opus-4-8",       # Opus 4.8 — 顶级编码
                "opus-pro":   "claude-opus-4-7",       # Opus 4.7
                # ── 其他 ──
                "haiku":      "claude-haiku-4-5",      # Haiku 4.5 — 快速轻量
            },
        },
    }

    # ── Model Capabilities Registry ──
    # 每个模型的实际上下文窗口和最大输出 token 数。
    # context_limit=0 或 max_tokens=0 时自动从此注册表解析。
    MODEL_CAPABILITIES = {
        # ── DeepSeek V4 系列 — 1M 上下文, 384K 最大输出 ──
        "deepseek-v4-flash":  {"context_window": 1_000_000, "max_output_tokens": 384_000},
        "deepseek-v4-pro":   {"context_window": 1_000_000, "max_output_tokens": 384_000},
        # ── GLM 系列 ──
        "glm-5.2":            {"context_window": 1_000_000, "max_output_tokens": 8192},   # 旗舰 1M
        "glm-5.1":            {"context_window": 128_000,   "max_output_tokens": 8192},
        "glm-5-turbo":        {"context_window": 128_000,   "max_output_tokens": 8192},
        "glm-5":              {"context_window": 128_000,   "max_output_tokens": 8192},
        "glm-4.7":            {"context_window": 200_000,   "max_output_tokens": 8192},
        "glm-4.7-flashx":    {"context_window": 200_000,   "max_output_tokens": 8192},
        "glm-4.7-flash":     {"context_window": 200_000,   "max_output_tokens": 8192},  # 免费
        "glm-4.5-air":        {"context_window": 128_000,   "max_output_tokens": 8192},
        "glm-4-long":         {"context_window": 1_000_000, "max_output_tokens": 8192},  # 1M 长文
        "glm-4-plus":         {"context_window": 128_000,   "max_output_tokens": 8192},
        # ── OpenAI GPT-5.x 系列 (最新) ──
        "gpt-5.4":            {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.4-mini":      {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.4-nano":      {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.2":            {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.2-pro":       {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.1":            {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.1-mini":      {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5.1-codex":     {"context_window": 1_000_000, "max_output_tokens": 128_000},
        "gpt-5":              {"context_window": 1_000_000, "max_output_tokens": 32_000},
        "gpt-5-mini":        {"context_window": 1_000_000, "max_output_tokens": 32_000},
        "gpt-5-nano":        {"context_window": 1_000_000, "max_output_tokens": 32_000},
        # ── OpenAI GPT-4.1 系列 — 1M 上下文 ──
        "gpt-4.1":            {"context_window": 1_000_000, "max_output_tokens": 32_000},
        "gpt-4.1-mini":      {"context_window": 1_000_000, "max_output_tokens": 32_000},
        "gpt-4.1-nano":      {"context_window": 1_000_000, "max_output_tokens": 32_000},
        # ── OpenAI 推理模型 ──
        "o4-mini":            {"context_window": 200_000,   "max_output_tokens": 100_000},
        "o3":                {"context_window": 200_000,   "max_output_tokens": 100_000},
        "o3-mini":           {"context_window": 200_000,   "max_output_tokens": 100_000},
        # ── OpenAI 经典 ──
        "gpt-4o":             {"context_window": 128_000,   "max_output_tokens": 16384},
        "gpt-4o-mini":        {"context_window": 128_000,   "max_output_tokens": 16384},
        # ── Anthropic Claude 系列 ──
        # 旗舰系列 — 1M 上下文窗口
        "claude-fable-5":     {"context_window": 1_000_000, "max_output_tokens": 32000},
        "claude-mythos-5":    {"context_window": 1_000_000, "max_output_tokens": 32000},
        "claude-sonnet-5":    {"context_window": 1_000_000, "max_output_tokens": 16000},
        # Opus 系列 — 200K 上下文
        "claude-opus-4-8":    {"context_window": 200_000,   "max_output_tokens": 32000},
        "claude-opus-4-7":    {"context_window": 200_000,   "max_output_tokens": 32000},
        "claude-opus-4-6":    {"context_window": 200_000,   "max_output_tokens": 32000},
        "claude-opus-4-5":    {"context_window": 200_000,   "max_output_tokens": 16000},
        "claude-opus-4-1":    {"context_window": 200_000,   "max_output_tokens": 8192},
        # Sonnet 4.x — 1M 上下文（beta）
        "claude-sonnet-4-6":  {"context_window": 1_000_000, "max_output_tokens": 16000},
        "claude-sonnet-4-5":  {"context_window": 1_000_000, "max_output_tokens": 16000},
        # Haiku — 200K 上下文
        "claude-haiku-4-5":   {"context_window": 200_000,   "max_output_tokens": 8192},
        "claude-mythos-preview": {"context_window": 200_000, "max_output_tokens": 16000},
    }
    # 按前缀匹配的默认能力（用于未注册的模型名）
    _PREFIX_DEFAULTS = [
        ("deepseek",  {"context_window": 1_000_000, "max_output_tokens": 384_000}),
        ("glm",       {"context_window": 128_000,   "max_output_tokens": 8192}),
        ("gpt-5.4",   {"context_window": 1_000_000, "max_output_tokens": 128_000}),
        ("gpt-5.2",   {"context_window": 1_000_000, "max_output_tokens": 128_000}),
        ("gpt-5.1",   {"context_window": 1_000_000, "max_output_tokens": 128_000}),
        ("gpt-5",     {"context_window": 1_000_000, "max_output_tokens": 32_000}),
        ("gpt-4.1",   {"context_window": 1_000_000, "max_output_tokens": 32_000}),
        ("gpt-4",     {"context_window": 128_000,   "max_output_tokens": 16384}),
        ("gpt-3.5",   {"context_window": 16_000,    "max_output_tokens": 4096}),
        ("o4",        {"context_window": 200_000,   "max_output_tokens": 100_000}),
        ("o3",        {"context_window": 200_000,   "max_output_tokens": 100_000}),
        ("claude-fable",  {"context_window": 1_000_000, "max_output_tokens": 32000}),
        ("claude-mythos", {"context_window": 1_000_000, "max_output_tokens": 32000}),
        ("claude-sonnet", {"context_window": 1_000_000, "max_output_tokens": 16000}),
        ("claude-opus",   {"context_window": 200_000,   "max_output_tokens": 32000}),
        ("claude-haiku",  {"context_window": 200_000,   "max_output_tokens": 8192}),
    ]
    # 全局回退默认值
    _FALLBACK_CAPS = {"context_window": 128_000, "max_output_tokens": 8192}
    # 当前激活的提供者（首次使用前由 AgentConfig.setup_providers 初始化）
    _active = None
    _provider_name = None
    # Anthropic API 版本
    ANTHROPIC_VERSION = "2023-06-01"

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

    @classmethod
    def is_anthropic(cls) -> bool:
        """当前 provider 是否为 Anthropic（使用独立的 Messages API）。"""
        return cls.provider_name() == "anthropic"

    @classmethod
    def resolve_capabilities(cls, model: str) -> dict:
        """解析模型的上下文窗口和最大输出 token 数。
        
        查找顺序:
          1. MODEL_CAPABILITIES 精确匹配
          2. _PREFIX_DEFAULTS 前缀匹配
          3. _FALLBACK_CAPS 回退默认值
        
        返回: {"context_window": int, "max_output_tokens": int}
        """
        model_lower = model.lower().strip()
        # 1. 精确匹配
        if model_lower in cls.MODEL_CAPABILITIES:
            return cls.MODEL_CAPABILITIES[model_lower]
        # 2. 前缀匹配
        for prefix, caps in cls._PREFIX_DEFAULTS:
            if model_lower.startswith(prefix):
                return caps
        # 3. 回退
        return cls._FALLBACK_CAPS

    def __init__(self, api_key: str, model: str, tools: List[Dict],
                 timeout: float = 60.0, max_tokens: int = 8192):
        self.api_key = api_key
        self.client = OpenAI(api_key=api_key, base_url=self.base_url(),
                             timeout=httpx.Timeout(timeout, connect=10.0))
        self.model = model; self.tools = tools
        self.max_tokens = max_tokens
        # ── 缓存命中率追踪 ──
        self._call_count: int = 0
        self._cache_hits: int = 0
        self._total_input_tokens: int = 0
        self._total_cached_tokens: int = 0

    @property
    def cache_stats(self) -> dict:
        """返回缓存统计信息。"""
        # 正确的平均缓存命中率 = 已缓存 token / 总输入 token
        rate = (self._total_cached_tokens / self._total_input_tokens * 100) if self._total_input_tokens > 0 else 0
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

    def _thinking_kwargs(self, thinking: bool) -> dict:
        """根据当前 provider 生成 thinking 参数。
        
        GLM 使用 thinking_budget 控制推理强度，DeepSeek/OpenAI 使用 reasoning_effort。
        Anthropic 使用独立的 thinking 参数（在 _call_anthropic 中处理）。
        """
        if not thinking:
            return {}
        provider = self.provider_name()
        if provider == "glm":
            # GLM-5.2: thinking.type + thinking_budget
            return {"extra_body": {"thinking": {"type": "enabled", "thinking_budget": "max"}}}
        if provider == "anthropic":
            return {}  # Anthropic thinking 在 _call_anthropic 中处理
        # DeepSeek / OpenAI / default
        return {"extra_body": {"thinking": {"type": "enabled"}}, "reasoning_effort": "max"}

    # ══════════════════════════════════════════════════════════════
    # Anthropic Messages API 转换层
    # ══════════════════════════════════════════════════════════════

    def _convert_tools_to_anthropic(self) -> List[Dict]:
        """将 OpenAI function-calling 格式的 tools 转为 Anthropic tools 格式。"""
        result = []
        for tool in self.tools:
            if tool.get("type") == "function":
                fn = tool.get("function", {})
                result.append({
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
                })
        return result

    def _convert_messages_to_anthropic(self, messages: List[Dict]) -> Tuple[str, List[Dict]]:
        """将 OpenAI 消息格式转为 Anthropic Messages API 格式。
        
        Anthropic 格式差异:
        - system 消息单独提取为顶层参数
        - tool_calls → content blocks (type=tool_use)
        - tool role → content blocks (type=tool_result)
        - 连续同角色消息需要合并
        
        返回: (system_prompt, anthropic_messages)
        """
        system_parts = []
        anthropic_msgs: List[Dict] = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                if content:
                    system_parts.append(content if isinstance(content, str) else str(content))
                continue

            if role == "tool":
                # OpenAI tool result → Anthropic user message with tool_result content block
                tool_call_id = msg.get("tool_call_id", "")
                anthropic_msgs.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content if isinstance(content, str) else str(content),
                    }]
                })
                continue

            if role == "assistant":
                blocks = []
                # Text content
                if content:
                    blocks.append({"type": "text", "text": content})
                # Tool calls → tool_use blocks
                for tc in msg.get("tool_calls", []):
                    fn = tc.get("function", {})
                    args_str = fn.get("arguments", "{}")
                    try:
                        args = json.loads(args_str) if isinstance(args_str, str) else args_str
                    except json.JSONDecodeError:
                        args = {}
                    blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", str(uuid.uuid4())),
                        "name": fn.get("name", ""),
                        "input": args,
                    })
                if blocks:
                    anthropic_msgs.append({"role": "assistant", "content": blocks})
                continue

            if role == "user":
                anthropic_msgs.append({
                    "role": "user",
                    "content": content if isinstance(content, str) else str(content),
                })
                continue

        return "\n\n".join(system_parts), anthropic_msgs

    def _parse_anthropic_response(self, data: dict) -> Tuple[str, Optional[List[Dict]], Optional[str], str]:
        """解析 Anthropic 非流式响应。
        
        返回: (text, tool_calls, reasoning, finish_reason)
        """
        content_blocks = data.get("content", [])
        text_parts = []
        reasoning_parts = []
        tool_calls = []
        finish_reason = data.get("stop_reason", "")

        for block in content_blocks:
            btype = block.get("type", "")
            if btype == "text":
                text_parts.append(block.get("text", ""))
            elif btype == "thinking":
                reasoning_parts.append(block.get("thinking", ""))
            elif btype == "tool_use":
                tool_calls.append({
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "args": block.get("input", {}),
                })

        text = "".join(text_parts)
        reasoning = "".join(reasoning_parts) if reasoning_parts else None
        tcs = tool_calls if tool_calls else None

        # 更新缓存统计
        self._call_count += 1
        usage = data.get("usage", {})
        self._total_input_tokens += usage.get("input_tokens", 0)
        cached = usage.get("cache_read_input_tokens", 0)
        self._total_cached_tokens += cached
        if cached > 0:
            self._cache_hits += 1

        return text, tcs, reasoning, finish_reason

    def _call_anthropic(self, messages: List[Dict], thinking: bool = True
                        ) -> Tuple[str, Optional[List[Dict]], Optional[str], str]:
        """Anthropic Messages API 非流式调用。"""
        system, anthropic_msgs = self._convert_messages_to_anthropic(messages)
        body: Dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": anthropic_msgs,
        }
        if system:
            body["system"] = system
        if self.tools:
            body["tools"] = self._convert_tools_to_anthropic()
        if thinking:
            body["thinking"] = {"type": "enabled", "budget_tokens": min(self.max_tokens, 16000)}

        resp = self.client._client.post(
            f"{self.base_url()}/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": self.ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()
        return self._parse_anthropic_response(data)

    def _call_anthropic_stream(self, messages: List[Dict],
                               on_text: Callable[[str], None] = None,
                               on_answer: Callable[[str], None] = None,
                               on_tool: Callable[[str, dict], None] = None,
                               thinking: bool = True
                               ) -> Tuple[str, Optional[List[Dict]], str, str]:
        """Anthropic Messages API 流式调用。
        
        Anthropic SSE 事件流:
          message_start → content_block_start → content_block_delta(s) → content_block_stop → ... → message_delta → message_stop
        """
        system, anthropic_msgs = self._convert_messages_to_anthropic(messages)
        body: Dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": anthropic_msgs,
            "stream": True,
        }
        if system:
            body["system"] = system
        if self.tools:
            body["tools"] = self._convert_tools_to_anthropic()
        if thinking:
            body["thinking"] = {"type": "enabled", "budget_tokens": min(self.max_tokens, 16000)}

        resp = self.client._client.post(
            f"{self.base_url()}/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": self.ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json=body,
        )
        resp.raise_for_status()

        reasoning_parts, text_parts = [], []
        tool_buf: Dict[int, dict] = {}
        reasoning_done = False
        tool_seen = False
        finish_reason = ""
        current_block_type = None
        current_block_idx = -1
        anthropic_input_tokens = 0
        anthropic_cached_tokens = 0

        for line in resp.iter_lines():
            if not line:
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8")
            if not line.startswith("data: "):
                continue
            data_str = line[6:]
            try:
                evt = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type", "")

            if etype == "content_block_start":
                block = evt.get("content_block", {})
                current_block_type = block.get("type", "")
                current_block_idx = evt.get("index", 0)
                if current_block_type == "tool_use":
                    if not tool_seen and on_tool:
                        on_tool("", {})  # sentinel: close reasoning before tool labels
                        tool_seen = True
                    tool_buf[current_block_idx] = {
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "args_json": "",
                    }

            elif etype == "content_block_delta":
                delta = evt.get("delta", {})
                dtype = delta.get("type", "")

                if dtype == "thinking_delta":
                    chunk = delta.get("thinking", "")
                    if chunk:
                        reasoning_parts.append(chunk)
                        if on_text: on_text(chunk)

                elif dtype == "text_delta":
                    chunk = delta.get("text", "")
                    if chunk:
                        if on_answer and not reasoning_done:
                            on_answer("")  # signal: flush reasoning, switch to bright
                            reasoning_done = True
                        text_parts.append(chunk)
                        if on_answer: on_answer(chunk)

                elif dtype == "input_json_delta":
                    idx = current_block_idx
                    if idx in tool_buf:
                        tool_buf[idx]["args_json"] += delta.get("partial_json", "")

            elif etype == "content_block_stop":
                current_block_type = None

            elif etype == "message_start":
                # Anthropic message_start 包含 input_tokens 和 cache_read_input_tokens
                msg_obj = evt.get("message", {})
                usage = msg_obj.get("usage", {}) or evt.get("usage", {})
                anthropic_input_tokens = usage.get("input_tokens", 0)
                anthropic_cached_tokens = usage.get("cache_read_input_tokens", 0)

            elif etype == "message_delta":
                delta = evt.get("delta", {})
                if delta.get("stop_reason"):
                    finish_reason = delta["stop_reason"]
                # message_delta 可能包含更新后的 usage
                usage = evt.get("usage", {})
                if usage.get("input_tokens"):
                    anthropic_input_tokens = usage["input_tokens"]
                if usage.get("cache_read_input_tokens"):
                    anthropic_cached_tokens = usage["cache_read_input_tokens"]

            elif etype == "message_stop":
                break

        text = "".join(text_parts)
        reasoning = "".join(reasoning_parts)
        tcs = None
        if tool_buf:
            tcs = []
            for idx in sorted(tool_buf.keys()):
                tb = tool_buf[idx]
                try:
                    args = json.loads(tb["args_json"]) if tb["args_json"] else {}
                except json.JSONDecodeError:
                    args = {}
                tcs.append({"id": tb["id"], "name": tb["name"], "args": args})

        # 更新缓存统计：使用 Anthropic 流式返回的实际 token 数
        self._call_count += 1
        if anthropic_input_tokens > 0:
            self._total_input_tokens += anthropic_input_tokens
            self._total_cached_tokens += anthropic_cached_tokens
            if anthropic_cached_tokens > 0:
                self._cache_hits += 1
        else:
            # fallback：估算
            total_chars = sum(len(m.get("content", "") or "") for m in messages)
            self._total_input_tokens += int(total_chars * 0.4)

        return text, tcs, reasoning, finish_reason

    # ══════════════════════════════════════════════════════════════
    # 统一调用入口 — 根据 provider 分发
    # ══════════════════════════════════════════════════════════════

    def call(self, messages: List[Dict], thinking: bool = True
             ) -> Tuple[str, Optional[List[Dict]], Optional[str], str]:
        """非流式调用。返回 (text, tool_calls, reasoning, finish_reason)。
        
        thinking=False 时关闭推理模式，用于空响应恢复——确保 LLM 将全部
        max_tokens 预算用于 content/tool_calls 而非 reasoning。
        """
        if self.is_anthropic():
            return self._call_anthropic(messages, thinking)

        kwargs: Dict = {
            "model": self.model, "messages": messages,
            "tools": self.tools, "max_tokens": self.max_tokens,
        }
        kwargs.update(self._thinking_kwargs(thinking))
        resp = self.client.chat.completions.create(**kwargs)
        self._track_usage(resp)
        choice = resp.choices[0]
        msg = choice.message
        text = msg.content or ""
        reasoning = getattr(msg, 'reasoning_content', None) or None
        finish_reason = choice.finish_reason or ""
        tcs = None
        if msg.tool_calls:
            tcs = [{"id": tc.id, "name": tc.function.name,
                    "args": json.loads(tc.function.arguments) if tc.function.arguments else {}}
                   for tc in msg.tool_calls]
        return text, tcs, reasoning, finish_reason

    def call_stream(self, messages: List[Dict],
                    on_text: Callable[[str], None] = None,
                    on_answer: Callable[[str], None] = None,
                    on_tool: Callable[[str, dict], None] = None,
                    thinking: bool = True
                    ) -> Tuple[str, Optional[List[Dict]], str, str]:
        """流式调用：返回 (text, tool_calls, reasoning_text, finish_reason)。
        
        thinking=False 时关闭推理模式，用于空响应恢复。
        """
        if self.is_anthropic():
            return self._call_anthropic_stream(messages, on_text, on_answer, on_tool, thinking)

        kwargs: Dict = {
            "model": self.model, "messages": messages,
            "tools": self.tools, "max_tokens": self.max_tokens,
            "stream": True,
        }
        kwargs.update(self._thinking_kwargs(thinking))
        resp = self.client.chat.completions.create(**kwargs)
        reasoning_parts, text_parts = [], []
        tool_buf: Dict[int, dict] = {}
        reasoning_done = False
        tool_seen = False
        finish_reason = ""
        stream_usage = None
        for chunk in resp:
            # 提取 usage 信息（通常在最后一个 chunk）
            if hasattr(chunk, 'usage') and chunk.usage:
                stream_usage = chunk.usage
            choice = chunk.choices[0] if chunk.choices else None
            if choice and choice.finish_reason:
                finish_reason = choice.finish_reason
            delta = choice.delta if choice else None
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
        # 更新缓存统计：优先使用实际 usage，否则估算
        self._call_count += 1
        if stream_usage:
            self._total_input_tokens += getattr(stream_usage, 'prompt_tokens', 0) or 0
            cached_details = getattr(stream_usage, 'prompt_tokens_details', None)
            if cached_details:
                ct = getattr(cached_details, 'cached_tokens', 0) or 0
                self._total_cached_tokens += ct
                if ct > 0:
                    self._cache_hits += 1
        else:
            total_chars = sum(len(m.get("content", "") or "") for m in messages)
            self._total_input_tokens += int(total_chars * 0.4)
        return text, tcs, reasoning, finish_reason
