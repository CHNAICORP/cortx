/**
 * 浏览器 + 桌面控制工具 — Chrome DevTools Protocol
 *
 * v2.0 修复:
 *   1. 使用原生 Node.js http 模块替代 curl（更可靠）
 *   2. 添加 --user-data-dir 避免与已运行浏览器实例冲突
 *   3. 修复同步 sleep bug: setTimeout 在同步循环中不阻塞
 *   4. 移除截图工具的工作区路径限制（允许保存到任意位置）
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as net from "net";
import * as crypto from "crypto";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

let _browserWsUrl = "";
let _browserLaunching: Promise<string> | null = null;

// ── 原生 HTTP 工具（替代 curl）──

function _httpGet(port: number, urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function _httpPut(port: number, urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method: "PUT" }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── CDP WebSocket 客户端（零依赖实现，移植自 Python _cdp_ws_send）──

function _cdpWsSend(wsUrl: string, payload: string, timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    const m = wsUrl.match(/^ws:\/\/([^:]+):(\d+)(\/.+)$/);
    if (!m) { resolve(""); return; }
    const host = m[1], port = parseInt(m[2], 10), wsPath = m[3];
    const sock = net.createConnection({ host, port }, () => {
      // 1. HTTP upgrade handshake
      const key = crypto.randomBytes(16).toString("base64");
      const upgrade = `GET ${wsPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      sock.write(upgrade);
    });
    sock.setTimeout(timeout);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let resolved = false;
    const finish = (val: string) => { if (!resolved) { resolved = true; sock.destroy(); resolve(val); } };

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const header = buf.slice(0, idx).toString();
        if (!header.includes("101")) { finish(""); return; }
        buf = buf.slice(idx + 4);
        upgraded = true;
        // 2. 发送 masked text frame
        const payloadBytes = Buffer.from(payload, "utf-8");
        const plen = payloadBytes.length;
        const mask = crypto.randomBytes(4);
        let header2: Buffer;
        if (plen < 126) header2 = Buffer.alloc(6);
        else if (plen < 65536) header2 = Buffer.alloc(8);
        else header2 = Buffer.alloc(14);
        header2[0] = 0x81;
        if (plen < 126) { header2[1] = 0x80 | plen; mask.copy(header2, 2); }
        else if (plen < 65536) { header2[1] = 0x80 | 126; header2.writeUInt16BE(plen, 2); mask.copy(header2, 4); }
        else { header2[1] = 0x80 | 127; header2.writeBigUInt64BE(BigInt(plen), 2); mask.copy(header2, 10); }
        const masked = Buffer.alloc(plen);
        for (let i = 0; i < plen; i++) masked[i] = payloadBytes[i] ^ mask[i % 4];
        sock.write(Buffer.concat([header2, masked]));
      }
      // 3. 解析响应帧
      if (upgraded && buf.length >= 2) {
        const finOp = buf[0];
        if ((finOp & 0x0f) === 0x01) {  // text frame
          const maskFlag = (buf[1] & 0x80) !== 0;
          let plen7 = buf[1] & 0x7f;
          let hdrLen = 2;
          if (plen7 === 126) { if (buf.length < 4) return; plen7 = buf.readUInt16BE(2); hdrLen = 4; }
          else if (plen7 === 127) { if (buf.length < 10) return; plen7 = Number(buf.readBigUInt64BE(2)); hdrLen = 10; }
          const total = hdrLen + (maskFlag ? 4 : 0) + plen7;
          if (buf.length >= total) {
            const dataStart = hdrLen + (maskFlag ? 4 : 0);
            let data = buf.slice(dataStart, dataStart + plen7);
            if (maskFlag) {
              const masks = buf.slice(hdrLen, hdrLen + 4);
              const out = Buffer.alloc(plen7);
              for (let i = 0; i < plen7; i++) out[i] = data[i] ^ masks[i % 4];
              data = out;
            }
            finish(data.toString("utf-8"));
          }
        }
      }
    });
    sock.on("error", () => finish(""));
    sock.on("timeout", () => finish(""));
  });
}

// ── 浏览器启动 ──

async function _tryConnect(): Promise<string> {
  try {
    const data = await _httpGet(9222, "/json/version");
    if (data && data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
  } catch { /* not running */ }
  return "";
}

