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
    """获取或启动 Chrome/Edge 调试 WebSocket URL。
    如果没有检测到运行中的调试端口，自动启动 MS Edge。
    使用独立的 --user-data-dir 避免与已运行浏览器实例冲突。"""
    global _browser_ws_url
    if _browser_ws_url:
        return _browser_ws_url
    import subprocess, urllib.request, time as _time, tempfile
    # 尝试连接已有调试端口
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2)
        data = json.loads(resp.read().decode())
        _browser_ws_url = data.get("webSocketDebuggerUrl", "")
        if _browser_ws_url:
            return _browser_ws_url
    except Exception:
        pass
    # 自动启动浏览器
    try:
        import shutil as _sh
        # 使用独立的 user-data-dir 避免与已运行浏览器实例冲突
        # 否则 --remote-debugging-port 不会生效（新窗口会附加到已有进程）
        user_data_dir = os.path.join(tempfile.gettempdir(), "cortex-browser-profile")
        os.makedirs(user_data_dir, exist_ok=True)

        # Windows: 优先 msedge，其次 chrome
        browser_cmd = None
        for name in ["msedge", "chrome"]:
            path = _sh.which(name)
            if path:
                browser_cmd = [path, "--remote-debugging-port=9222",
                               f"--user-data-dir={user_data_dir}",
                               "--no-first-run", "--no-default-browser-check",
                               "--disable-extensions", "--disable-popup-blocking"]
                break
        if not browser_cmd:
            # 尝试常见安装路径
            import glob as _glob
            edge_paths = [
                os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(os.environ.get("PROGRAMFILES", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
            ]
            for p in edge_paths:
                if os.path.isfile(p):
                    browser_cmd = [p, "--remote-debugging-port=9222",
                                   f"--user-data-dir={user_data_dir}",
                                   "--no-first-run", "--no-default-browser-check",
                                   "--disable-extensions", "--disable-popup-blocking"]
                    break
        if browser_cmd:
            _sp = __import__('subprocess')
            _sp.Popen(browser_cmd, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
                      creationflags=0x00000008 if os.name == 'nt' else 0)  # DETACHED_PROCESS
            # 等待浏览器启动
            for _ in range(30):  # 最多等 15 秒
                _time.sleep(0.5)
                try:
                    resp = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2)
                    data = json.loads(resp.read().decode())
                    _browser_ws_url = data.get("webSocketDebuggerUrl", "")
                    if _browser_ws_url:
                        return _browser_ws_url
                except Exception:
                    continue
    except Exception:
        pass
    return ""


@registry.register(
    "在浏览器中导航到指定 URL。会自动启动浏览器（MS Edge/Chrome）并打开调试端口。\n"
    "用法: browser_navigate(url=\"https://example.com\")",
    risk=RiskLevel.WRITE, capability=Capability.BROWSER)
def browser_navigate(work_dir: str, url: str) -> str:
    ws = _get_browser_ws()
    if not ws:
        return "(x) 浏览器自动启动失败。请手动启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile"
    import http.client, time as _time
    try:
        conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=10)
        # 1. 获取已有页面列表
        conn.request("GET", "/json")
        resp = conn.getresponse()
        pages = json.loads(resp.read().decode())
        conn.close()

        target_page = None
        if isinstance(pages, list) and pages:
            # 找到第一个 type=page 的标签页
            for p in pages:
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    target_page = p
                    break

        # 2. 如果没有可用页面，创建新标签页（不带 URL 参数，避免不同浏览器版本的兼容性问题）
        if not target_page:
            try:
                conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=10)
                conn.request("PUT", "/json/new")
                resp = conn.getresponse()
                new_page = json.loads(resp.read().decode())
                conn.close()
                if new_page and new_page.get("webSocketDebuggerUrl"):
                    target_page = new_page
                    # 等待页面初始化
                    _time.sleep(0.5)
            except Exception:
                pass  # some browsers don't support PUT /json/new

        if not target_page or not target_page.get("webSocketDebuggerUrl"):
            return "(x) 无法获取浏览器页面 WebSocket。请确认浏览器已启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile"

        # 3. 通过 CDP WebSocket 发送 Page.navigate 命令（可靠导航，兼容所有浏览器版本）
        cdp_cmd = json.dumps({
            "id": 1,
            "method": "Page.navigate",
            "params": {"url": url},
        })
        result_raw = _cdp_ws_send(target_page["webSocketDebuggerUrl"], cdp_cmd, timeout=10.0)

        if not result_raw:
            return f"(x) CDP 导航无响应。URL: {url}"

        result = json.loads(result_raw)
        nav_result = result.get("result", {})

        if nav_result.get("errorText"):
            return f"(x) 导航失败: {nav_result['errorText']}\nURL: {url}"

        # 等待页面加载
        _time.sleep(1.0)

        # 4. 获取导航后的页面信息
        title = "?"
        try:
            conn = http.client.HTTPConnection("127.0.0.1", 9222, timeout=5)
            conn.request("GET", "/json")
            resp = conn.getresponse()
            updated_pages = json.loads(resp.read().decode())
            conn.close()
            if isinstance(updated_pages, list):
                for p in updated_pages:
                    if p.get("webSocketDebuggerUrl") == target_page["webSocketDebuggerUrl"]:
                        title = p.get("title", "?")
                        break
        except Exception:
            pass

        return f"已在浏览器中导航到: {url}\n页面标题: {title}"
    except Exception as e:
        return f"(x) 浏览器错误: {e}\n请确认浏览器已启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile"


@registry.register(
    "获取当前浏览器页面的文本快照（accessibility tree）。\n"
    "用法: browser_snapshot()",
    risk=RiskLevel.SAFE, capability=Capability.BROWSER)
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
    risk=RiskLevel.WRITE, capability=Capability.BROWSER)
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
        return "(x) 浏览器未连接或无打开的页面。\n请先启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile"
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
            with open(d, "wb") as f:
                f.write(base64.b64decode(img_b64))
            return f"浏览器截图已保存: {path} ({os.path.getsize(d):,} bytes)"
        return f"(x) CDP 截图失败: {result_raw[:200]}"
    except _j.JSONDecodeError:
        return f"(x) CDP 响应解析失败: {result_raw[:200]}"


# ══════════════════════════════════════════════════════════════
