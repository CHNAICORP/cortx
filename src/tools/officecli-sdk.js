'use strict';
/*
 * officecli — a thin Node.js shell over officecli's resident pipe.
 *
 * Node port of sdk/python/officecli.py. Same one job: forward a command to the
 * running resident over its named pipe and hand back the response. There is NO
 * second vocabulary: a command is the same object you'd put in an officecli
 * `batch` list — e.g. {command:"set", path:"/Sheet1/A1", props:{text:"Hello"}}.
 * `send` forwards one; `batch` forwards many in a single round-trip.
 *
 * Two surfaces, by design:
 *   - bootstrap (infrequent): create() / open() spawn ONE CLI process — a file
 *     that isn't open yet has no resident to talk to.
 *   - everything else (the hot path): send() / batch() are pure pipe
 *     round-trips, no per-command process spawn.
 *
 *     const oc = require('@officecli/sdk');
 *     const doc = await oc.create('report.xlsx', ['--force']);
 *     try {
 *       await doc.send({ command: 'set', path: '/Sheet1/A1', props: { text: 'Hello' } });
 *       console.log(await doc.send({ command: 'get', path: '/Sheet1/A1' }));
 *     } finally {
 *       await doc.close();
 *     }
 *     // or `await using doc = await oc.open('existing.xlsx')` on Node >= 24.
 *
 * Protocol (matches ResidentServer.cs / ResidentClient.cs):
 *   - pipe name : officecli-<SHA256(fullpath)[:16] uppercase>;
 *                 fullpath upper-cased on macOS/Windows, left as-is on Linux.
 *   - unix path : $TMPDIR/CoreFxPipe_<name>  (+ "-ping");  $TMPDIR else /tmp
 *   - win path  : \\.\pipe\<name>            (+ "-ping")
 *   - framing   : one request line + one response line, UTF-8, '\n' terminated;
 *                 one connection == one command. The reply may carry a UTF-8 BOM
 *                 (unix StreamWriter) and a trailing '\r' — both stripped here.
 *   - request   : PascalCase {"Command","Args","Props","Json"}
 *   - response  : {"ExitCode","Stdout","Stderr"}
 */

const os = require('os');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Mirror officecli's TryResident busy-delivery policy (CommandBuilder.cs): a
// generous connect timeout + a few retries with backoff, applied identically to
// every command. The reply read itself blocks (no timeout) — like officecli's
// PipeReadLine — trusting the resident to answer once our turn comes up in its
// serialized queue. Retries only re-attempt the CONNECT (before the command
// executes), so re-sending is safe even for mutations: there is no "read timed
// out, resend" path that could double-apply.
const BUSY_CONNECT_TIMEOUT_MS = 30000; // = ResidentBusyConnectTimeoutMs
const BUSY_MAX_RETRIES = 3;            // = ResidentBusyMaxRetries
// = CommandBuilder's DefaultOpenIdleSeconds. open() upgrades a reused resident
// (which create() may have auto-started with a short 60s timeout) to the 12min
// interactive window, so a long session over an SDK handle isn't cut short.
const OPEN_IDLE_SECONDS = 12 * 60;

// Installer scripts: the d.officecli.ai mirror is primary; GitHub raw is only a
// fallback (same order as install.sh / install-binary.js). The mirror is
// Cloudflare-fronted and reachable where raw.githubusercontent.com may be
// rate-limited or blocked.
const INSTALL_SH_MIRROR = 'https://d.officecli.ai/install.sh';
const INSTALL_SH_GITHUB = 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh';
const INSTALL_PS1_MIRROR = 'https://d.officecli.ai/install.ps1';
const INSTALL_PS1_GITHUB = 'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.ps1';
const MISSING_CLI =
  "officecli CLI not found: {bin} is not on PATH nor in the default install " +
  'location (~/.local/bin, or %LOCALAPPDATA%\\OfficeCLI on Windows). This SDK only ' +
  'forwards commands to the officecli binary, which must be installed separately. Install it:\n' +
  '    node -e "require(\'@officecli/sdk\').install()"   # runs the official installer\n' +
  '    # or: curl -fsSL ' + INSTALL_SH_MIRROR + ' | bash\n' +
  '    # (npm i @officecli/sdk already pulls @officecli/officecli, which bundles the binary)\n' +
  'Already installed elsewhere? pass { binary: "/path/to/officecli" }.';

/**
 * Raised on transport/process failure (could not reach the resident). Business
 * outcomes are NOT exceptions — they live in the returned envelope's `success`
 * field, same as the CLI's exit code.
 */
