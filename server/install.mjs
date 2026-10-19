// 独立二进制安装核心：codex（GitHub Releases）与 claude（GCS manifest）。
// 原则：版本号/校验值只由 hub 本机解析；远程优先直连下载，不可达时 hub 下载后经 SSH 中转；
// 落盘布局与官方安装器同构（releases/<ver>-<target> + current 链接 + installDir 入口），
// 保证官方 updater / desktop app 可无缝接管；安装后默认接管并禁用官方自动更新。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { runLocalPwsh, runRemoteBash, runRemoteCmd } from "./exec.mjs";
import { loadState, saveState } from "./store.mjs";
import { updateTool, bashPrelude } from "./tools.mjs";
import { curlText } from "./versions.mjs";
import { probeHost } from "./probe.mjs";

const GCS_BASE =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const GH_DL = "https://github.com/openai/codex/releases/download";
const DL_DIR = path.join(os.tmpdir(), "agentclihub-dl");

/** ssh 命令行中的路径表达式：~ 前缀用 $HOME 展开，其余单引号字面量 */
function remoteCmdPath(p) {
  const t = (p ?? "").trim();
  if (t === "~") return '"$HOME"';
  if (t.startsWith("~/")) {
    const rest = t.slice(2).replace(/["$`\\]/g, (m) => "\\" + m);
    return '"$HOME/' + rest + '"';
  }
  return sq(t);
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 远程路径表达式：~ 前缀交给 $HOME，其余按字面量（与 tools.mjs 同款语义） */
export function remotePathExpr(p) {
  const t = (p ?? "").trim();
  if (t === "~") return '"$HOME"';
  if (t.startsWith("~/")) return `"$HOME/${t.slice(2).replace(/["$`\\]/g, "\\$&")}"`;
  return sq(t);
}

export function expandHomeLocal(p) {
  const t = (p ?? "").trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(os.homedir(), t.slice(2));
  return t;
}

// ---------- 配置与版本解析 ----------

/** 工具配置：全局默认 + 主机覆盖 */
export function resolveToolConfig(config, host, tool) {
  const base = config.tools?.[tool] ?? {};
  const hostLevel = config.hostOverrides?.[host.id]?.installDir;
  const over = config.hostOverrides?.[host.id]?.tools?.[tool] ?? {};
  const merged = { method: "standalone", channel: tool === "claude" ? "stable" : "latest", ...base, ...(hostLevel ? { installDir: hostLevel } : {}), ...over };
  if (!merged.installDir) merged.installDir = "~/.local/bin";
  return merged;
}

const VERSION_RE = /^\d+\.\d+\.\d+(-(alpha|beta)[\d.]*)?$/;

/** 版本规格是否合法：渠道关键字或具体版本号（版本号会进入路径与脚本，必须严格校验） */
export function isValidVersionSpec(tool, spec) {
  if (spec === undefined || spec === null || spec === "") return true;
  if (typeof spec !== "string") return false;
  const keywords = tool === "codex" ? ["latest", "stable", "prerelease"] : ["latest", "stable"];
  return keywords.includes(spec) || VERSION_RE.test(spec);
}

/** 版本规格 → 具体版本号。latest/stable/prerelease 走缓存；其余按具体版本号 */
export function resolveVersionSpec(state, tool, spec) {
  if (!isValidVersionSpec(tool, spec)) throw new Error(`非法的版本规格: ${String(spec).slice(0, 40)}`);
  const v = state.toolVersions ?? {};
  const need = (x, what) => {
    if (!x) throw new Error(`版本缓存缺少 ${what}，请先在设置页「立即刷新」版本缓存`);
    return x;
  };
  if (tool === "codex") {
    if (!spec || spec === "latest" || spec === "stable") return need(v.codex?.latest, "codex latest");
    if (spec === "prerelease") return need(v.codex?.prerelease, "codex prerelease");
    return spec;
  }
  if (!spec || spec === "stable") return need(v.claude?.stable, "claude stable");
  if (spec === "latest") return need(v.claude?.latest, "claude latest");
  return spec;
}

// ---------- 下载与校验（hub 本机） ----------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

