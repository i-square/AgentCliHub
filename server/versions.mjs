// 版本号统取与缓存：只有 hub 本机访问外网，远程主机永远不查。
// 策略：固定间隔检查（默认 6 小时，可配 versions.checkIntervalMinutes）；
// 启动时根据 state.json 里的上次检查时间决定是否立即检查。
import { spawn } from "node:child_process";
import { loadState, saveState } from "./store.mjs";

const GCS_BASE =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const CODEX_ATOM = "https://github.com/openai/codex/releases.atom";
const CODEX_API_LATEST = "https://api.github.com/repos/openai/codex/releases/latest";
const CODEX_OPENAI_LATEST = "https://releases.openai.com/codex/channels/latest";
// GitHub「最新正式版」页面：302 到 /releases/tag/rust-vX.Y.Z，不走 API，不受匿名限流影响
const CODEX_RELEASES_LATEST = "https://github.com/openai/codex/releases/latest";
const CODEX_NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";

const DEFAULT_INTERVAL_MIN = 360;
// 某个工具的版本获取失败/缺失时，重试的最小间隔（避免调度器每分钟都打外网）
const RETRY_BACKOFF_MS = 10 * 60_000;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function versionsConfig(config) {
  const n = Number(config?.versions?.checkIntervalMinutes);
  return { checkIntervalMinutes: Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MIN };
}

/**
 * 系统 curl 出口：统一代理/超时/头处理。
 * Windows 10+ 自带 curl.exe；代理模板（如 socks5h://[user:pass@]host:port）原样透传给 --proxy。
 */
export function curlText(url, { proxy = "", headers = [], timeoutSec = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-fsSL", "--connect-timeout", "15", "--max-time", String(timeoutSec)];
    if (proxy) args.push("--proxy", proxy);
    for (const h of headers) args.push("-H", h);
    args.push(url);
    const child = spawn("curl", args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => reject(new Error(`curl 不可用: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`curl 退出码 ${code}: ${err.trim().slice(0, 200) || "无输出"}`))
    );
  });
}

/** 跟随重定向，返回最终 URL（用于解析 GitHub releases/latest 指向的 tag） */
function curlFinalUrl(url, { proxy = "", timeoutSec = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-sSIL", "--connect-timeout", "15", "--max-time", String(timeoutSec), "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{url_effective}"];
    if (proxy) args.push("--proxy", proxy);
    args.push(url);
    const child = spawn("curl", args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => reject(new Error(`curl 不可用: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`curl 退出码 ${code}: ${err.trim().slice(0, 200) || "无输出"}`))
    );
  });
}

/** atom feed：过滤 alpha/beta 预发布，取首个稳定版 */
function parseAtom(xml) {
  const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
  let stable = "";
  let prerelease = "";
  for (const t of titles) {
    if (!stable) {
      const m = /^(?:rust-v)?(\d+\.\d+\.\d+)$/.exec(t);
      if (m) { stable = m[1]; continue; }
    }
    if (!prerelease) {
      const m = /^(?:rust-v)?(\d+\.\d+\.\d+-(?:alpha|beta)[\d.]*)$/.exec(t);
      if (m) prerelease = m[1];
    }
    if (stable && prerelease) break;
  }
  return { stable, prerelease };
}

async function fetchCodexLatest(proxy, token) {
  let prerelease = "";
  // ① atom feed（无需鉴权）。近期可能全是 alpha，此时只取预发布号，稳定版继续往下找
  try {
    const xml = await curlText(CODEX_ATOM, { proxy, timeoutSec: 20 });
    const r = parseAtom(xml);
    prerelease = r.prerelease;
    if (r.stable) return { latest: r.stable, prerelease, source: "github-atom" };
  } catch {
    /* 继续降级 */
  }
  const ok = (r) => ({ ...r, ...(prerelease ? { prerelease } : {}) });
  // ② github.com/releases/latest 重定向（GitHub 定义的「最新正式版」，不走 API）
  try {
    const url = await curlFinalUrl(CODEX_RELEASES_LATEST, { proxy });
    const m = /\/tag\/(?:rust-v)?(\d+\.\d+\.\d+)$/.exec(url);
    if (m) return ok({ latest: m[1], source: "github-latest-redirect" });
  } catch {
    /* 继续降级 */
  }
  // ③ api.github.com（匿名 60 次/小时，配 token 可提高限额）
  try {
    const headers = token ? ["Authorization: Bearer " + token] : [];
    const body = await curlText(CODEX_API_LATEST, { proxy, headers, timeoutSec: 20 });
    const tag = JSON.parse(body).tag_name ?? "";
    const m = /^(?:rust-v)?(\d+\.\d+\.\d+)$/.exec(tag);
    if (m) return ok({ latest: m[1], source: "github-api" });
  } catch {
    /* 继续降级 */
  }
  // ④ npm registry：包版本与 GitHub 发布同步（独立二进制与 npm 同源发布）
  try {
    const body = await curlText(CODEX_NPM_LATEST, { proxy, timeoutSec: 20 });
    const v = JSON.parse(body).version ?? "";
    if (SEMVER.test(v)) return ok({ latest: v, source: "npm-registry" });
  } catch {
    /* 继续降级 */
  }
  // ⑤ releases.openai.com（部分网络不可达）
  const body = await curlText(CODEX_OPENAI_LATEST, { proxy, timeoutSec: 20 });
  let v = "";
  try {
    const j = JSON.parse(body);
    v = j.version ?? j.tag_name ?? j.name ?? "";
  } catch {
    /* 非 JSON，走正则兜底 */
  }
  const m = /(\d+\.\d+\.\d+)/.exec(String(v) || body);
  if (!m) throw new Error("所有 codex 版本源均不可用");
  return ok({ latest: m[1], source: "openai-releases" });
}