class OfficeCliError extends Error {
  constructor(code, msg) {
    super(`[exit ${code}] ${msg}`);
    this.name = 'OfficeCliError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- pipe address
function dotnetTempDir() {
  // Mirror .NET Path.GetTempPath() on Unix exactly: $TMPDIR else /tmp.
  return process.env.TMPDIR || '/tmp';
}

// Match the path officecli's resident hashes into the pipe name. On Windows it
// derives the name from GetFullPath, which expands 8.3 short components (e.g.
// RUNNER~1, or any user name > 8 chars under %TEMP%) to their long form.
// path.resolve does NOT expand 8.3, so a short path would hash to a different
// pipe and every connect fails with ENOENT — hence realpath, which does expand
// it. realpath needs the file to exist; fall back to the resolved path when it
// doesn't (e.g. pre-create). realpath ALSO resolves symlinks/junctions, which
// GetFullPath does not; harmless here because we hand this resolved path to the
// resident, so the server's GetFullPath sees the already-resolved string and
// both sides hash the same thing. Windows only — on Linux/macOS officecli uses
// GetFullPath (no symlink resolution), so realpath would diverge there
// (e.g. /tmp → /private/tmp on macOS).
function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  if (IS_WIN) {
    try { return fs.realpathSync.native(resolved); } catch (_) { /* not there yet */ }
  }
  return resolved;
}

/** [main, ping] pipe addresses for a document path. Exposed for debugging. */
function pipePaths(filePath) {
  let full = canonicalPath(filePath);
  if (IS_MAC || IS_WIN) full = full.toUpperCase(); // Linux: case-sensitive, no upper
  const h = crypto.createHash('sha256').update(full, 'utf8').digest('hex').toUpperCase().slice(0, 16);
  const name = `officecli-${h}`;
  if (IS_WIN) return [`\\\\.\\pipe\\${name}`, `\\\\.\\pipe\\${name}-ping`];
  const base = path.join(dotnetTempDir(), `CoreFxPipe_${name}`);
  return [base, base + '-ping'];
}

// ---------------------------------------------------------------- transport
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// One attempt: bound the CONNECT, then block on the reply (no read timeout) —
// exactly like officecli's TrySend (Connect(timeout) + blocking PipeReadLine).
function sendOnce(sockPath, line, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const socket = net.createConnection(sockPath);
    const connTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(connTimer);
      socket.destroy();
      reject(err);
    };
    socket.once('connect', () => {
      clearTimeout(connTimer); // connected: stop bounding; reply read blocks
      socket.write(line);
    });
    socket.on('data', (d) => {
      chunks.push(d);
      // Line protocol: the reply is one '\n'-terminated line.
      if (d.length && d[d.length - 1] === 0x0a) {
        if (settled) return;
        settled = true;
        clearTimeout(connTimer);
        socket.end();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.once('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(connTimer);
      resolve(Buffer.concat(chunks));
    });
    socket.once('error', fail);
  });
}

function decodeLine(raw) {
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM (unix StreamWriter)
  if (text.charCodeAt(text.length - 1) === 0x0a) text = text.slice(0, -1); // drop the '\n' terminator
  if (text.charCodeAt(text.length - 1) === 0x0d) text = text.slice(0, -1); // and a trailing '\r'
  return text;
}

/**
 * Forward one request, mirroring officecli's TrySend: bounded connect + a few
 * retries with backoff, then a blocking read. A retry only re-attempts the
 * connect (before the command runs), so it never double-applies a mutation. If
 * the command still can't be delivered, raise a busy/unresponsive error — never
 * fall back to touching the file directly (that would race the resident).
 *
 * `maxRetries` overrides the busy-retry count. Liveness probes (serves) pass 0
 * so a missing/stale pipe fails FAST instead of sleeping through the backoff.
 */