/** curl 下载到本地文件（走代理模板），输出节流进度 */
function curlDownload(url, dest, { proxy = "", onData = () => {}, timeoutSec = 900 } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = ["-fL", "--connect-timeout", "15", "--max-time", String(timeoutSec), "-o", dest, "--progress-bar"];
    if (proxy) args.push("--proxy", proxy);
    args.push(url);
    const child = spawn("curl", args, { windowsHide: true });
    let err = "";
    let lastEmit = 0;
    child.stderr.on("data", (c) => {
      err += c;
      const m = /(\d+(?:\.\d+)?)%(?!.*\d)/.exec(err.slice(-200));
      const now = Date.now();
      if (m && now - lastEmit > 3000) {
        lastEmit = now;
        onData(`下载中… ${m[1]}%\n`);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl 下载失败(${code}): ${err.trim().slice(-300)}`))));
  });
}

/** GitHub release 资产的 sha256：api.github.com 优先，expanded_assets HTML 兜底 */
async function githubAssetDigest(version, assetName, { proxy = "", token = "" } = {}) {
  try {
    const headers = ["Accept: application/vnd.github+json"];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    const body = await curlText(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`, {
      proxy, headers, timeoutSec: 30
    });
    const assets = JSON.parse(body).assets ?? [];
    const a = assets.find((x) => x.name === assetName);
    const m = /^sha256:([0-9a-f]{64})$/i.exec(a?.digest ?? "");
    if (m) return m[1].toLowerCase();
    throw new Error(`release 中未找到资产 ${assetName}`);
  } catch (e) {
    // 兜底：expanded_assets HTML 片段（asset 名后的首个 sha256: 文本）
    const html = await curlText(`https://github.com/openai/codex/releases/expanded_assets/rust-v${version}`, {
      proxy, timeoutSec: 30
    });
    const re = new RegExp(assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]{0,3000}?sha256:([0-9a-f]{64})", "i");
    const m = re.exec(html);
    if (m) return m[1].toLowerCase();
    throw new Error(`获取 ${assetName} 校验值失败（api 与页面均不可用）：${e.message}。可在设置页配置 GitHub Token 或代理`);
  }
}

// ---------- 平台与资产 ----------

function codexTarget(sysname, machine) {
  const s = sysname.toLowerCase();
  const m = machine.toLowerCase();
  if (s.includes("linux")) {
    if (m === "x86_64" || m === "amd64") return "x86_64-unknown-linux-musl";
    if (m === "aarch64" || m === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (s.includes("darwin")) {
    if (m === "arm64" || m === "aarch64") return "aarch64-apple-darwin";
    if (m === "x86_64") return "x86_64-apple-darwin";
  }
  if (s.includes("windows")) {
    if (m === "x64" || m === "x86_64" || m === "amd64") return "x86_64-pc-windows-msvc";
    if (m === "arm64" || m === "aarch64") return "aarch64-pc-windows-msvc";
  }
  throw new Error(`不支持的平台: ${sysname} ${machine}`);
}

function claudePlatform(sysname, machine, libc = "glibc") {
  const s = sysname.toLowerCase();
  const m = machine.toLowerCase();
  if (s.includes("linux")) {
    const arch = m === "aarch64" || m === "arm64" ? "arm64" : "x64";
    return `linux-${arch}${libc === "musl" ? "-musl" : ""}`;
  }
  if (s.includes("darwin")) return m === "arm64" || m === "aarch64" ? "darwin-arm64" : "darwin-x64";
  if (s.includes("windows")) return m === "arm64" || m === "aarch64" ? "win32-arm64" : "win32-x64";
  throw new Error(`不支持的平台: ${sysname} ${machine}`);
}

async function remoteUname(host) {
  const r = await runRemoteBash(
    host.id,
    'echo "$(uname -s) $(uname -m) $( (ldd --version 2>&1 || true) | grep -qi musl && echo musl || echo glibc)"',
    { timeoutMs: 30_000 }
  );
  const line = r.output.trim().split(/\r?\n/).pop() ?? "";
  const [sysname, machine, libc = "glibc"] = line.split(/\s+/);
  if (!sysname || !machine) throw new Error(`无法识别远程平台: ${line}`);
  if (/darwin/i.test(sysname)) {
    throw new Error("暂不支持 macOS 主机的独立二进制安装（安装脚本依赖 GNU 工具 mv -T / sha256sum / readlink -f），请将该主机安装方式改为 npm");
  }
  return { sysname, machine, libc };
}

/** 组装 codex 资产信息：官方 package 资产 + SHA256SUMS 校验链（与官方安装器一致） */
async function codexArtifact(host, version, config, onData) {
  const { sysname, machine } = host.kind === "local"
    ? { sysname: "windows", machine: process.arch }
    : await remoteUname(host);
  const target = codexTarget(sysname, machine);
  onData(`平台: ${sysname}/${machine} → ${target}\n`);
  const assetName = `codex-package-${target}.tar.gz`;
  const sumsName = "codex-package_SHA256SUMS";
  const mirror = (config.download?.githubMirror ?? "").replace(/\/+$/, "");
  const proxy = config.download?.proxy ?? "";
  const token = config.download?.githubToken ?? "";
  const dl = (name) => `${mirror}${GH_DL}/rust-v${version}/${name}`;

  // 校验值：SHA256SUMS 文件（含各资产 digest）；其自身 digest 经 release 元数据验证（可得时）
  let sha256 = "";
  try {
    const sums = await curlText(dl(sumsName), { proxy, timeoutSec: 30 });
    const line = sums.split(/\r?\n/).find((l) => l.includes(assetName));
    const m = /([0-9a-f]{64})/.exec(line ?? "");
    if (m) sha256 = m[1].toLowerCase();
    if (sha256) {
      try {
        const sumsDigest = await githubAssetDigest(version, sumsName, { proxy, token });
        const actual = crypto.createHash("sha256").update(sums, "utf8").digest("hex");
        if (actual !== sumsDigest) throw new Error("SHA256SUMS 自身校验失败");
      } catch (e) {
        onData(`[warn] SHA256SUMS 元数据校验不可用，按文件内容校验（${e.message}）\n`);
      }
    }
  } catch (e) {
    onData(`[warn] SHA256SUMS 获取失败（${e.message}），改用 release 元数据\n`);
  }
  if (!sha256) sha256 = await githubAssetDigest(version, assetName, { proxy, token });
  return { url: dl(assetName), sha256, target, kind: "tar.gz" };
}

/** 组装 claude 资产信息 { url, sha256, platformKey } */
async function claudeArtifact(host, version, config, onData) {
  const { sysname, machine, libc } = host.kind === "local"
    ? { sysname: "windows", machine: process.arch, libc: "" }
    : await remoteUname(host);
  const platformKey = claudePlatform(sysname, machine, libc);
  onData(`平台: ${sysname}/${machine}${libc ? `/${libc}` : ""} → ${platformKey}\n`);
  const manifest = JSON.parse(
    await curlText(`${GCS_BASE}/${version}/manifest.json`, { proxy: config.download?.proxy ?? "", timeoutSec: 30 })
  );
  const p = manifest.platforms?.[platformKey];
  if (!p) throw new Error(`manifest 中无平台 ${platformKey}`);
  return { url: `${GCS_BASE}/${version}/${platformKey}/${p.binary}`, sha256: p.checksum, platformKey, kind: "bin" };
}

// ---------- 远程文件读写（配置接管用） ----------

const REMOTE_READ_MARKERS = Object.freeze({
  sentinel: "__ACH_NOFILE_7f3d__",
  begin: "__ACH_BEGIN_7f3d__",
  end: "__ACH_END_7f3d__",
  fail: "__ACH_READFAIL_7f3d__"
});

/**
 * 解析远程读取结果。结构化内容只取 stdout：ssh 自身诊断走 stderr，不能与远端文件内容交错合并。
 * 保留 output 作为旧调用方/测试的兼容输入，错误摘要仍使用合并输出。
 */
export function parseRemoteReadResult(r) {
  const { sentinel, begin, end, fail } = REMOTE_READ_MARKERS;
  const protocolOutput = r.stdout ?? r.output;
  const why = (reason) => ({ state: "error", reason: `${reason}；原始输出前 160 字符: ${JSON.stringify(r.output.slice(0, 160))}` });
  if (r.code !== 0) return why(`ssh 退出码 ${r.code}`);
  if (protocolOutput.includes(fail)) return why("cat 读取失败（权限？）");
  if (protocolOutput.includes(sentinel)) return { state: "missing" };
  const crlfTransport = protocolOutput.includes(`${begin}\r\n`);
  const m = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n?${end}`).exec(protocolOutput);
  if (!m) return why("找不到内容标记"); // 宁可不写
  return { state: "ok", content: crlfTransport ? m[1].replace(/\r\n/g, "\n") : m[1] };
}

/**
 * 三态读取：ok(content) / missing(文件不存在，可新建) / error(读取失败或输出无法解析，不得写入；reason 说明原因)
 * 兼容 CRLF 传输：部分主机（如 Windows sshd 转发到 WSL）会把 \n 转成 \r\n，此时标记行以 \r\n 结尾，
 * 内容里每个 \n 也被加了 \r，需整体还原（原文件自带的 \r\n 传输后是 \r\r\n，还原一次即得到原样）。
 */
async function remoteReadText(host, pathExpr) {
  const { sentinel, begin, end, fail } = REMOTE_READ_MARKERS;
  // 用 begin/end 标记包裹内容；解析时只读 stdout，隔离 ssh 横幅/hostkeys 等 stderr 诊断。
  // cat 失败（如无权限）单独打失败标记，避免把报错文字当成文件内容。
  const r = await runRemoteCmd(
    host.id,
    `if [ -f ${pathExpr} ]; then printf '%s\\n' '${begin}'; if cat -- ${pathExpr}; then printf '\\n%s\\n' '${end}'; else printf '\\n%s\\n' '${fail}'; fi; else printf '%s' '${sentinel}'; fi`,
    { timeoutMs: 30_000 }
  );
  return parseRemoteReadResult(r);
}

/** 读取接管目标文件（本机/远程统一为三态） */
async function readConfigFile(host, localPath, remoteExpr) {
  if (host.kind !== "local") return remoteReadText(host, remoteExpr);
  try {
    return fs.existsSync(localPath) ? { state: "ok", content: fs.readFileSync(localPath, "utf8") } : { state: "missing" };
  } catch {
    return { state: "error" };
  }
}

/** 写入接管目标文件（本机先备份；远程由 remoteWriteText 原子写入并备份） */
async function writeConfigFile(host, localPath, remoteExpr, content, onData) {
  if (host.kind === "local") {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    if (fs.existsSync(localPath)) fs.copyFileSync(localPath, `${localPath}.agentclihub.bak`);
    fs.writeFileSync(localPath, content, "utf8");
  } else {
    await remoteWriteText(host, remoteExpr, content, onData);
  }
}

async function remoteWriteText(host, pathExpr, content, onData) {
  const script = [
    "set -e",
    `t=${pathExpr}`,
    `mkdir -p "$(dirname "$t")"`,
    `[ -f "$t" ] && cp -p "$t" "$t.agentclihub.bak" || true`,
    `tmp="$t.agentclihub-$$"`,
    `base64 -d > "$tmp"`,
    `mv -f "$tmp" "$t"`,
    `echo "已写入 $t（备份 $t.agentclihub.bak）"`
  ].join("\n");
  const r = await runRemoteCmd(host.id, script, { input: Buffer.from(content, "utf8").toString("base64"), onData, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`远程写入 ${pathExpr} 失败`);
}

/** 简单并发闸：最多 max 个同时执行，其余排队 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  };
  return {
    isFull: () => active >= max,
    run: (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    })
  };
}

// hub 侧大文件传输（下载 / 中转推送）并发上限：多台主机同时装时避免带宽与内存被打满
const hubTransfer = createLimiter(2);

/**
 * 确保 hub 本地已有校验通过的安装包。同一文件的并发请求共享一次下载（各主机常装同一架构的包），
 * 下载到 .part 临时文件，校验通过后再改名，避免半成品或多个 curl 写同一文件。
 */
const inflightDownloads = new Map();
async function ensureDownloaded(localFile, artifact, proxy, onData) {
  if (fs.existsSync(localFile) && (await sha256File(localFile)) === artifact.sha256) {
    onData("复用 hub 已有下载缓存\n");
    return;
  }
  let task = inflightDownloads.get(localFile);
  if (task) {
    onData("同一安装包正在由其他任务下载，等待复用…\n");
  } else {
    if (hubTransfer.isFull()) onData("[queue] hub 传输名额已满，排队等待…\n");
    task = hubTransfer
      .run(async () => {
        const part = `${localFile}.part`;
        onData(`hub 下载 ${artifact.url}\n`);
        await curlDownload(artifact.url, part, { proxy, onData });
        const digest = await sha256File(part);
        if (digest !== artifact.sha256) {
          fs.rmSync(part, { force: true });
          throw new Error(`下载校验失败: ${digest} != ${artifact.sha256}`);
        }
        fs.renameSync(part, localFile);
      })
      .finally(() => inflightDownloads.delete(localFile));
    inflightDownloads.set(localFile, task);
  }
  await task;
  onData("sha256 校验通过\n");
}

/**
 * 大文件经 SSH stdin 中转推送（远程不可直连下载源时的兜底）。
 * 原始二进制流式写入（`cat > file`），由 pipe 处理背压：内存占用恒定在一个 chunk 量级，
 * 不再做 base64 编码（省掉 33% 流量和 1.33 倍大小的临时文件）。完整性由远程安装脚本的 sha256 校验保证。
 */
function pushFileViaSsh(host, localFile, remotePath, onData) {
  onData("远程直连失败，改由 hub 中转推送…\n");
  return new Promise((resolve, reject) => {
    const size = fs.statSync(localFile).size;
    const target = remoteCmdPath(remotePath);
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", host.id, `mkdir -p "\$(dirname ${target})" && cat > ${target}`],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }
    );
    let err = "";
    child.stderr.on("data", (c) => (err = (err + c).slice(-300)));
    child.stdin.on("error", () => {}); // 远程提前退出的 EPIPE 由 close 退出码体现

    const rs = fs.createReadStream(localFile, { highWaterMark: 1024 * 1024 });
    let sent = 0;
    let lastEmit = 0;
    rs.on("data", (c) => {
      sent += c.length;
      const now = Date.now();
      if (now - lastEmit > 3000) {
        lastEmit = now;
        onData(`中转推送中… ${Math.round((sent / size) * 100)}%\n`);
      }
    });
    rs.on("error", (e) => {
      child.kill();
      reject(e);
    });
    rs.pipe(child.stdin);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ssh 推送失败(${code}): ${err.trim().slice(-200)}`))
    );
  });
}

