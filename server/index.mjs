// CodexHub Web 后端：API + SSE 实时日志 + 静态前端
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, loadState, saveState } from "./store.mjs";
import { buildHostList, getHost } from "./hosts.mjs";
import { TOOLS, checkHost, updateTool, restartAppServer, pushCatalog, catalogReadiness } from "./tools.mjs";
import {
  OAI_NAME,
  listCatalogs,
  readCatalogText,
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
import { TaskManager } from "./tasks.mjs";

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
  res.json({ hosts: buildHostList(config), state: state.hosts, tools: TOOLS, config });
});

app.put("/api/hosts/:id/override", (req, res) => {
  const config = loadConfig();
  const { enabled, prelude, note } = req.body ?? {};
  const o = (config.hostOverrides[req.params.id] ??= {});
  if (typeof enabled === "boolean") o.enabled = enabled;
  if (typeof prelude === "string") o.prelude = prelude;
  if (typeof note === "string") o.note = note;
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

// ---------- 任务 ----------
app.get("/api/tasks", (req, res) => res.json({ tasks: tasks.list() }));
app.get("/api/tasks/:id", (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "task not found" });
  res.json(t);
});

/** 启动一个后台任务并立即返回任务 id */
function startTask(req, res, action, label, run) {
  const host = getHost(loadConfig(), req.params.id);
  if (!host) return res.status(404).json({ error: `未知主机: ${req.params.id}` });
  const task = tasks.create({ hostId: host.id, action, label: `${host.name} · ${label}` });
  const onData = (chunk) => tasks.append(task.id, chunk);
  (async () => {
    try {
      const result = await run(host, onData);
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
    const r = await updateTool(host, tool, onData);
    // 更新成功后立刻重新检查，刷新版本快照
    const status = await checkHost(host, () => {}, loadConfig().catalog.targetPath);
    const state = loadState();
    state.hosts[host.id] = { ...state.hosts[host.id], ...status, checkedAt: new Date().toISOString() };
    saveState(state);
    return `${TOOLS[tool].label} 已更新到 ${status[tool] || "未知"}${r.retried ? "（rename 失败已自动清理重试）" : ""}`;
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

app.listen(PORT, HOST, () => {
  console.log(`CodexHub Web 已启动: http://${HOST}:${PORT}`);
});