async function rpc(sockPath, req, connectTimeoutMs = BUSY_CONNECT_TIMEOUT_MS, maxRetries = BUSY_MAX_RETRIES) {
  const line = Buffer.from(JSON.stringify(req) + '\n', 'utf8');
  let raw = null;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await sendOnce(sockPath, line, connectTimeoutMs);
      break;
    } catch (e) {
      // Connect/socket error only — the command never ran, so a retry is safe.
      if (attempt >= maxRetries) {
        throw new OfficeCliError(
          -1,
          'resident is running but the command could not be delivered ' +
            `(pipe busy or unresponsive); retry, or close and reopen [${e.message}]`
        );
      }
      await sleep(50 * (attempt + 1)); // = TrySend's 50*(n+1)ms backoff
    }
  }
  const text = decodeLine(raw);
  if (!text.trim()) {
    // Empty/closed reply: the resident accepted the connection but closed
    // without a complete response (e.g. crashed mid-serve). We refuse to
    // re-send — the command may already have been APPLIED before the resident
    // died, so re-sending would double-apply a non-idempotent op — and raise
    // instead. _cmd's recovery then restarts a dead resident and retries once.
    throw new OfficeCliError(
      -1,
      'resident closed the connection without a response ' +
        '(it may have crashed mid-command); retry, or close and reopen'
    );
  }
  return JSON.parse(text);
}

function parseEnvelope(resp) {
  // Return the useful payload: the parsed JSON envelope (object/array) if Stdout
  // is JSON, otherwise the raw Stdout text ("" when empty). Accept ONLY
  // object/array — a bare JSON scalar ("42", "true", "null", a quoted string)
  // stays text, or the caller can't tell literal text "42" from the number 42.
  const out = (resp && resp.Stdout) || '';
  let v;
  try {
    v = JSON.parse(out);
  } catch (_) {
    return out;
  }
  return v !== null && typeof v === 'object' ? v : out;
}

function strMap(o) {
  // Drop null/undefined values (omit), and stringify the rest — the resident's
  // Args/Props are Dictionary<string,string>. A value set to null means "don't
  // send it", not "send empty string"; pass "" for an explicit empty value.
  const r = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== null && v !== undefined) r[k] = String(v);
  }
  return r;
}

async function serves(pingPath, fullPath, timeoutMs = 1000) {
  // Is a resident alive on `pingPath` AND serving `fullPath`? Probes the
  // always-responsive `-ping` pipe (officecli's TryConnect): it answers even
  // while the MAIN pipe is busy. Single-shot (maxRetries=0): a probe should fail
  // fast, not sit through the busy-retry backoff.
  let resp;
  try {
    resp = await rpc(pingPath, { Command: '__ping__' }, timeoutMs, 0);
  } catch (e) {
    if (e instanceof OfficeCliError) return false;
    throw e;
  }
  const served = ((resp && resp.Stdout) || '').trim(); // ping echoes the served path
  if (!served) return false;
  const a = path.resolve(served);
  return a === fullPath || ((IS_MAC || IS_WIN) && a.toLowerCase() === fullPath.toLowerCase());
}

// ---------------------------------------------------------------- binary resolution
function installDirCandidate(name) {
  // Where install.sh / install.ps1 drop the binary: ~/.local/bin on macOS/Linux,
  // %LOCALAPPDATA%\OfficeCLI on Windows. PATH-miss fallback only.
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA;
    if (!base) return null;
    const exe = name.toLowerCase().endsWith('.exe') ? name : name + '.exe';
    return path.join(base, 'OfficeCLI', exe);
  }
  return path.join(os.homedir(), '.local', 'bin', name);
}

function whichOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const cands = IS_WIN ? [name, name + '.exe', name + '.cmd'] : [name];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const c of cands) {
      const p = path.join(dir, c);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_) {
        /* keep looking */
      }
    }
  }
  return null;
}