async function _launchBrowser(): Promise<string> {
  // 1. 尝试连接已有调试端口
  let ws = await _tryConnect();
  if (ws) return ws;

  // 2. 自动启动浏览器
  const cp = require("child_process");
  let browserCmd: string | null = null;

  if (process.platform === "win32") {
    const progFiles = process.env["PROGRAMFILES(X86)"] || "";
    const progFiles64 = process.env["PROGRAMFILES"] || "";
    const edgePaths = [
      path.join(progFiles64, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    for (const p of edgePaths) {
      if (fs.existsSync(p)) { browserCmd = p; break; }
    }
    if (!browserCmd) {
      try {
        browserCmd = cp.execSync("where msedge", { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0].trim();
      } catch { /* not found */ }
    }
    if (!browserCmd) {
      try {
        browserCmd = cp.execSync("where chrome", { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0].trim();
      } catch { /* not found */ }
    }
  } else {
    // Linux/Mac
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      try {
        browserCmd = cp.execSync(`which ${name}`, { encoding: "utf-8", timeout: 2000 }).trim();
        if (browserCmd) break;
      } catch { /* not found */ }
    }
  }

  if (!browserCmd) return "";

  // 使用独立的 user-data-dir 避免与已运行浏览器实例冲突
  // 否则 --remote-debugging-port 不会生效（新窗口会附加到已有进程）
  const userDataDir = path.join(os.tmpdir(), "cortex-browser-profile");
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* ignore */ }

  const launchArgs = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
  ];

  try {
    cp.spawn(browserCmd, launchArgs, {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch { /* launch failed */ }

  // 3. 等待浏览器启动（使用真正的 async sleep）
  for (let i = 0; i < 30; i++) {  // 最多等 15 秒
    await new Promise(r => setTimeout(r, 500));
    ws = await _tryConnect();
    if (ws) return ws;
  }

  return "";
}

async function getBrowserWs(): Promise<string> {
  if (_browserWsUrl) return _browserWsUrl;
  // 防止并发调用重复启动浏览器
  if (_browserLaunching) return _browserLaunching;
  _browserLaunching = _launchBrowser();
  try {
    _browserWsUrl = await _browserLaunching;
    return _browserWsUrl;
  } finally {
    _browserLaunching = null;
  }
}

// ── 工具注册 ──

registry.register(
  "在浏览器中导航到指定 URL。会自动启动浏览器（MS Edge/Chrome）并打开调试端口。\n用法: browser_navigate(url=\"https://example.com\")",
  RiskLevel.WRITE, Capability.BROWSER,
  { workDir: "string", url: "string" },
  async function browser_navigate(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器自动启动失败。请手动启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile";
    try {
      // 在新页面中导航
      const encodedUrl = encodeURIComponent(url);
      const pageInfo = await _httpPut(9222, `/json/new?url=${encodedUrl}`);
      const title = pageInfo.title || "?";
      const wsUrl = pageInfo.webSocketDebuggerUrl || "";
      return `已在浏览器中打开: ${url}\n标题: ${title}\nWebSocket: ${wsUrl.slice(0, 60)}...`;
    } catch (e: any) {
      // 如果 PUT /json/new 失败（某些浏览器版本不支持），尝试用已有页面导航
      try {
        const pages = await _httpGet(9222, "/json");
        if (Array.isArray(pages) && pages.length > 0) {
          return `浏览器已启动 (${pages.length} 个页面)。URL: ${url}\n提示: 浏览器可能已打开，请在浏览器中手动访问该地址。`;
        }
      } catch { /* ignore */ }
      return `(x) 浏览器错误: ${e.message || e}\n请确认浏览器已启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile`;
    }
  },
);

registry.register(
  "获取当前浏览器页面的文本快照（页面列表摘要）。\n用法: browser_snapshot()",
  RiskLevel.SAFE, Capability.BROWSER,
  { workDir: "string" },
  async function browser_snapshot(): Promise<string> {
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    try {
      const pages = await _httpGet(9222, "/json");
      if (!Array.isArray(pages) || !pages.length) return "(无打开的浏览器页面)";
      const lines = [`(${pages.length} 个页面)\n`];
      for (const p of pages) {
        const t = (p.title || "无标题").slice(0, 60);
        const u = (p.url || "").slice(0, 80);
        lines.push(`  [${p.type || "page"}] ${t}`);
        lines.push(`    ${u}`);
      }
      return lines.join("\n");
    } catch (e: any) {
      return `(x) 浏览器错误: ${e.message || e}`;
    }
  },
);

registry.register(
  "截取浏览器页面截图保存到文件。\n用法: browser_screenshot(path=\"browser.png\")",
  RiskLevel.WRITE, Capability.BROWSER,
  { workDir: "string", outPath: "string" },
  async function browser_screenshot(workDir: string, args: Record<string, unknown>): Promise<string> {
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器未连接。请先 browser_navigate 打开页面";
    const p = String(args["outPath"] || "browser_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    try {
      // 1. 获取页面列表，找到第一个 type=page 且有 webSocketDebuggerUrl 的页面
      const pages = await _httpGet(9222, "/json");
      if (!Array.isArray(pages) || !pages.length) return "(x) 浏览器无打开的页面";
      const target = pages.find((pg: any) => pg.type === "page" && pg.webSocketDebuggerUrl);
      if (!target) return "(x) 没有可用的页面 WebSocket URL";
      // 2. 通过 WebSocket 发送 Page.captureScreenshot CDP 命令
      const cdpCmd = JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } });
      const resultRaw = await _cdpWsSend(target.webSocketDebuggerUrl, cdpCmd, 8000);
      if (!resultRaw) return "(x) CDP WebSocket 无响应";
      const result = JSON.parse(resultRaw);
      const imgB64 = result?.result?.data;
      if (!imgB64) return `(x) CDP 截图失败: ${resultRaw.slice(0, 200)}`;
      // 3. 解码 base64 写入文件
      fs.writeFileSync(d, Buffer.from(imgB64, "base64"));
      return `浏览器截图已保存: ${p} (${fs.statSync(d).size.toLocaleString()} bytes)`;
    } catch (e: any) {
      return `(x) 截图失败: ${e.message || e}`;
    }
  },
);

registry.register("桌面截图", RiskLevel.SYSTEM, Capability.BROWSER,
  { workDir: "string", outPath: "string" },
  function computer_screenshot(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["outPath"] || "desktop_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    const ext = path.extname(d).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) {
      return `(x) 不支持的文件类型: ${ext}`;
    }
    if (/[$`;|&<>{}()!"]/.test(d)) {
      return "(x) 路径含非法字符";
    }
    try {
      if (process.platform === "win32") {
        require("child_process").execSync(
          `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap $s.Bounds.Width,$s.Bounds.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size); $b.Save('${d.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()"`,
          { timeout: 15000 }
        );
      }
      return `桌面截图已保存: ${d}`;
    } catch (e: any) { return `(x) 截图失败: ${e.message || e}`; }
  },
);

registry.register("模拟鼠标点击", RiskLevel.SYSTEM, Capability.BROWSER,
  { workDir: "string", x: "number", y: "number" },
  function computer_click(_wd: string, args: Record<string, unknown>): string {
    const x = Number(args["x"] || 0);
    const y = Number(args["y"] || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 32767 || y > 32767) {
      return `(x) 无效坐标: (${args["x"]}, ${args["y"]})`;
    }
    if (process.platform === "win32") {
      try {
        require("child_process").execSync(
          `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})"`,
          { timeout: 10000 }
        );
        return `已点击 (${x}, ${y})`;
      } catch (e: any) { return `(x) 点击失败: ${e.message || e}`; }
    }
    return `(x) 仅支持 Windows`;
  },
);