// ---------- 自动更新接管（默认禁用官方自动更新） ----------

/** codex config.toml 行级编辑：顶层 check_for_update_on_startup + [features] daemon_auto_start */
export function editCodexConfigToml(text, au, warn = () => {}) {
  let lines = (text ?? "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") lines = [];
  const setTopKey = (key, value) => {
    const re = new RegExp(`^\\s*${key}\\s*=`);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break;
      if (re.test(lines[i])) {
        lines[i] = `${key} = ${value}`;
        return;
      }
    }
    lines.unshift(`${key} = ${value}`, "");
  };
  const setSectionKey = (section, key, value) => {
    const secRe = new RegExp(`^\\s*\\[${section}\\]\\s*$`);
    const si = lines.findIndex((l) => secRe.test(l));
    if (si < 0) {
      lines.push("", `[${section}]`, `${key} = ${value}`);
      return;
    }
    const keyRe = new RegExp(`^\\s*${key}\\s*=`);
    for (let i = si + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break;
      if (keyRe.test(lines[i])) {
        lines[i] = `${key} = ${value}`;
        return;
      }
    }
    lines.splice(si + 1, 0, `${key} = ${value}`);
  };
  if (typeof au.startupCheck === "boolean") setTopKey("check_for_update_on_startup", String(au.startupCheck));
  if (typeof au.daemonAutoStart === "boolean") {
    // features 用内联表（features = {...}）或点号键（features.x = ...）写法时，追加 [features] 段会生成非法 TOML
    if (lines.some((l) => /^\s*features\s*(=|\.)/.test(l))) {
      warn("config.toml 的 features 为内联表/点号键写法，已跳过 daemon_auto_start（请手工设置为 false）\n");
    } else {
      setSectionKey("features", "daemon_auto_start", String(au.daemonAutoStart));
    }
  }
  return lines.join("\n").replace(/^\n+/, "");
}

