"""
Cortex Agent 浏览器自动化工具 — Chrome DevTools Protocol
═══════════════════════════════════════════════════════

browser_navigate / browser_snapshot / browser_screenshot
+ _get_browser_ws / _cdp_ws_send (零依赖 WebSocket CDP 客户端)
"""

import os, re, json, http.client, urllib.parse, base64, socket, struct, random as _random
from .cortex_agent import registry, RiskLevel, Capability

_browser_ws_url = None


# ══════════════════════════════════════════════════════════════
# Browser Automation (Chrome CDP 直连)
# ══════════════════════════════════════════════════════════════

_browser_ws_url = None

def _get_browser_ws() -> str:
    """获取或启动 Chrome 调试 WebSocket URL。"""
    global _browser_ws_url
    if _browser_ws_url:
        return _browser_ws_url
    import subprocess, urllib.request
    # 尝试连接已有调试端口
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2)
        data = json.loads(resp.read().decode())
        _browser_ws_url = data.get("webSocketDebuggerUrl", "")
        if _browser_ws_url:
            return _browser_ws_url
    except Exception:
        pass
    return ""


@registry.register(
    "在浏览器中导航到指定 URL。需要先启动浏览器调试端口:\n"
    "  start msedge --remote-debugging-port=9222\n"
    "用法: browser_navigate(url=\"https://example.com\")",
    risk=RiskLevel.WRITE, capability=Capability.NET_HTTP)
def browser_navigate(work_dir: str, url: str) -> str:
    ws = _get_browser_ws()
    if not ws:
        return "(x) 浏览器未连接。请在终端执行: start msedge --remote-debugging-port=9222"
    import http.client
    try:
        conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=10)
        # 获取可用的页面列表
        conn.request("GET", "/json")
        resp = conn.getresponse()
        pages = json.loads(resp.read().decode())
        conn.close()
        # 在新页面中导航
        body = json.dumps({"url": url})
        conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=10)
        conn.request("PUT", "/json/new?" + urllib.parse.urlencode({"url": url}))
        resp = conn.getresponse()
        page_info = json.loads(resp.read().decode())
        conn.close()
        # 通过 WebSocket 发送 Page.navigate (简化：通过 /json/new?url=)
        title = page_info.get("title", "?")
        ws_url = page_info.get("webSocketDebuggerUrl", "")
        return f"已在浏览器中打开: {url}\n标题: {title}\nWebSocket: {ws_url[:60]}..."
    except Exception as e:
        return f"(x) 浏览器错误: {e}\n请确认浏览器已启动: start msedge --remote-debugging-port=9222"


@registry.register(
    "获取当前浏览器页面的文本快照（accessibility tree）。\n"
    "用法: browser_snapshot()",
    risk=RiskLevel.SAFE, capability=Capability.NET_HTTP)
def browser_snapshot(work_dir: str) -> str:
    ws = _get_browser_ws()
    if not ws:
        return "(x) 浏览器未连接"
    import http.client
    try:
        # 获取页面列表
        conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=5)
        conn.request("GET", "/json")
        resp = conn.getresponse()
        pages = json.loads(resp.read().decode())
        conn.close()
        if not pages:
            return "(无打开的浏览器页面)"
        # 返回页面摘要
        lines = [f"({len(pages)} 个页面)\n"]
        for p in pages:
            t = p.get("title", "无标题")[:60]
            u = p.get("url", "")[:80]
            lines.append(f"  [{p.get('type','page')}] {t}")
            lines.append(f"    {u}")
        return "\n".join(lines)
    except Exception as e:
        return f"(x) 浏览器错误: {e}"



# ══════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════
# CDP WebSocket 客户端（修复 browser_screenshot）
# ══════════════════════════════════════════════════════════════

