// AgentCliHub 后端：API + SSE 实时日志 + 静态前端
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, loadState, saveState } from "./store.mjs";
import { buildHostList, getHost } from "./hosts.mjs";
import { TOOLS, checkHost, updateTool, restartAppServer, pushCatalog, catalogReadiness, applyCcPickerToHost } from "./tools.mjs";
import {
  OAI_NAME,
  listCatalogs,
  readCatalogText,
  parseCatalogText,
  writeCatalog,
  createCatalog,
  deleteCatalog,
  refreshOai,
  mergeCatalogs,
  baselineFrom,
  summarize,
  renumber,
  isValidName,
  catalogKey
} from "./catalogs.mjs";
import { VENDOR_KEYS, maskKeys, saveCatalogKeys, pullVendorCatalog } from "./catalogSources.mjs";
import { TaskManager } from "./tasks.mjs";
import { refreshVersions, startVersionScheduler, versionsConfig } from "./versions.mjs";
import { probeHost } from "./probe.mjs";
import { installTool, preflight, resolveToolConfig, resolveVersionSpec, isValidVersionSpec, applyAutoUpdate } from "./install.mjs";
import { cleanupTool, repairPathLocal, repairPathRemote } from "./maintenance.mjs";

const PORT = Number(process.env.PORT ?? 8722);
const HOST = process.env.HOST ?? "127.0.0.1"; // 默认仅本机访问；此工具可执行远程命令，勿暴露到公网

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasks = new TaskManager();
const app = express();
app.use(express.json({ limit: "10mb" })); // catalog 文件可能接近 1MB