/** codex daemon settings.json：updater.autoUpdateEnabled / updateIntervalMinutes，保留其余键 */
export function editDaemonSettings(text, au) {
  let j = {};
  const t = (text ?? "").trim();
  if (t) {
    try { j = JSON.parse(t); } catch { throw new Error("app-server-daemon/settings.json 不是合法 JSON，已中止（未写入）"); }
  }
  j.updater = { ...(j.updater ?? {}) };
  if (typeof au.daemonAutoUpdate === "boolean") j.updater.autoUpdateEnabled = au.daemonAutoUpdate;
  if (au.daemonIntervalMinutes) j.updater.updateIntervalMinutes = au.daemonIntervalMinutes;
  return JSON.stringify(j, null, 2) + "\n";
}

/** claude settings.json：autoUpdatesChannel / env.DISABLE_AUTOUPDATER / minimumVersion，严格 JSON，保留未知键 */
export function editClaudeSettings(text, { disableAutoUpdater, channel, minimumVersion }) {
  let j = {};
  const t = (text ?? "").trim();
  if (t) {
    try { j = JSON.parse(t); } catch { throw new Error("settings.json 不是合法 JSON，已中止（未写入）"); }
  }
  if (channel === "stable" || channel === "latest") j.autoUpdatesChannel = channel;
  if (disableAutoUpdater === true) {
    j.env = { ...(j.env ?? {}), DISABLE_AUTOUPDATER: "1" };
  } else if (disableAutoUpdater === false && j.env) {
    delete j.env.DISABLE_AUTOUPDATER;
    if (Object.keys(j.env).length === 0) delete j.env;
  }
  if (minimumVersion) j.minimumVersion = minimumVersion; // 未固定版本时不动，保留用户手写值
  return JSON.stringify(j, null, 2) + "\n";
}

/**
 * 接管官方自动更新：把设置里的开关写入目标机的 codex / claude 配置（与安装方式无关，npm 版同样适用）。
 * 幂等：内容已匹配就不写；读取失败或无法安全改写则跳过并告警。
 * @returns {Promise<{changed: boolean, warned: boolean}>}
 */
async function takeoverAutoUpdate(host, tool, config, { pinnedVersion = "", channel = "" } = {}, onData = () => {}) {
  const au = config.autoUpdate?.[tool] ?? {};
  let changed = false;
  let warned = false;
  const warn = (msg) => {
    warned = true;
    onData(`[warn] ${msg}\n`);
  };
  /** 读-改-写一个配置文件；读取失败（error）一律跳过并告警，绝不按空文件覆盖 */
  const edit = async (label, localPath, remoteExpr, editFn) => {
    const cur = await readConfigFile(host, localPath, remoteExpr);
    if (cur.state === "error") {
      warn(`读取 ${label} 失败，已跳过接管（未写入，避免覆盖原有配置）：${cur.reason ?? "本机读取异常"}`);
      return false;
    }
    const old = cur.state === "ok" ? cur.content : "";
    let next;
    try {
      next = editFn(old);
    } catch (e) {
      warn(`${label} 无法安全改写，已跳过接管：${e.message}`);
      return false;
    }
    if (next === old) {
      onData(`${label} 已匹配设置，无需修改\n`);
      return false;
    }
    await writeConfigFile(host, localPath, remoteExpr, next, onData);
    changed = true;
    return true;
  };

  if (tool === "codex") {
    if (await edit(
      "config.toml",
      expandHomeLocal("~/.codex/config.toml"),
      remotePathExpr("~/.codex/config.toml"),
      (old) => editCodexConfigToml(old, au, (m) => onData(`[warn] ${m}`))
    )) onData(`已接管 config.toml：check_for_update_on_startup=${au.startupCheck}，daemon_auto_start=${au.daemonAutoStart}\n`);

    // daemon 设置：文件存在，或 daemon 目录已存在（settings.json 缺省即官方默认开启）时才改写；无 daemon 的主机不新建
    const localDs = expandHomeLocal("~/.codex/app-server-daemon/settings.json");
    const dsExpr = remotePathExpr("~/.codex/app-server-daemon/settings.json");
    const cur = await readConfigFile(host, localDs, dsExpr);
    if (cur.state === "error") {
      warn(`读取 daemon settings.json 失败，已跳过接管（未写入）：${cur.reason ?? "本机读取异常"}`);
    } else {
      let allow = cur.state === "ok";
      if (!allow) {
        if (host.kind === "local") allow = fs.existsSync(expandHomeLocal("~/.codex/app-server-daemon"));
        else {
          const r = await runRemoteBash(host.id, `[ -d ${remotePathExpr("~/.codex/app-server-daemon")} ] && echo yes || echo no`, { timeoutMs: 15_000 });
          allow = r.output.trim().endsWith("yes");
        }
      }
      if (!allow) {
        onData("该主机没有 codex daemon，无需配置 daemon updater\n");
      } else {
        const old = cur.state === "ok" ? cur.content : "";
        let next;
        try {
          next = editDaemonSettings(old, au);
        } catch (e) {
          warn(`daemon settings.json 无法安全改写，已跳过接管：${e.message}`);
          next = old;
        }
        if (next !== old) {
          await writeConfigFile(host, localDs, dsExpr, next, onData);
          changed = true;
          onData(`已接管 daemon updater：autoUpdateEnabled=${au.daemonAutoUpdate}\n`);
        } else if (!warned) {
          onData("daemon settings.json 已匹配设置，无需修改\n");
        }
      }
    }
  } else {
    const claudeAu = {
      disableAutoUpdater: au.disableAutoUpdater,
      channel,
      minimumVersion: pinnedVersion // 固定版本时写版本地板；否则不动
    };
    if (await edit(
      "claude settings.json",
      expandHomeLocal("~/.claude/settings.json"),
      remotePathExpr("~/.claude/settings.json"),
      (old) => editClaudeSettings(old, claudeAu)
    )) {
      onData(`已接管 claude settings.json：DISABLE_AUTOUPDATER=${au.disableAutoUpdater ? "1" : "移除"}${pinnedVersion ? `，minimumVersion=${pinnedVersion}` : ""}\n`);
    }
  }
  return { changed, warned };
}