def _cdp_ws_send(ws_url: str, payload: str, timeout: float = 8.0) -> str:
    """通过 WebSocket 发送 CDP 命令并读取响应（零依赖实现）。
    
    WebSocket 帧格式 (RFC 6455):
      - Text frame: 0x81 | mask_byte | payload_len | mask_key(4) | masked_payload
    """
    import socket, struct, random, re
    m = re.match(r'ws://([^:]+):(\d+)(/.+)$', ws_url)
    if not m:
        return ""
    host, port_str, path = m.group(1), m.group(2), m.group(3)
    port = int(port_str)
    # 1. TCP connect + HTTP upgrade handshake
    key_bytes = bytes(random.randint(0, 255) for _ in range(16))
    import base64
    key_b64 = base64.b64encode(key_bytes).decode()
    upgrade_req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key_b64}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        sock.sendall(upgrade_req.encode())
        # Read HTTP response
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                sock.close()
                return ""
            resp += chunk
        if b"101" not in resp.split(b"\r\n")[0]:
            sock.close()
            return ""
        # 2. Send masked text frame
        payload_bytes = payload.encode("utf-8")
        plen = len(payload_bytes)
        mask = bytes(random.randint(0, 255) for _ in range(4))
        if plen < 126:
            header = struct.pack("!BB", 0x81, 0x80 | plen) + mask
        elif plen < 65536:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, plen) + mask
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, plen) + mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload_bytes))
        sock.sendall(header + masked)
        # 3. Read response frame
        response_parts = []
        while True:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response_parts.append(chunk)
                # Try to parse frame — if we have enough data, stop
                if len(response_parts) >= 1:
                    raw = b"".join(response_parts)
                    if len(raw) >= 2:
                        fin_op = raw[0]
                        if fin_op == 0x81:  # text frame
                            mask_flag = raw[1] & 0x80
                            plen7 = raw[1] & 0x7F
                            hdr_len = 2
                            if plen7 == 126:
                                if len(raw) >= 4:
                                    plen7 = struct.unpack("!H", raw[2:4])[0]
                                    hdr_len = 4
                                else:
                                    continue
                            elif plen7 == 127:
                                if len(raw) >= 10:
                                    plen7 = struct.unpack("!Q", raw[2:10])[0]
                                    hdr_len = 10
                                else:
                                    continue
                            total_len = hdr_len + (4 if mask_flag else 0) + plen7
                            if len(raw) >= total_len:
                                data_start = hdr_len + (4 if mask_flag else 0)
                                data = raw[data_start:total_len]
                                # If masked, unmask
                                if mask_flag:
                                    masks = raw[hdr_len:hdr_len+4]
                                    data = bytes(b ^ masks[i%4] for i, b in enumerate(data))
                                sock.close()
                                return data.decode("utf-8", errors="replace")
            except socket.timeout:
                break
        sock.close()
        raw_all = b"".join(response_parts).decode("utf-8", errors="replace")
        return raw_all[:5000]
    except Exception:
        try: sock.close()
        except: pass
        return ""


# ── 修复 browser_screenshot 使用 WebSocket ──

@registry.register(
    "截取浏览器页面截图保存到文件。\n"
    "用法: browser_screenshot(path=\"browser.png\")",
    risk=RiskLevel.WRITE, capability=Capability.NET_HTTP)
def browser_screenshot(work_dir: str, path: str = "browser_screenshot.png") -> str:
    import json as _j, http.client, base64
    # 1. Get WebSocket URL for a page
    try:
        conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=5)
        conn.request("GET", "/json")
        resp = conn.getresponse()
        pages = _j.loads(resp.read().decode())
        conn.close()
    except Exception as e:
        return f"(x) 无法连接浏览器调试端口 9222: {e}"
    if not pages:
        return "(x) 浏览器未连接或无打开的页面。\n请先启动: start msedge --remote-debugging-port=9222"
    # 使用第一个 page 类型的页面
    target = None
    for p in pages:
        if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
            target = p
            break
    if not target:
        return "(x) 没有可用的页面 WebSocket URL"
    ws_url = target["webSocketDebuggerUrl"]
    # 2. Send Page.captureScreenshot via WebSocket
    cdp_cmd = _j.dumps({"id": 1, "method": "Page.captureScreenshot",
                         "params": {"format": "png"}})
    result_raw = _cdp_ws_send(ws_url, cdp_cmd, timeout=8.0)
    if not result_raw:
        return "(x) CDP WebSocket 无响应"
    try:
        result = _j.loads(result_raw)
        img_b64 = result.get("result", {}).get("data", "")
        if img_b64:
            d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
            work_real = os.path.realpath(work_dir)
            if not d.startswith(work_real + os.sep) and d != work_real:
                return f"(x) 路径越权: {path} (必须在工作目录内)"
            with open(d, "wb") as f:
                f.write(base64.b64decode(img_b64))
            return f"浏览器截图已保存: {path} ({os.path.getsize(d):,} bytes)"
        return f"(x) CDP 截图失败: {result_raw[:200]}"
    except _j.JSONDecodeError:
        return f"(x) CDP 响应解析失败: {result_raw[:200]}"


# ══════════════════════════════════════════════════════════════