async function fetchClaudeLatest(proxy) {
  const [stable, latest] = await Promise.all([
    curlText(`${GCS_BASE}/stable`, { proxy, timeoutSec: 20 }),
    curlText(`${GCS_BASE}/latest`, { proxy, timeoutSec: 20 })
  ]);
  const s = stable.trim();
  const l = latest.trim();
  if (!SEMVER.test(s) || !SEMVER.test(l)) {
    throw new Error(`GCS 返回异常: stable=${s.slice(0, 40)} latest=${l.slice(0, 40)}`);
  }
  return { stable: s, latest: l, source: "gcs" };
}

/** 单个工具是否需要刷新：缺值/上次失败按短退避重试，正常则到期（间隔）才刷新 */
function toolNeedsRefresh(entry, hasValue, intervalMs, nowMs) {
  const lastOk = Date.parse(entry?.fetchedAt ?? "");
  const lastTry = Date.parse(entry?.lastAttemptAt ?? "");
  if (!hasValue || entry?.stale) {
    return !Number.isFinite(lastTry) || nowMs - lastTry >= Math.min(RETRY_BACKOFF_MS, intervalMs);
  }
  return !Number.isFinite(lastOk) || nowMs - lastOk >= intervalMs;
}

/**
 * 检查并刷新版本缓存。force=false 时按工具分别判断新鲜度（启动与定时器共用此入口）。
 * 注意：网络请求耗时可达数十秒，期间其他任务会写 state.json，所以落盘前必须重新读取，只合并 toolVersions。
 * @returns {{skipped: boolean, versions: object}}
 */
export async function refreshVersions(config, { force = false } = {}) {
  const prev = loadState().toolVersions ?? {};
  const intervalMs = versionsConfig(config).checkIntervalMinutes * 60_000;
  const nowMs = Date.now();
  const needCodex = force || toolNeedsRefresh(prev.codex, Boolean(prev.codex?.latest), intervalMs, nowMs);
  const needClaude = force || toolNeedsRefresh(prev.claude, Boolean(prev.claude?.stable && prev.claude?.latest), intervalMs, nowMs);
  if (!needCodex && !needClaude) return { skipped: true, versions: prev };

  const proxy = config.download?.proxy ?? "";
  const token = config.download?.githubToken ?? "";
  const now = new Date().toISOString();
  const next = {};

  if (needCodex) {
    try {
      const r = await fetchCodexLatest(proxy, token);
      next.codex = { ...r, fetchedAt: now, lastAttemptAt: now, stale: false };
    } catch (e) {
      next.codex = { ...(prev.codex ?? {}), lastAttemptAt: now, stale: true, error: e.message };
    }
  }
  if (needClaude) {
    try {
      const r = await fetchClaudeLatest(proxy);
      next.claude = { ...r, fetchedAt: now, lastAttemptAt: now, stale: false };
    } catch (e) {
      next.claude = { ...(prev.claude ?? {}), lastAttemptAt: now, stale: true, error: e.message };
    }
  }
  // 顶层 fetchedAt（UI 的「上次检查」）仅在至少一个工具成功时推进
  const anyOk = Object.values(next).some((t) => !t.stale);

  const state = loadState();
  state.toolVersions = { ...(state.toolVersions ?? {}), ...next, ...(anyOk ? { fetchedAt: now } : {}) };
  saveState(state);
  return { skipped: false, versions: state.toolVersions };
}

/** 启动调度：立即按间隔规则检查一次，之后每分钟自查看是否到期（间隔修改无需重启） */
export function startVersionScheduler(loadConfig) {
  const tick = () => {
    refreshVersions(loadConfig()).catch((e) => console.error("[versions] 检查失败:", e.message));
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