/** 接管结果的一句话描述：有告警且没改成时不能说「已匹配」，那是被跳过了 */
const takeoverLabel = (r) =>
  r.changed ? `自动更新配置已更新${r.warned ? "（部分项有告警，详见日志）" : ""}`
    : r.warned ? "自动更新配置未能应用（有告警，详见日志）"
    : "自动更新配置已匹配，无需修改";

/** 固定版本号（渠道字段填了具体版本）时返回该版本，否则空 */
const pinnedOf = (spec) => (VERSION_RE.test(spec ?? "") ? spec : "");

/**
 * 立即把设置里的官方自动更新开关应用到某台主机的某个工具（独立于安装，npm 版同样适用）。
 * @returns {Promise<string>} 一句话结果
 */
export async function applyAutoUpdate(host, tool, config, onData = () => {}) {
  const toolCfg = resolveToolConfig(config, host, tool);
  onData(`[auto-update] ${tool}：应用官方自动更新设置\n`);
  const r = await takeoverAutoUpdate(host, tool, config, { pinnedVersion: pinnedOf(toolCfg.channel), channel: toolCfg.channel }, onData);
  return `${tool} ${takeoverLabel(r)}`;
}

// ---------- 安装前预检 ----------

/**
 * installDir 在 PATH 中的位置与遮蔽分析（逐 shell 上下文：当前 ssh shell / 登录 / 交互）。
 * 需要先有探测数据。汇总规则：任一上下文遮蔽 → shadowed；全部不在 PATH → not-on-path；否则 ok。
 */
