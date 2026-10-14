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

const DEFAULT_INTERVAL_MIN = 360;

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

/** atom feed：过滤 alpha/beta 预发布，取首个稳定版 */
function latestStableFromAtom(xml) {
  const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
  for (const t of titles) {
    const m = /^(?:rust-v)?(\d+\.\d+\.\d+)$/.exec(t);
    if (m) return m[1];
  }
  return "";
}

async function fetchCodexLatest(proxy, token) {
  // ① atom feed（无需鉴权，不易限流）
  try {
    const xml = await curlText(CODEX_ATOM, { proxy, timeoutSec: 20 });
    const v = latestStableFromAtom(xml);
    if (v) return { latest: v, source: "github-atom" };
  } catch {
    /* 继续降级 */
  }
  // ② api.github.com（配 token 可提高限额）
  try {
    const headers = token ? ["Authorization: Bearer " + token] : [];
    const body = await curlText(CODEX_API_LATEST, { proxy, headers, timeoutSec: 20 });
    const tag = JSON.parse(body).tag_name ?? "";
    const m = /^(?:rust-v)?(\d+\.\d+\.\d+)/.exec(tag);
    if (m) return { latest: m[1], source: "github-api" };
  } catch {
    /* 继续降级 */
  }
  // ③ releases.openai.com（部分网络不可达）
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
  return { latest: m[1], source: "openai-releases" };
}

async function fetchClaudeLatest(proxy) {
  const [stable, latest] = await Promise.all([
    curlText(`${GCS_BASE}/stable`, { proxy, timeoutSec: 20 }),
    curlText(`${GCS_BASE}/latest`, { proxy, timeoutSec: 20 })
  ]);
  const s = stable.trim();
  const l = latest.trim();
  if (!/^\d+\.\d+\.\d+$/.test(s) && !/^\d+\.\d+\.\d+$/.test(l)) {
    throw new Error(`GCS 返回异常: stable=${s.slice(0, 40)} latest=${l.slice(0, 40)}`);
  }
  return { stable: s, latest: l, source: "gcs" };
}

/**
 * 检查并刷新版本缓存。force=false 时按间隔决定去留（启动与定时器共用此入口）。
 * @returns {{skipped: boolean, versions: object}}
 */
export async function refreshVersions(config, { force = false } = {}) {
  const state = loadState();
  const prev = state.toolVersions ?? {};
  const intervalMs = versionsConfig(config).checkIntervalMinutes * 60_000;
  const last = Date.parse(prev.fetchedAt ?? "");
  if (!force && Number.isFinite(last) && Date.now() - last < intervalMs) {
    return { skipped: true, versions: prev };
  }

  const proxy = config.download?.proxy ?? "";
  const token = config.download?.githubToken ?? "";
  const now = new Date().toISOString();
  const next = { fetchedAt: now };

  try {
    const r = await fetchCodexLatest(proxy, token);
    next.codex = { ...r, fetchedAt: now, stale: false };
  } catch (e) {
    next.codex = { ...(prev.codex ?? {}), stale: true, error: e.message };
  }
  try {
    const r = await fetchClaudeLatest(proxy);
    next.claude = { ...r, fetchedAt: now, stale: false };
  } catch (e) {
    next.claude = { ...(prev.claude ?? {}), stale: true, error: e.message };
  }
  // 两个都失败时保留旧 fetchedAt，避免掩盖真实的上次成功时间
  if (!prev.codex && next.codex?.stale && !prev.claude && next.claude?.stale) {
    delete next.fetchedAt;
  }

  state.toolVersions = { ...prev, ...next };
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