function bundledBinary() {
  // If the @officecli/officecli installer package is installed (it is a
  // dependency), prefer its vendored, auto-updating binary. Returns the path if
  // it is present on disk, else null. require is wrapped so the SDK still works
  // as a pure thin client when the dependency was omitted.
  try {
    const cli = require('@officecli/officecli');
    const p = cli.binaryPath();
    return fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

function resolveBinary(binary) {
  // Order: explicit path (has a separator) is trusted as-is; then the bundled
  // installer-package binary; then PATH; then the official installer's known
  // location. Idempotent — an already-resolved absolute path passes through.
  if (binary.includes(path.sep) || binary.includes('/')) return binary;
  if (binary === 'officecli') {
    const bundled = bundledBinary();
    if (bundled) return bundled;
  }
  const found = whichOnPath(binary);
  if (found) return found;
  const cand = installDirCandidate(binary);
  if (cand) {
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch (_) {
      /* fall through */
    }
  }
  return binary; // give up; runCli raises the helpful error
}

async function ensureCliBinary(binary, autoInstall) {
  // Async binary resolution for the entry points (open/create), able to ACTIVELY
  // provision a missing CLI. Order: explicit path is trusted as-is; then the
  // bundled installer package (download its binary if not yet present — this is
  // the package's own signed download, not a surprise); then PATH; then the
  // installer's known location; finally, if autoInstall, run the official
  // install.sh. Returns the resolved path (or the bare name, so runCli raises
  // the helpful MISSING_CLI error if everything failed).
  if (binary.includes(path.sep) || binary.includes('/')) return binary; // explicit: trust caller

  // Accept the first candidate that actually RUNS (`--version` exit 0), in
  // priority order: the bundled (auto-updating) binary, then PATH, then the
  // installer's known location. Probing — not mere file existence — means a
  // present-but-broken binary is skipped, and a working officecli is never
  // shadowed by a needless install.
  const candidates = [];
  if (binary === 'officecli') {
    try {
      const p = require('@officecli/officecli').binaryPath();
      if (fs.existsSync(p)) candidates.push(p);
    } catch (_) { /* dependency absent */ }
  }
  const onPath = whichOnPath(binary);
  if (onPath) candidates.push(onPath);
  const cand = installDirCandidate(binary);
  if (cand) candidates.push(cand);

  for (const c of candidates) {
    if (probeVersion(c)) return c;
  }

  // Nothing usable found anywhere — provision it (only for the default name).
  if (autoInstall && binary === 'officecli') {
    process.stderr.write('[officecli] CLI not found — installing from d.officecli.ai …\n');
    try {
      const cli = require('@officecli/officecli');
      await cli.ensureBinary(); // bundled package's own signed download
      const p = cli.binaryPath();
      if (probeVersion(p)) return p;
    } catch (_) { /* fall through to the official installer */ }
    install(); // install.sh (unix) / install.ps1 (Windows)
    const after = installDirCandidate('officecli');
    if (after && probeVersion(after)) return after;
  }
  return binary; // give up → runCli raises the helpful MISSING_CLI
}

// Quote one token for a cmd.exe command line: ALWAYS wrap in double quotes,
// doubling any embedded quote. Unconditional quoting (rather than "only when it
// looks dangerous") is deliberate — it removes any reliance on enumerating every
// cmd metacharacter. A double-quoted token cannot be re-tokenized by cmd.exe, so
// & | < > ^ ( ) " are inert, and a %VAR% expansion stays *inside* the quotes and
// thus can never inject a command separator (at worst the argument is mangled —
// there is no command-line escape for %, a documented cmd.exe limitation). This
// matters because the binary path / args may be untrusted when the SDK is driven
// by a server. cmd /s strips the outer wrapper, leaving these per-token quotes.
function quoteForCmd(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function spawnCli(binary, argv, extraOpts) {
  let cmd = binary;
  let args = argv;
  const opts = { encoding: 'utf8', ...extraOpts };
  if (IS_WIN && /\.(cmd|bat)$/i.test(binary)) {
    // Node refuses to spawn a .cmd/.bat directly without a shell since
    // CVE-2024-27980 (raises EINVAL). Run it through cmd.exe ourselves,
    // quoting each token so paths with spaces survive — shell:true would
    // join the args unquoted and break on the first space. Mirrors Node's
    // own shell idiom (cmd /d /s /c "<line>" + windowsVerbatimArguments)
    // but with the per-token quoting shell:true omits.
    const line = [binary, ...argv].map(quoteForCmd).join(' ');
    cmd = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `"${line}"`];
    opts.windowsVerbatimArguments = true;
  }
  return spawnSync(cmd, args, opts);
}

function runCli(binary, argv) {
  const r = spawnCli(binary, argv);
  if (r.error && r.error.code === 'ENOENT') {
    throw new OfficeCliError(127, MISSING_CLI.replace('{bin}', JSON.stringify(binary)));
  }
  if (r.error) throw new OfficeCliError(-1, r.error.message);
  return r;
}

// Probe a resolved binary by running `<binary> --version`: true iff it actually
// runs and exits 0. We accept only a WORKING officecli — a present-but-broken
// file (wrong arch, stale/again-renamed shim, corrupt download) must not be
// used, and conversely a working officecli on PATH must not be shadowed by a
// needless auto-install. Output is discarded.
function probeVersion(binPath) {
  const r = spawnCli(binPath, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  return !r.error && r.status === 0;
}

// ---------------------------------------------------------------- the shell
class Document {
  constructor(filePath, binary = 'officecli', timeoutMs = 30000) {
    // Canonical (Windows 8.3-expanded) so the pipe name AND the serves() path
    // comparison both match what the resident reports.
    this.path = canonicalPath(filePath);
    this.bin = resolveBinary(binary);
    this.timeout = timeoutMs; // connect timeout (ms); the reply read blocks
    const [main, ping] = pipePaths(this.path);
    this._main = main;
    this._ping = ping;
    this._restarting = null; // in-flight dead-resident restart (serializes callers)
  }

  async _start() {
    // Reuse a resident already serving this file (no spawn). serves() is a real
    // liveness probe (ping + path match), so a stale/dead socket falls through
    // to `officecli open`, which replaces it via TryConnect.
    if (await serves(this._ping, this.path)) return;
    const r = runCli(this.bin, ['open', this.path]);
    if (r.status !== 0) throw new OfficeCliError(r.status == null ? -1 : r.status, r.stderr || r.stdout);
  }

  async _cmd(command, args, props, asJson = true, timeoutMs) {
    const req = { Command: command, Json: asJson };
    if (args) req.Args = strMap(args);
    if (props !== null && props !== undefined) req.Props = strMap(props);
    const t = timeoutMs == null ? this.timeout : timeoutMs;
    try {
      return await rpc(this._main, req, t, BUSY_MAX_RETRIES);
    } catch (e) {
      if (!(e instanceof OfficeCliError)) throw e;
      // Delivery failed. Use the -ping pipe to tell DEAD from BUSY:
      //   • ALIVE but main pipe unresponsive → do NOT bypass it (a second writer
      //     racing the live resident loses data on its save). Re-raise.
      //   • DEAD (crashed / stale socket) → restart with one `officecli open`
      //     and retry ONCE. Safe across reads and mutations.
      if (await this.alive()) throw e;
      // Serialize the restart across concurrent callers sharing this Document so
      // only one spawns `officecli open` (else N-1 orphaned residents race saves).
      if (!this._restarting) {
        this._restarting = (async () => {
          if (!(await this.alive())) await this._start();
        })().finally(() => {
          this._restarting = null;
        });
      }
      await this._restarting;
      return await rpc(this._main, req, t, BUSY_MAX_RETRIES);
    }
  }

  /**
   * Forward ONE command in officecli's batch-item shape and return its parsed
   * result (the JSON envelope, or raw text for content commands). `item` is
   * exactly an object you'd put in a `batch` list:
   *   { command: 'set', path: '/Sheet1/A1', props: { text: 'hi' } }
   * `command` (or `op`) picks the command, `props` becomes the property map, and
   * every other key is forwarded verbatim as a command argument. asJson=false
   * requests plain-text output (view/raw/dump), mirroring the CLI's --json.
   */
  async send(item, asJson = true, timeoutMs) {
    const command = item.command || item.op;
    if (!command) throw new OfficeCliError(-1, "send(item): item needs a 'command' (or 'op') key");
    const args = {};
    for (const k of Object.keys(item)) {
      if (k !== 'command' && k !== 'op' && k !== 'props') args[k] = item[k];
    }
    return parseEnvelope(await this._cmd(command, args, item.props, asJson, timeoutMs));
  }

  /**
   * Forward officecli's `batch`: apply a LIST of the same item objects as send()
   * in ONE round-trip — the fast path for many writes.
   */
  async batch(items, { force = true, stopOnError = false, timeoutMs } = {}) {
    const args = { batchJson: JSON.stringify(items), force, stopOnError };
    return parseEnvelope(await this._cmd('batch', args, undefined, true, timeoutMs));
  }

  // Best-effort idle-timeout upgrade over the always-responsive ping pipe.
  // Mirrors ResidentClient.SendSetIdleTimeout: a failure is non-fatal — the
  // resident keeps its original idle schedule. Single-shot (maxRetries=0).
  async _setIdleTimeout(seconds) {
    try {
      await rpc(this._ping, { Command: '__set-idle-timeout__', Args: { seconds: String(seconds) } }, this.timeout, 0);
    } catch (e) {
      if (!(e instanceof OfficeCliError)) throw e;
    }
  }

  /** True iff a resident is alive AND serving this file (probes the -ping pipe). */
  async alive(timeoutMs = 1000) {
    return serves(this._ping, this.path, timeoutMs);
  }

  /**
   * = `officecli close`: stop the resident. It flushes the in-memory doc to disk
   * as it shuts down, so no separate save is needed. The resident acks AFTER
   * shutting down, so a missing/empty ack still means "closed"; a real shutdown
   * error is a non-empty response and surfaces through the return value.
   */
  async close() {
    try {
      return parseEnvelope(await rpc(this._ping, { Command: '__close__' }, this.timeout));
    } catch (e) {
      if (!(e instanceof OfficeCliError)) throw e;
      // Only swallow if the resident is actually gone. If it's still alive (ping
      // momentarily unreachable), the close did NOT take effect — re-raise, or
      // the caller wrongly believes the file is released.
      if (await this.alive()) throw e;
      return ''; // resident gone / ack lost — end state is "closed"
    }
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

/**
 * Create a blank Office document and return a live Document handle. Extra CLI
 * flags pass through verbatim:
 *   await create('report.xlsx', ['--force']);
 *   await create('doc', ['--type', 'docx']);
 * One CLI spawn (`officecli create`), which auto-starts a resident; the handle
 * binds to THAT resident (no second spawn). Inherits officecli's semantics —
 * file_locked (close it first) / file_exists (pass '--force').
 */
async function create(filePath, args = [], { binary = 'officecli', timeoutMs = 30000, autoInstall = true } = {}) {
  const full = path.resolve(filePath);
  const bin = await ensureCliBinary(binary, autoInstall);
  const r = runCli(bin, ['create', full, ...args]);
  if (r.status !== 0) throw new OfficeCliError(r.status == null ? -1 : r.status, r.stderr || r.stdout);
  const doc = new Document(full, bin, timeoutMs);
  await doc._start(); // create auto-started a resident; this finds it alive (no extra spawn)
  return doc;
}

/**
 * Open an EXISTING document and return a live Document handle. `officecli open`
 * is idempotent: reuse a resident already serving this file or start one.
 *
 *   Owner  — `const d = await open(f); try { ... } finally { await d.close(); }`
 *   Borrow — `const d = await open(f); await d.send(...)`  // leave it running
 *
 * Failure model (per send/batch): a DEAD resident is transparently restarted and
 * the command retried once; an ALIVE-but-busy pipe raises OfficeCliError (retry,
 * or close() and reopen).
 */
async function open(filePath, { binary = 'officecli', timeoutMs = 30000, autoInstall = true } = {}) {
  const bin = await ensureCliBinary(binary, autoInstall);
  const doc = new Document(filePath, bin, timeoutMs);
  await doc._start();
  // Mirror CLI `open`: when reusing a resident create() auto-started with a
  // short 60s timeout, upgrade it to the 12min interactive window. (If _start
  // spawned `officecli open` instead, that path already set 12min; re-sending
  // is idempotent.)
  await doc._setIdleTimeout(OPEN_IDLE_SECONDS);
  return doc;
}

/**
 * Install the officecli CLI binary via its OFFICIAL installer — explicit by
 * design (this SDK never auto-downloads behind your back). Runs install.ps1 via
 * PowerShell on Windows and install.sh via bash elsewhere. Note: when installed
 * via npm, @officecli/officecli already bundles an auto-updating binary, so this
 * is only needed for a standalone (~/.local/bin or %LOCALAPPDATA%\OfficeCLI)
 * install.
 */
function install() {
  if (IS_WIN) {
    process.stderr.write(`Installing officecli via ${INSTALL_PS1_MIRROR} (github fallback) ...\n`);
    // Fetch the script mirror-first, github fallback, then run it. The whole
    // try/catch is assigned so a mirror failure transparently falls back.
    const ps = `$s = try { irm '${INSTALL_PS1_MIRROR}' } catch { irm '${INSTALL_PS1_GITHUB}' }; $s | iex`;
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      throw new OfficeCliError(
        r.status == null ? -1 : r.status,
        `officecli install failed. Run manually:\n    irm ${INSTALL_PS1_MIRROR} | iex`
      );
    }
    return;
  }
  process.stderr.write(`Installing officecli via ${INSTALL_SH_MIRROR} (github fallback) ...\n`);
  // (curl mirror || curl github) | bash — the subshell emits whichever script
  // fetch succeeds; the group keeps the pipe bound to the whole fallback.
  const sh = `(curl -fsSL ${INSTALL_SH_MIRROR} 2>/dev/null || curl -fsSL ${INSTALL_SH_GITHUB}) | bash`;
  const r = spawnSync('bash', ['-c', sh], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new OfficeCliError(
      r.status == null ? -1 : r.status,
      `officecli install failed. Run manually:\n    curl -fsSL ${INSTALL_SH_MIRROR} | bash`
    );
  }
}

module.exports = { open, create, install, Document, OfficeCliError, pipePaths };