export function preflight(host, tool, installDir, state) {
  const probe = state.hosts?.[host.id]?.probe;
  if (!probe?.done) return { status: "need-probe", reason: "请先对该主机执行「探测」" };
  const home = probe.meta.home || "";
  const dir = installDir.trim() === "~" ? home
    : installDir.startsWith("~/") ? `${home}/${installDir.slice(2)}`
    : installDir;
  const norm = (s) => (s ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const aliases = new Set([norm(dir)]);
  if (probe.meta.localBinReal && norm(dir) === norm(`${home}/.local/bin`)) aliases.add(norm(probe.meta.localBinReal));
  const versionAt = (p) => probe.candidates.find((c) => norm(c.path) === norm(p))?.version ?? "";

  const contexts = [];
  // 当前 shell：有逐条 pathEntries（含每条的 codex/claude 标志）
  {
    const entries = probe.pathEntries ?? [];
    const idx = entries.findIndex((e) => aliases.has(norm(e.dir)));
    const resolved = probe.contexts?.shell?.[tool] ?? "";
    const shadowedBy = idx > 0
      ? entries.slice(0, idx).filter((e) => e[tool]).map((e) => ({ index: e.index, dir: e.dir, version: versionAt(`${e.dir}/${tool}`) || versionAt(`${e.dir}/${tool}.exe`), method: "" }))
      : [];
    contexts.push({ name: "shell", position: idx < 0 ? -1 : idx + 1, total: entries.length, resolved, shadowedBy });
  }
  // 登录 / 交互：只有 PATH 字符串与 command -v 解析结果
  for (const name of ["login", "interactive"]) {
    const ctx = probe.contexts?.[name];
    if (!ctx?.path) continue;
    const dirs = ctx.path.split(":").filter(Boolean);
    const idx = dirs.findIndex((d) => aliases.has(norm(d)));
    const resolved = ctx[tool] ?? "";
    const shadowedBy = [];
    if (idx > 0 && resolved) {
      const rdir = resolved.slice(0, resolved.lastIndexOf("/"));
      if (!aliases.has(norm(rdir))) {
        const rIdx = dirs.findIndex((d) => norm(d) === norm(rdir));
        if (rIdx >= 0 && rIdx < idx) shadowedBy.push({ index: rIdx + 1, dir: rdir, version: versionAt(resolved), method: "" });
      }
    }
    contexts.push({ name, position: idx < 0 ? -1 : idx + 1, total: dirs.length, resolved, shadowedBy });
  }

  const anyShadow = contexts.find((c) => c.shadowedBy.length > 0);
  const anyOn = contexts.filter((c) => c.position > 0);
  let status;
  if (anyShadow) status = "shadowed";
  else if (anyOn.length === 0) status = "not-on-path";
  else status = "ok";
  const best = anyOn.sort((a, b) => a.position - b.position)[0];
  const sharedWarning = /^\/(mnt|media|net|nfs)\//.test(dir.replace(/\\/g, "/"))
    ? `${dir} 位于共享挂载，安装/切换会影响所有挂载该目录的机器，且二进制为特定架构`
    : "";
  return {
    status,
    installDir: dir,
    contexts,
    position: best?.position ?? -1,
    totalEntries: best?.total ?? 0,
    shadowedBy: anyShadow?.shadowedBy ?? [],
    shadowedContext: anyShadow?.name ?? "",
    sharedWarning,
    reason: status === "not-on-path" ? `${dir} 不在任何 shell 上下文的 PATH 中，安装后无法直接调用` : ""
  };
}

// ---------- 安装 ----------

/**
 * 目标机是否已经是「该版本的 hub 托管独立安装」：版本库里有该版本、current 与 installDir 入口都指向它、
 * 入口实际运行报告的版本恰好是目标版本。检测失败一律按「未安装」处理（回落到正常安装）。
 */
async function isStandaloneInstalled(host, tool, version, installDir) {
  try {
    if (host.kind === "local") return await isStandaloneInstalledLocal(tool, version, installDir);
    const dirExpr = remotePathExpr(installDir);
    const verOf = `head -n1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.]+)?' | head -n1`;
    const script = tool === "codex"
      ? `VERSION=${sq(version)}
ROOT="$HOME/.codex/packages/standalone"
ENTRY=${dirExpr}/codex
cur=$(readlink -f "$ROOT/current" 2>/dev/null || true)
case "$(basename "$cur")" in "$VERSION"-*) ;; *) exit 0 ;; esac
[ "$(readlink -f "$ENTRY" 2>/dev/null)" = "$(readlink -f "$ROOT/current/bin/codex" 2>/dev/null)" ] || exit 0
got=$("$ENTRY" --version 2>&1 | ${verOf})
[ "$got" = "$VERSION" ] && echo __ALREADY__
exit 0`
      : `VERSION=${sq(version)}
DIR="$HOME/.local/share/claude/versions"
ENTRY=${dirExpr}/claude
[ -f "$DIR/$VERSION" ] || exit 0
[ "$(readlink -f "$ENTRY" 2>/dev/null)" = "$(readlink -f "$DIR/$VERSION" 2>/dev/null)" ] || exit 0
got=$("$ENTRY" --version 2>&1 | ${verOf})
[ "$got" = "$VERSION" ] && echo __ALREADY__
exit 0`;
    const r = await runRemoteBash(host.id, script, { timeoutMs: 30_000 });
    return r.output.includes("__ALREADY__");
  } catch {
    return false;
  }
}

async function isStandaloneInstalledLocal(tool, version, installDir) {
  const psq = (s) => `'${s.replace(/'/g, "''")}'`;
  const installDirAbs = expandHomeLocal(installDir);
  const common = `
$ver = ${psq(version)}
function Get-Ver($exe) {
  if (-not (Test-Path $exe)) { return '' }
  $o = (& $exe --version 2>&1 | Select-Object -First 1)
  if ("$o" -match '(\\d+\\.\\d+\\.\\d+(-[A-Za-z0-9.]+)?)') { return $Matches[1] }
  return ''
}`;
  const script = tool === "codex"
    ? `${common}
$root = ${psq(expandHomeLocal("~/.codex/packages/standalone"))}
$cur = Join-Path $root 'current'
if (-not (Test-Path $cur)) { exit 0 }
$tgt = @((Get-Item $cur).Target)[0]
if (-not $tgt -or -not ((Split-Path $tgt -Leaf) -like ($ver + '-*'))) { exit 0 }
if ((Get-Ver (Join-Path ${psq(installDirAbs)} 'codex.exe')) -eq $ver) { Write-Output '__ALREADY__' }`
    : `${common}
$store = ${psq(expandHomeLocal("~/.local/share/claude/versions"))}
if (-not (Test-Path (Join-Path $store ($ver + '.exe')))) { exit 0 }
if ((Get-Ver (Join-Path ${psq(installDirAbs)} 'claude.exe')) -eq $ver) { Write-Output '__ALREADY__' }`;
  const r = await runLocalPwsh(script, { timeoutMs: 30_000 });
  return r.output.includes("__ALREADY__");
}

/**
 * 安装/切换工具。method=standalone（默认，本函数处理）或 npm（委托现有 updateTool）。
 * @returns {Promise<string>} 任务摘要
 */
export async function installTool(host, tool, opts, onData) {
  const config = opts.config;
  const toolCfg = resolveToolConfig(config, host, tool);
  const method = opts.method || toolCfg.method || "standalone";
  if (method === "npm") {
    onData("[install] method=npm，走 npm 全局安装\n");
    await updateTool(host, tool, onData);
    return `${tool} 已按 npm 方式更新`;
  }

  const installDirInput = (opts.installDir || toolCfg.installDir || "~/.local/bin").trim();
  const versionSpec = opts.version || toolCfg.channel;
  const state = loadState();
  const version = resolveVersionSpec(state, tool, versionSpec);
  const pinned = !["latest", "stable", "prerelease", ""].includes(versionSpec) ? version : "";
  onData(`目标: ${tool} ${version}（${versionSpec}）→ ${installDirInput}\n`);

  // 预检仅告警不阻断（批量更新不能因单台主机卡住）；遮蔽/不在 PATH 时安装后实际命中的仍是旧版本
  const pf = preflight(host, tool, installDirInput, state);
  if (pf.status === "shadowed") {
    const who = pf.shadowedBy.map((x) => `#${x.index} ${x.dir}（${x.version || "版本未知"}）`).join("、");
    onData(`\n[WARN] ⚠⚠⚠ 预检：${installDirInput} 在 ${CTX_LABELS[pf.shadowedContext] ?? pf.shadowedContext} 中被遮蔽，遮蔽者：${who}\n[WARN] 安装后 PATH 仍会命中旧版本，需卸载遮蔽者或调整 PATH（可用「PATH 修复」）\n\n`);
  } else if (pf.status === "not-on-path") {
    onData(`\n[WARN] ⚠⚠⚠ 预检：${pf.reason}\n\n`);
  } else if (pf.status === "need-probe") {
    onData("[预检] 该主机尚无探测数据，跳过 PATH 遮蔽预检（安装后会自动探测并校验生效版本）\n");
  }

  // 幂等：目标机已经是该版本的独立安装就跳过下载与安装，只做配置接管（opts.force 可强制重装）
  const alreadyInstalled = !opts.force && (await isStandaloneInstalled(host, tool, version, installDirInput));
  if (alreadyInstalled) {
    onData(`[skip] ${tool} ${version} 已是独立安装且入口生效，跳过下载与安装\n`);
  } else {
    const artifact = tool === "codex"
      ? await codexArtifact(host, version, config, onData)
      : await claudeArtifact(host, version, config, onData);
    if (host.kind === "local") {
      await installLocal(host, tool, version, artifact, installDirInput, config, onData);
    } else {
      await installRemote(host, tool, version, artifact, installDirInput, config, onData);
    }
  }

  const takeover = await takeoverAutoUpdate(host, tool, config, { pinnedVersion: pinned, channel: toolCfg.channel }, onData);

  // 验证 + 刷新探测快照
  onData("[verify] 重新探测验证…\n");
  const probe = await probeHost(host, () => {});
  const st = loadState();
  st.hosts[host.id] = { ...st.hosts[host.id], probe };
  saveState(st);
  const hit = probe.candidates.find(
    (c) => c.tool === tool && c.version === version && (c.method === "standalone-official" || c.method === "unknown")
  );
  if (!hit) onData(`[verify] 注意：候选扫描未收录 ${installDirInput}（可能不在 PATH/已知清单），但安装脚本内的版本校验已通过\n`);

  // 生效版本校验：各 shell 上下文里 `command -v` 实际解析到的版本，而不只是二进制自身能执行
  const problems = effectiveProblems(probe, tool, version);
  for (const p of problems) onData(`[WARN] ⚠⚠⚠ ${p}\n`);
  const base = alreadyInstalled
    ? `${tool} ${version} 已是独立安装，已跳过安装；${takeoverLabel(takeover)}`
    : `${tool} ${version} 已安装（standalone）`;
  return problems.length ? `${base}；⚠ 但${problems.join("；")}` : base;
}

const CTX_LABELS = { shell: "当前 ssh shell", login: "登录 shell", interactive: "交互 shell" };

/** 各 shell 上下文实际解析到的 tool 与目标版本的差异；空数组表示全部命中目标版本 */
export function effectiveProblems(probe, tool, target) {
  const norm = (x) => (x ?? "").replace(/\\/g, "/").toLowerCase().replace(/\.(exe|cmd|ps1)$/, "");
  const out = [];
  for (const name of ["shell", "login", "interactive"]) {
    const ctx = probe.contexts?.[name];
    if (!ctx) continue; // 该上下文未采集（如本机只有 shell）
    const resolved = ctx[tool] ?? "";
    if (!resolved) {
      out.push(`${CTX_LABELS[name]}中 PATH 找不到 ${tool}`);
      continue;
    }
    const cand = probe.candidates.find((c) => c.tool === tool && (norm(c.path) === norm(resolved) || norm(c.realPath) === norm(resolved)));
    if (cand && cand.version && cand.version !== target) {
      out.push(`${CTX_LABELS[name]}命中 ${resolved}（${cand.version}），不是刚安装的 ${target}`);
    }
  }
  return out;
}

/** 远程安装：先试远程直连下载，失败则 hub 下载后 SSH 中转 */
async function installRemote(host, tool, version, artifact, installDir, config, onData) {
  const dirExpr = remotePathExpr(installDir);
  const stagingRel = tool === "codex"
    ? "~/.codex/packages/standalone/.install-hub"
    : "~/.local/share/claude/versions/.install-hub";
  const pkgName = tool === "codex" ? (artifact.kind === "zip" ? "pkg.zip" : "pkg.tar.gz") : "pkg.bin";
  const pkgRel = `${stagingRel}/${pkgName}`;
  const pkgExpr = remotePathExpr(pkgRel);

  // 主机 prelude（代理/nvm 初始化等）必须在探测与安装脚本之前执行，否则内网机器的出网代理不生效、被误判为不可直连。
  // 放在 set -eu 之前：prelude 里的 nvm / source 不保证兼容 -e/-u。
  const prelude = bashPrelude(host);

  // 直连探测（HEAD）。注意：能连通不代表可用——有的主机直连只有几十 KB/s，
  // 这类主机应配置 preferRelay 强制走 hub 中转（hub 网络通常快得多）。
  const forceRelay = config.hostOverrides?.[host.id]?.preferRelay === true || config.download?.preferRelay === true;
  let direct = false;
  if (forceRelay) {
    onData("该主机配置为强制中转（preferRelay），跳过直连探测\n");
  } else {
    const head = await runRemoteBash(
      host.id,
      `${prelude}
curl -fsSLI --connect-timeout 8 --max-time 20 -o /dev/null ${sq(artifact.url)} && echo __DIRECT_OK__ || echo __DIRECT_FAIL__`,
      { timeoutMs: 45_000 }
    );
    direct = head.output.includes("__DIRECT_OK__");
    onData(direct ? "远程可直连下载源\n" : "远程不可直连下载源\n");
  }

  if (!direct) {
    // hub 下载 → 校验 → 中转推送
    const localFile = path.join(DL_DIR, `${tool}-${version}-${artifact.target ?? artifact.platformKey}.${artifact.kind === "zip" ? "zip" : artifact.kind === "tar.gz" ? "tar.gz" : "bin"}`);
    await ensureDownloaded(localFile, artifact, config.download?.proxy ?? "", onData);
    const r0 = await runRemoteBash(host.id, `mkdir -p ${remotePathExpr(stagingRel)} && rm -f ${pkgExpr}`, { timeoutMs: 30_000 });
    if (r0.code !== 0) throw new Error("远程暂存目录准备失败");
    if (hubTransfer.isFull()) onData("[queue] hub 传输名额已满，排队等待…\n");
    await hubTransfer.run(() => pushFileViaSsh(host, localFile, pkgRel, onData));
    onData("中转推送完成\n");
  }

  const downloadStep = direct
    ? `curl -fsSL --connect-timeout 15 --max-time 900 --retry 2 -o "\$PKG" ${sq(artifact.url)}`
    : `mv -f ${pkgExpr} "\$PKG"`; // 移动而非复制：省一份 100~240MB 的远程磁盘占用与拷贝时间

  const script = `${prelude}\n${buildRemoteInstallScript(tool, version, artifact, dirExpr, downloadStep, pkgExpr)}`;
  const r = await runRemoteBash(host.id, script, { onData, timeoutMs: 15 * 60_000 });
  if (r.code !== 0 || !r.output.includes("__INSTALL_OK__")) {
    throw new Error(`远程安装失败（exit=${r.code}），详见日志`);
  }
}

function buildRemoteInstallScript(tool, version, artifact, dirExpr, downloadStep, hubPkgExpr) {
  const shaCheck = `echo "${artifact.sha256}  $PKG" | sha256sum -c -`;
if (tool === "codex") {
    return `set -eu
VERSION=${sq(version)}
TARGET=${sq(artifact.target)}
ROOT="$HOME/.codex/packages/standalone"
REL="$ROOT/releases/$VERSION-$TARGET"
WORK="$ROOT/.install.$$"
HUB_PKG=${hubPkgExpr}
trap 'rm -rf "$WORK" "$(dirname "$HUB_PKG")"' EXIT
mkdir -p "$WORK" "$ROOT/releases"
PKG="$WORK/pkg.tar.gz"
echo "[remote] 获取安装包…"
${downloadStep}
echo "[remote] 校验 sha256…"
${shaCheck}
echo "[remote] 解包…"
tar -xzf "$PKG" -C "$WORK"
base="$WORK"
if [ ! -f "$base/bin/codex" ] && [ ! -f "$base/bin/codex.exe" ]; then
  pj=$(find "$WORK" -maxdepth 3 -name codex-package.json -type f 2>/dev/null | head -n1)
  [ -n "$pj" ] && base=$(dirname "$pj")
fi
if [ ! -f "$base/bin/codex" ] && [ ! -f "$base/bin/codex.exe" ]; then
  echo "[remote] 非 package 布局，按单文件处理"
  f=$(find "$WORK" -maxdepth 2 -type f -name 'codex*' ! -name '*.tar.gz' ! -name '*.json' | head -n1)
  [ -n "$f" ] || { echo "包内未找到 codex 可执行文件"; exit 1; }
  mkdir -p "$base/bin"
  install -m 755 "$f" "$base/bin/codex"
fi
rm -rf "$REL"
mkdir -p "$REL"
cp -a "$base/." "$REL/"
chmod 755 "$REL/bin/codex" 2>/dev/null || true
PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$REL" "$ROOT/.current.tmp.$$"
mv -T "$ROOT/.current.tmp.$$" "$ROOT/current"
mkdir -p ${dirExpr}
ln -sfn "$ROOT/current/bin/codex" ${dirExpr}/.codex.tmp.$$
mv -T ${dirExpr}/.codex.tmp.$$ ${dirExpr}/codex
got=$("$ROOT/current/bin/codex" --version 2>&1 || true)
if ! echo "$got" | grep -F "$VERSION" >/dev/null; then
  sleep 2
  got=$("$ROOT/current/bin/codex" --version 2>&1 || true)
fi
echo "[remote] installed: $(echo "$got" | tail -n1)"
echo "$got" | grep -F "$VERSION" >/dev/null || {
  echo "[remote] 版本校验失败，回滚 current"
  [ -n "$PREV" ] && ln -sfn "$PREV" "$ROOT/current" || rm -f "$ROOT/current"
  exit 1
}
echo "__INSTALL_OK__"`;
  }

  // claude：versions/<version> 单文件 + installDir 符号链接（官方布局）
  return `set -eu
VERSION=${sq(version)}
DIR="$HOME/.local/share/claude/versions"
HUB_PKG=${hubPkgExpr}
mkdir -p "$DIR"
PKG="$DIR/.install.$$"
trap 'rm -f "$PKG"; rm -rf "$(dirname "$HUB_PKG")"' EXIT
echo "[remote] 获取安装包…"
${downloadStep}
echo "[remote] 校验 sha256…"
${shaCheck}
chmod 755 "$PKG"
mv -f "$PKG" "$DIR/$VERSION"
mkdir -p ${dirExpr}
ln -sfn "$DIR/$VERSION" ${dirExpr}/claude
got=$("$DIR/$VERSION" --version 2>&1 || true)
if ! echo "$got" | grep -F "$VERSION" >/dev/null; then
  sleep 2
  got=$("$DIR/$VERSION" --version 2>&1 || true)
fi
echo "[remote] installed: $(echo "$got" | tail -n1)"
echo "$got" | grep -F "$VERSION" >/dev/null || { echo "[remote] 版本校验失败"; exit 1; }
echo "__INSTALL_OK__"`;
}

/** 本机 Windows 安装 */
async function installLocal(host, tool, version, artifact, installDir, config, onData) {
  const localFile = path.join(DL_DIR, `${tool}-${version}-${artifact.target ?? artifact.platformKey}.${artifact.kind === "zip" ? "zip" : artifact.kind === "tar.gz" ? "tar.gz" : "bin"}`);
  await ensureDownloaded(localFile, artifact, config.download?.proxy ?? "", onData);

  const installDirAbs = expandHomeLocal(installDir);
  const psq = (s) => `'${s.replace(/'/g, "''")}'`;
  // 入口统一为「复制件」：先把旧入口改名为 .old（运行中的 exe 不能覆盖但可以改名），再复制新文件。
  // 若 installDir 是旧版本遗留的 junction（指向 current\\bin），先拆掉并重建为真实目录，避免与版本库互相污染。
  const psEntryHelpers = `
function Ensure-RealDir($d) {
  if (Test-Path $d) {
    $it = Get-Item $d -Force
    $tgt = @($it.Target) -join ';'
    if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $tgt -match 'packages[\\\\/]standalone') { cmd /c rmdir "$d" | Out-Null; Write-Output ("已拆除遗留的入口 junction: " + $d) }
  }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
function Install-Entry($src, $dst) {
  $old = $dst + '.old'
  if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
  if (Test-Path $dst) { Move-Item $dst $old -Force }
  Copy-Item $src $dst -Force
}
`;
  let script;
  if (tool === "codex") {
    const root = expandHomeLocal("~/.codex/packages/standalone");
    const rel = path.join(root, "releases", `${version}-${artifact.target}`);
    script = psEntryHelpers + `
$ErrorActionPreference = 'Stop'
$pkg = ${psq(localFile)}
$rel = ${psq(rel)}
$root = ${psq(root)}
$installDir = ${psq(installDirAbs)}
$work = Join-Path $root (".install-" + $PID)
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  tar -xzf $pkg -C $work
  # package 布局定位：codex-package.json 或 bin\\codex.exe 所在目录
  $base = $work
  if (-not (Test-Path (Join-Path $base 'bin\\codex.exe'))) {
    $pj = Get-ChildItem $work -Recurse -Filter codex-package.json -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pj) { $base = $pj.DirectoryName }
  }
  if (-not (Test-Path (Join-Path $base 'bin\\codex.exe'))) {
    throw "包内未找到 bin\\codex.exe（package 布局缺失）"
  }
  if (Test-Path $rel) { Remove-Item $rel -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $rel | Out-Null
  Copy-Item (Join-Path $base '*') $rel -Recurse -Force
  # current junction 原子替换（先建临时 junction 再改名）
  $cur = Join-Path $root 'current'
  $tmpLink = Join-Path $root (".current-" + $PID)
  if (Test-Path $tmpLink) { cmd /c rmdir "$tmpLink" | Out-Null }
  New-Item -ItemType Junction -Path $tmpLink -Target $rel | Out-Null
  if (Test-Path $cur) { cmd /c rmdir "$cur" | Out-Null }
  Move-Item $tmpLink $cur
  # 入口：复制 codex.exe 到 installDir（installDir 常与其他工具共用，不能整目录 junction）
  $curBin = Join-Path $cur 'bin'
  Ensure-RealDir $installDir
  Install-Entry (Join-Path $curBin 'codex.exe') (Join-Path $installDir 'codex.exe')
  Write-Output "入口为复制 codex.exe；codex-path/codex-resources 留在版本库，rg 等附属能力将使用系统 PATH 中的版本"
  $got = (& (Join-Path $curBin 'codex.exe') --version 2>&1 | Select-Object -First 1)
  Write-Output ("installed: " + $got)
  if ($got -notmatch [regex]::Escape(${psq(version)})) { throw "版本校验失败: $got" }
  Write-Output '__INSTALL_OK__'
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}`;
  } else {

    const dir = expandHomeLocal("~/.local/share/claude/versions");
    script = psEntryHelpers + `
$ErrorActionPreference = 'Stop'
$pkg = ${psq(localFile)}
$dir = ${psq(dir)}
$installDir = ${psq(installDirAbs)}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Ensure-RealDir $installDir
$dst = Join-Path $dir ${psq(version + ".exe")}
Copy-Item $pkg $dst -Force
Install-Entry $dst (Join-Path $installDir 'claude.exe')
$got = (& $dst --version 2>&1 | Select-Object -First 1)
Write-Output ("installed: " + $got)
if ($got -notmatch [regex]::Escape(${psq(version)})) { throw "版本校验失败: $got" }
Write-Output '__INSTALL_OK__'`;
  }
  const r = await runLocalPwsh(script, { onData, timeoutMs: 5 * 60_000 });
  if (r.code !== 0 || !r.output.includes("__INSTALL_OK__")) {
    throw new Error(`本机安装失败（exit=${r.code}），详见日志`);
  }
}