// ---------- SSE ----------
const sseClients = new Set();
tasks.on("task", (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ---------- 主机与配置 ----------
app.get("/api/hosts", (req, res) => {
  const config = loadConfig();
  const state = loadState();
  const hosts = buildHostList(config);
  const effectiveTools = {};
  for (const h of hosts) {
    effectiveTools[h.id] = {};
    for (const t of ["codex", "claude"]) {
      const cfg = resolveToolConfig(config, h, t);
      let target = "";
      try {
        if (cfg.method === "npm") {
          // npm 只有 latest 通道：目标始终以 npm 最新为准（用 hub 缓存，远程不查）
          const tv = state.toolVersions ?? {};
          target = (t === "codex" ? tv.codex?.latest : tv.claude?.latest) ?? "";
        } else {
          target = resolveVersionSpec(state, t, cfg.channel);
        }
      } catch { /* 缓存为空时留空 */ }
      effectiveTools[h.id][t] = { ...cfg, target };
    }
  }
  res.json({ hosts, state: state.hosts, tools: TOOLS, config, effectiveTools });
});

app.put("/api/hosts/:id/override", (req, res) => {
  const config = loadConfig();
  const { enabled, prelude, note, installDir, preferRelay } = req.body ?? {};
  const o = (config.hostOverrides[req.params.id] ??= {});
  if (typeof enabled === "boolean") o.enabled = enabled;
  if (typeof prelude === "string") o.prelude = prelude;
  if (typeof note === "string") o.note = note;
  if (typeof installDir === "string") o.installDir = installDir.trim();
  if (typeof preferRelay === "boolean") o.preferRelay = preferRelay;
  saveConfig(config);
  res.json({ ok: true });
});

app.get("/api/settings", (req, res) => res.json(loadConfig()));

app.put("/api/settings", (req, res) => {
  const config = loadConfig();
  const { excludePatterns, catalog } = req.body ?? {};
  if (Array.isArray(excludePatterns)) config.excludePatterns = excludePatterns.filter((s) => typeof s === "string");
  if (catalog && typeof catalog === "object") {
    if (typeof catalog.sourceUrl === "string" && catalog.sourceUrl.trim()) config.catalog.sourceUrl = catalog.sourceUrl.trim();
    if (typeof catalog.targetPath === "string" && catalog.targetPath.trim()) config.catalog.targetPath = catalog.targetPath.trim();
    if (typeof catalog.forceResponsesLiteFalse === "boolean") config.catalog.forceResponsesLiteFalse = catalog.forceResponsesLiteFalse;
  }
  const { versions, download } = req.body ?? {};
  if (versions && typeof versions === "object") {
    const m = Number(versions.checkIntervalMinutes);
    if (Number.isFinite(m) && m >= 5 && m <= 7 * 24 * 60) config.versions.checkIntervalMinutes = Math.round(m);
  }
  const { tools, autoUpdate } = req.body ?? {};
  if (tools && typeof tools === "object") {
    for (const t of ["codex", "claude"]) {
      const v = tools[t];
      if (!v || typeof v !== "object") continue;
      if (v.method === "standalone" || v.method === "npm") config.tools[t].method = v.method;
      if (typeof v.installDir === "string") config.tools[t].installDir = v.installDir.trim();
      if (typeof v.channel === "string") {
        const ch = v.channel.trim();
        if (ch && !isValidVersionSpec(t, ch)) return res.status(400).json({ error: `非法的渠道/版本: ${ch.slice(0, 40)}` });
        config.tools[t].channel = ch || config.tools[t].channel;
      }
    }
  }
  if (autoUpdate && typeof autoUpdate === "object") {
    const c = autoUpdate.codex ?? {};
    for (const k of ["startupCheck", "daemonAutoStart", "daemonAutoUpdate"]) {
      if (typeof c[k] === "boolean") config.autoUpdate.codex[k] = c[k];
    }
    const interval = Number(c.daemonIntervalMinutes);
    if (Number.isFinite(interval) && interval >= 15) config.autoUpdate.codex.daemonIntervalMinutes = Math.round(interval);
    if (typeof autoUpdate.claude?.disableAutoUpdater === "boolean") config.autoUpdate.claude.disableAutoUpdater = autoUpdate.claude.disableAutoUpdater;
  }
  if (download && typeof download === "object") {
    for (const k of ["proxy", "githubMirror", "githubToken"]) {
      if (typeof download[k] === "string") config.download[k] = download[k].trim();
    }
  }
  saveConfig(config);
  res.json({ ok: true });
});

// ---------- 模型目录 ----------
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

app.get("/api/catalogs", (req, res) => {
  res.json({ files: listCatalogs(), settings: loadConfig().catalog });
});

// 注意：/api/catalogs/merged 必须注册在 /api/catalogs/:name 之前
app.get("/api/catalogs/merged", (req, res) => {
  try {
    const config = loadConfig();
    const merged = mergeCatalogs(config.catalog);
    const baseline = loadState().catalogBaseline ?? null;
    res.json({
      hash: merged.hash,
      modelCount: merged.modelCount,
      conflicts: merged.conflicts,
      baselineHash: baseline?.hash ?? null,
      ...summarize(baseline, merged)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/catalogs/:name", (req, res) => {
  try {
    res.json({ name: req.params.name, content: readCatalogText(req.params.name) });
  } catch {
    res.status(404).json({ error: `catalog 不存在: ${req.params.name}` });
  }
});

app.put("/api/catalogs/:name", wrap((req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "缺少 content 字符串" });
  res.json({ ok: true, file: writeCatalog(req.params.name, content) });
}));

app.post("/api/catalogs", wrap((req, res) => {
  const key = String(req.body?.key ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) return res.status(400).json({ error: "名称只能包含小写字母、数字、连字符" });
  if (key === catalogKey(OAI_NAME)) return res.status(400).json({ error: "oai 为内置保留名" });
  res.json({ ok: true, file: createCatalog(key) });
}));

app.delete("/api/catalogs/:name", wrap((req, res) => {
  deleteCatalog(req.params.name);
  res.json({ ok: true });
}));

app.post("/api/catalogs/oai/refresh", async (req, res) => {
  try {
    const { sourceUrl } = loadConfig().catalog;
    const file = await refreshOai(sourceUrl);
    res.json({ ok: true, file });
  } catch (err) {
    res.status(502).json({ error: `下载 OAI catalog 失败：${err.message}` });
  }
});

// ---------- 厂商官方/备用源拉取 ----------

app.get("/api/catalog-keys", (req, res) => {
  res.json({ keys: maskKeys() });
});

app.put("/api/catalog-keys", wrap((req, res) => {
  res.json({ ok: true, keys: saveCatalogKeys(req.body ?? {}) });
}));


// 从厂商官方源拉取 catalog 并覆盖写入（写入后按优先级分段起点重排）。
// body.channel: "auto"（默认，官方优先、失败回落 CC Switch）| "official" | "ccswitch"
app.post("/api/catalogs/:name/pull-official", async (req, res) => {
  try {
    const name = req.params.name;
    const key = catalogKey(name);
    if (!key || !VENDOR_KEYS.includes(key)) {
      return res.status(400).json({ error: `catalog ${name} 没有厂商拉取通道（仅支持 ${VENDOR_KEYS.join("/")}）` });
    }
    const channel = ["auto", "official", "ccswitch"].includes(req.body?.channel) ? req.body.channel : "auto";
    const config = loadConfig();
    // Kimi 映射需要现有条目来保留展示文案；文件不存在时按空处理
    let existingModels = [];
    try {
      existingModels = parseCatalogText(readCatalogText(name)).models;
    } catch { /* 文件不存在或无效时使用空模板 */ }
    const result = await pullVendorCatalog(key, {
      channel,
      sources: config.catalog.sources,
      existingModels
    });
    const file = writeCatalog(name, JSON.stringify(result.catalog));
    // 按该厂商优先级分段起点重排，避免覆盖厂商原始 priority 后与合并分段冲突
    const bandStart = config.catalog.priorities[key]?.[0];
    const finalFile = Number.isInteger(bandStart) ? renumber(name, bandStart) : file;
    res.json({
      ok: true,
      file: finalFile,
      channel: result.channel,
      note: result.note,
      models: result.catalog.models.map((m) => m.slug)
    });
  } catch (err) {
    res.status(502).json({ error: `拉取失败：${err.message}` });
  }
});
// ---------- Claude Code Model Picker 配置 ----------
// settings.json 路径：~/.claude/settings.json（Windows: %USERPROFILE%\.claude\settings.json）
const CC_SETTINGS_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || "~",
  ".claude",
  "settings.json"
);

/** 读取 settings.json，不存在时返回 {} */
function readCcSettings() {
  try {
    return JSON.parse(fs.readFileSync(CC_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

const ONE_M = 1_000_000;

/** 合并后的 catalog 模型 → picker 条目；vendor 取自胜出的来源文件（oai/glm/kimi/自定义） */
function buildModelPickerList(catalogSettings) {
  const { catalog, winner } = mergeCatalogs(catalogSettings);
  return [...catalog.models]
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || String(a.slug).localeCompare(String(b.slug)))
    .map((m) => {
      const vendor = catalogKey(winner.get(m.slug) ?? "") ?? "custom";
      const ctx = m.max_context_window ?? m.context_window ?? 0;
      return {
        slug: m.slug,
        // 1M 上下文模型需带 [1m] 后缀，Claude Code 才会按 1M 窗口处理
        model: ctx >= ONE_M ? `${m.slug}[1m]` : m.slug,
        displayName: m.display_name ?? m.slug,
        description: m.description ?? "",
        vendor,
        defaultChecked: vendor !== "oai" // GPT（OpenAI 内置 catalog）默认不勾选
      };
    });
}

app.get("/api/cc-model-picker", (req, res) => {
  try {
    const models = buildModelPickerList(loadConfig().catalog);
    const current = readCcSettings().modelPicker?.options ?? [];
    res.json({ models, current, path: CC_SETTINGS_PATH });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 把前端勾选的 options 写入目标主机（本机或 ssh 远程）的 ~/.claude/settings.json，不经过 hub 本机
app.post("/api/hosts/:id/cc-picker-apply", (req, res) => {
  const options = req.body?.options;
  if (!Array.isArray(options) || options.some((o) => !o || typeof o.model !== "string" || !o.model)) {
    return res.status(400).json({ error: "options 必须是含非空 model 的数组" });
  }
  startTask(req, res, "cc-picker-apply", "配置 Claude Code 模型选择器", async (host, onData) => {
    const catalogSlugs = new Set(buildModelPickerList(loadConfig().catalog).map((m) => m.slug));
    const r = await applyCcPickerToHost(host, { options, catalogSlugs }, onData);
    return `已写入 ${r.count} 个模型（保留 ${r.kept} 个手工条目）`;
  });
});

app.post("/api/catalogs/:name/renumber", wrap((req, res) => {
  const start = Number(req.body?.start);
  if (!Number.isInteger(start) || start < 0) return res.status(400).json({ error: "start 必须是非负整数" });
  const file = renumber(req.params.name, start);
  // 记住该文件上次使用的优先级起点，作为下次的默认输入
  const config = loadConfig();
  const key = catalogKey(req.params.name);
  if (key) config.catalog.priorities[key] = [start, start + 100];
  saveConfig(config);
  res.json({ ok: true, file });
}));

// ---------- 版本缓存（仅 hub 本机查外网）与深度探测 ----------
app.get("/api/tool-versions", (req, res) => {
  const state = loadState();
  const config = loadConfig();
  res.json({
    versions: state.toolVersions ?? {},
    checkIntervalMinutes: versionsConfig(config).checkIntervalMinutes,
    proxyConfigured: Boolean(config.download?.proxy)
  });
});

app.post("/api/tool-versions/refresh", async (req, res) => {
  try {
    await refreshVersions(loadConfig(), { force: true });
    res.json({ ok: true, versions: loadState().toolVersions ?? {} });
  } catch (err) {
    res.status(502).json({ error: `刷新版本缓存失败：${err.message}` });
  }
});

/** 深度探测一台主机并写入 state（单机探测与全部探测共用） */
async function runProbe(host, onData) {
  const result = await probeHost(host, onData);
  const state = loadState();
  state.hosts[host.id] = { ...state.hosts[host.id], probe: result };
  saveState(state);
  const codexN = result.candidates.filter((c) => c.tool === "codex").length;
  const claudeN = result.candidates.filter((c) => c.tool === "claude").length;
  return `探测完成：codex 候选 ${codexN} 个，claude 候选 ${claudeN} 个`;
}

app.post("/api/hosts/:id/probe", (req, res) => startTask(req, res, "probe", "深度探测", runProbe));

// 全部探测：对所有已启用主机并行发起探测（只读，不加主机锁）
app.post("/api/probe-all", (req, res) => {
  const hosts = buildHostList(loadConfig()).filter((h) => h.enabled);
  const ids = [];
  for (const host of hosts) {
    const task = tasks.create({ hostId: host.id, action: "probe", label: `${host.name} · 深度探测` });
    ids.push(task.id);
    (async () => {
      try {
        tasks.finish(task.id, true, await runProbe(host, (c) => tasks.append(task.id, c)));
      } catch (err) {
        tasks.append(task.id, `\n[error] ${err.message}\n`);
        tasks.finish(task.id, false, err.message);
      }
    })();
  }
  res.json({ taskIds: ids });
});

// ---------- 独立二进制安装 / 预检 / 清理 / PATH 修复 ----------
app.post("/api/hosts/:id/preflight", (req, res) => {
  const host = getHost(loadConfig(), req.params.id);
  if (!host) return res.status(404).json({ error: `未知主机: ${req.params.id}` });
  const tool = req.body?.tool;
  if (!TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  const config = loadConfig();
  const installDir = (req.body?.installDir || resolveToolConfig(config, host, tool).installDir).trim();
  res.json(preflight(host, tool, installDir, loadState()));
});

app.post("/api/hosts/:id/install", (req, res) => {
  const tool = req.body?.tool;
  if (!TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  const { method, version, installDir, force } = req.body ?? {};
  if (!isValidVersionSpec(tool, version)) return res.status(400).json({ error: `非法的版本号: ${String(version).slice(0, 40)}` });
  if (installDir !== undefined && typeof installDir !== "string") return res.status(400).json({ error: "installDir 必须是字符串" });
  startTask(req, res, "install", `安装 ${TOOLS[tool].label}`, async (host, onData) => {
    return await installTool(host, tool, { config: loadConfig(), method, version, installDir, force: force === true }, onData);
  });
});

/** 立即应用官方自动更新设置到一台主机（tools 缺省 = codex + claude），完成后重新探测刷新快照 */
async function runAutoUpdate(host, tools, onData) {
  const config = loadConfig();
  const parts = [];
  for (const tool of tools) parts.push(await applyAutoUpdate(host, tool, config, onData));
  try {
    const probe = await probeHost(host, () => {});
    const st = loadState();
    st.hosts[host.id] = { ...st.hosts[host.id], probe };
    saveState(st);
  } catch (e) {
    onData(`[warn] 重新探测失败（不影响已写入的配置）：${e.message}\n`);
  }
  return parts.join("；");
}

app.post("/api/hosts/:id/auto-update", (req, res) => {
  const tool = req.body?.tool;
  if (tool !== undefined && !TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  startTask(req, res, "auto-update", "应用官方自动更新设置", (host, onData) => runAutoUpdate(host, tool ? [tool] : ["codex", "claude"], onData));
});

// 全部主机：对所有已启用主机并行发起（同一主机内仍与其他写操作串行）
app.post("/api/auto-update-all", (req, res) => {
  const hosts = buildHostList(loadConfig()).filter((h) => h.enabled);
  const ids = [];
  for (const host of hosts) {
    const task = tasks.create({ hostId: host.id, action: "auto-update", label: `${host.name} · 应用官方自动更新设置` });
    ids.push(task.id);
    const onData = (c) => tasks.append(task.id, c);
    (async () => {
      try {
        const result = await tasks.withHostLock(host.id, () => onData("[queue] 该主机有其他写操作进行中，已排队等待…\n"), () => runAutoUpdate(host, ["codex", "claude"], onData));
        tasks.finish(task.id, true, result);
      } catch (err) {
        onData(`\n[error] ${err.message}\n`);
        tasks.finish(task.id, false, err.message);
      }
    })();
  }
  res.json({ taskIds: ids });
});

app.post("/api/hosts/:id/cleanup", (req, res) => {
  const tool = req.body?.tool;
  if (!TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  const keep = Number.isInteger(req.body?.keep) && req.body.keep >= 0 ? req.body.keep : 2;
  startTask(req, res, "cleanup", `清理 ${TOOLS[tool].label} 旧版本`, async (host, onData) => {
    return await cleanupTool(host, tool, keep, onData, resolveToolConfig(loadConfig(), host, tool).installDir);
  });
});

app.post("/api/hosts/:id/path-repair", (req, res) => {
  const tool = req.body?.tool;
  if (!TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  startTask(req, res, "path-repair", "PATH 修复", async (host, onData) => {
    const config = loadConfig();
    const installDir = resolveToolConfig(config, host, tool).installDir;
    onData(`installDir: ${installDir}\n`);
    if (host.kind === "local") return await repairPathLocal(installDir, onData);
    return await repairPathRemote(host, installDir, onData);
  });
});


// 批量设置安装方式与更新渠道（写 hostOverrides，遵循各主机既有覆盖结构）
app.put("/api/hosts/tools-config", (req, res) => {
  const { hostIds, tool, method, channel } = req.body ?? {};
  if (!Array.isArray(hostIds) || hostIds.length === 0) return res.status(400).json({ error: "hostIds 不能为空" });
  if (!["codex", "claude"].includes(tool)) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  if (method !== undefined && !["standalone", "npm"].includes(method)) return res.status(400).json({ error: "method 必须是 standalone 或 npm" });
  if (channel !== undefined && typeof channel !== "string") return res.status(400).json({ error: "channel 必须是字符串" });
  if (channel && !isValidVersionSpec(tool, channel.trim())) return res.status(400).json({ error: `非法的渠道/版本: ${channel.slice(0, 40)}` });
  const config = loadConfig();
  const known = new Set(buildHostList(config).map((h) => h.id));
  for (const id of hostIds) {
    if (!known.has(id)) return res.status(400).json({ error: `未知主机: ${id}` });
    const o = (config.hostOverrides[id] ??= {});
    o.tools ??= {};
    o.tools[tool] = {
      ...(o.tools[tool] ?? {}),
      ...(method ? { method } : {}),
      ...(channel ? { channel: channel.trim() } : {})
    };
  }
  saveConfig(config);
  res.json({ ok: true });
});

// ---------- 任务 ----------
app.get("/api/tasks", (req, res) => res.json({ tasks: tasks.list() }));
app.get("/api/tasks/:id", (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  res.json(t);
});

/** 同一主机上必须串行的写操作（共用暂存目录 / current 链接 / 配置文件） */
const HOST_EXCLUSIVE = new Set(["install", "update", "cleanup", "path-repair", "auto-update", "cc-picker-apply"]);

/** 启动一个后台任务并立即返回任务 id */
function startTask(req, res, action, label, run) {
  const host = getHost(loadConfig(), req.params.id);
  if (!host) return res.status(404).json({ error: `未知主机: ${req.params.id}` });
  const task = tasks.create({ hostId: host.id, action, label: `${host.name} · ${label}` });
  const onData = (chunk) => tasks.append(task.id, chunk);
  const exec = HOST_EXCLUSIVE.has(action)
    ? () => tasks.withHostLock(host.id, () => onData("[queue] 该主机有其他写操作进行中，已排队等待…\n"), () => run(host, onData))
    : () => run(host, onData);
  (async () => {
    try {
      const result = await exec();
      tasks.finish(task.id, true, result ?? "完成");
    } catch (err) {
      tasks.append(task.id, `\n[error] ${err.message}\n`);
      tasks.finish(task.id, false, err.message);
    }
  })();
  res.json({ taskId: task.id });
}

app.post("/api/hosts/:id/check", (req, res) =>
  startTask(req, res, "check", "检查状态", async (host, onData) => {
    const status = await checkHost(host, onData, loadConfig().catalog.targetPath);
    const state = loadState();
    state.hosts[host.id] = { ...state.hosts[host.id], ...status, checkedAt: new Date().toISOString() };
    saveState(state);
    return `codex ${status.codex || "未安装"} / claude ${status.claude || "未安装"}`;
  })
);

app.post("/api/hosts/:id/update", (req, res) => {
  const tool = req.body?.tool;
  if (!TOOLS[tool]) return res.status(400).json({ error: "tool 必须是 codex 或 claude" });
  startTask(req, res, "update", `更新 ${TOOLS[tool].label}`, async (host, onData) => {
    const config = loadConfig();
    const toolCfg = resolveToolConfig(config, host, tool);
    let summary;
    if (toolCfg.method === "standalone") {
      // 遵循该主机的安装方式与渠道：standalone 更新 = 安装渠道目标版本
      onData(`[update] 生效策略: standalone / ${toolCfg.channel} / ${toolCfg.installDir}\n`);
      summary = await installTool(host, tool, { config, version: toolCfg.channel, installDir: toolCfg.installDir }, onData);
    } else {
      onData("[update] 生效策略: npm\n");
      const r = await updateTool(host, tool, onData);
      summary = `${TOOLS[tool].label} 已更新${r.retried ? "（rename 失败已自动清理重试）" : ""}`;
    }
    // 更新成功后立刻重新检查，刷新版本快照
    const status = await checkHost(host, () => {}, config.catalog.targetPath);
    const state = loadState();
    state.hosts[host.id] = { ...state.hosts[host.id], ...status, checkedAt: new Date().toISOString() };
    saveState(state);
    return summary;
  });
});


app.post("/api/hosts/:id/restart-app-server", (req, res) =>
  startTask(req, res, "restart", "重启 app-server", async (host, onData) => {
    await restartAppServer(host, onData);
    return "app-server 已重启";
  })
);

app.post("/api/hosts/:id/catalog-push", (req, res) =>
  startTask(req, res, "catalog-push", "推送模型目录", async (host, onData) => {
    const config = loadConfig();
    const state = loadState();
    const readiness = catalogReadiness(host, state.hosts[host.id], config.catalog.targetPath);
    if (!readiness.ready) throw new Error(`已阻止推送：${readiness.reason}`);

    const merged = mergeCatalogs(config.catalog);
    onData(`合并 ${merged.modelCount} 个模型，hash=${merged.hash}\n`);
    if (merged.conflicts.length) {
      onData(`[warn] 存在 slug 冲突：${merged.conflicts.map((c) => `${c.slug}(${c.winner} 胜出)`).join("、")}\n`);
    }
    await pushCatalog(host, merged.rendered, { targetPath: config.catalog.targetPath, onData });

    state.catalogBaseline = baselineFrom(merged);
    state.hosts[host.id] = {
      ...state.hosts[host.id],
      catalogHash: merged.hash,
      catalogPushedAt: new Date().toISOString()
    };
    saveState(state);

    if (req.body?.restart) {
      await restartAppServer(host, onData);
    }
    return `已推送 ${merged.modelCount} 个模型（hash ${merged.hash}）`;
  })
);

app.post("/api/check-all", (req, res) => {
  const config = loadConfig();
  const hosts = buildHostList(config).filter((h) => h.enabled);
  const ids = [];
  for (const host of hosts) {
    const task = tasks.create({ hostId: host.id, action: "check", label: `${host.name} · 检查状态` });
    ids.push(task.id);
    (async () => {
      try {
        const status = await checkHost(host, (c) => tasks.append(task.id, c), config.catalog.targetPath);
        const state = loadState();
        state.hosts[host.id] = { ...state.hosts[host.id], ...status, checkedAt: new Date().toISOString() };
        saveState(state);
        tasks.finish(task.id, true, `codex ${status.codex || "未安装"} / claude ${status.claude || "未安装"}`);
      } catch (err) {
        tasks.append(task.id, `\n[error] ${err.message}\n`);
        tasks.finish(task.id, false, err.message);
      }
    })();
  }
  res.json({ taskIds: ids });
});

// ---------- 静态前端（生产模式：vite build 产物） ----------
const distDir = path.join(rootDir, "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, "index.html")));
} else {
  app.get("/", (req, res) =>
    res.type("text").send("前端尚未构建。开发请用 `pnpm dev`，或先 `pnpm build` 再 `pnpm start`。")
  );
}

// 版本缓存调度：启动时按上次检查时间决定，之后按间隔定时检查
startVersionScheduler(loadConfig);

app.listen(PORT, HOST, () => {
  console.log(`AgentCliHub 已启动: http://${HOST}:${PORT}`);
});

// 优雅停止（pm2 restart/stop 先发 SIGINT）：把运行中的任务标记为 interrupted 并落盘。
// 被 SIGKILL/OOM 杀掉时来不及执行，由下次启动时 TaskManager 恢复逻辑兜底。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    tasks.interruptRunning(`服务收到 ${sig} 停止/重启，任务被中断`);
    process.exit(0);
  });
}
