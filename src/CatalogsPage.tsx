import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { api } from "./api";
import type {
  CatalogFileInfo,
  CatalogSettings,
  Config,
  Host,
  HostState,
  MergedInfo
} from "./types";

/** 跟随 <html data-theme> 的编辑器明暗主题 */
function useEffectiveTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark")
  );
  useEffect(() => {
    const ob = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    });
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => ob.disconnect();
  }, []);
  return theme;
}

// ----- 与 server/tools.mjs 的 catalogReadiness 保持一致的轻量副本（前端仅用于展示与禁用） -----
function normalizePath(p: string, home: string, ci: boolean): string {
  let s = p.trim();
  if (!s) return "";
  if (s === "~") s = home;
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = home.replace(/[\\/]+$/, "") + "/" + s.slice(2);
  s = s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return ci ? s.toLowerCase() : s;
}

function readiness(
  host: Host,
  st: HostState | undefined,
  targetPath: string
): { ready: boolean; reason: string } {
  if (!st?.checkedAt || st.catalogJson === undefined) {
    return { ready: false, reason: "尚未采集该主机的 catalog 配置，请先在「主机管理」执行一次检查" };
  }
  const configured = (st.catalogJson ?? "").trim();
  if (!configured) {
    return { ready: false, reason: "该主机 config.toml 未开启 model_catalog_json，codex 不会加载本地 catalog 文件" };
  }
  const home = host.kind === "local" ? st.home || "~" : st.home || "~";
  const ci = host.kind === "local";
  if (normalizePath(configured, home, ci) !== normalizePath(targetPath, home, ci)) {
    return { ready: false, reason: `config.toml 中的路径「${configured}」与目标路径「${targetPath}」不一致` };
  }
  return { ready: true, reason: "" };
}

export default function CatalogsPage(props: {
  hosts: Host[];
  state: Record<string, HostState>;
  config: Config;
}) {
  const theme = useEffectiveTheme();
  const [files, setFiles] = useState<CatalogFileInfo[]>([]);
  const [settings, setSettings] = useState<CatalogSettings>(props.config.catalog);
  const [savedSettings, setSavedSettings] = useState<CatalogSettings>(props.config.catalog);
  const [merged, setMerged] = useState<MergedInfo | null>(null);
  const [mergedError, setMergedError] = useState("");
  const [activeName, setActiveName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [busy, setBusy] = useState("");
  const [newKey, setNewKey] = useState("");
  const [startInputs, setStartInputs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restartAfter, setRestartAfter] = useState(true);
  const [pushBusy, setPushBusy] = useState(false);
  const editorRef = useRef<{ name: string } | null>(null);

  const dirty = activeName !== null && content !== savedContent;
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const loadFiles = useCallback(async () => {
    const data = await api.getCatalogs();
    setFiles(data.files);
    setSettings(data.settings);
    setSavedSettings(data.settings);
  }, []);

  const loadMerged = useCallback(async () => {
    try {
      setMerged(await api.getMerged());
      setMergedError("");
    } catch (e) {
      setMerged(null);
      setMergedError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadFiles().catch((e) => alert((e as Error).message));
    loadMerged().catch(() => {});
  }, [loadFiles, loadMerged]);

  const openFile = useCallback(async (name: string) => {
    if (dirty && !window.confirm("当前文件有未保存的修改，切换后将丢失，继续？")) return;
    const data = await api.getCatalog(name);
    editorRef.current = { name };
    setActiveName(name);
    setContent(data.content);
    setSavedContent(data.content);
  }, [dirty]);

  const run = useCallback(async (tag: string, fn: () => Promise<unknown>) => {
    setBusy(tag);
    try {
      await fn();
      await loadFiles();
      await loadMerged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [loadFiles, loadMerged]);

  const saveSettings = () =>
    run("settings", async () => {
      await api.saveSettings({
        catalog: {
          sourceUrl: settings.sourceUrl,
          targetPath: settings.targetPath,
          forceResponsesLiteFalse: settings.forceResponsesLiteFalse
        }
      });
    });

  const saveFile = () =>
    run("save", async () => {
      if (!activeName) return;
      await api.saveCatalog(activeName, content);
      setSavedContent(content);
    });

  const formatContent = () => {
    try {
      setContent(JSON.stringify(JSON.parse(content), null, 2) + "\n");
    } catch (e) {
      alert(`无法格式化：${(e as Error).message}`);
    }
  };

  const refreshOai = () =>
    run("oai", async () => {
      await api.refreshOai();
      if (activeName === "models.oai.json") {
        const data = await api.getCatalog(activeName);
        setContent(data.content);
        setSavedContent(data.content);
      }
    });

  const removeFile = (name: string) => {
    if (!window.confirm(`确定删除 ${name}？（同目录会保留 .bak 备份的情况以服务器为准）`)) return;
    run("del", async () => {
      await api.deleteCatalog(name);
      if (activeName === name) {
        setActiveName(null);
        setContent("");
        setSavedContent("");
      }
    });
  };

  const renumber = (name: string) =>
    run("renumber", async () => {
      const start = Number(startInputs[name]);
      await api.renumberCatalog(name, start);
      if (activeName === name) {
        const data = await api.getCatalog(name);
        setContent(data.content);
        setSavedContent(data.content);
      }
    });

  // ----- 推送 -----
  const targetPath = savedSettings.targetPath;
  const pushable = useCallback(
    (h: Host): { ok: boolean; status: string; cls: string; reason: string } => {
      const st = props.state[h.id];
      const r = readiness(h, st, targetPath);
      if (!r.ready) return { ok: false, status: "未就绪", cls: "gray", reason: r.reason };
      if (!merged) return { ok: false, status: "未就绪", cls: "gray", reason: "合并预览不可用" };
      if (!st?.catalogHash) return { ok: true, status: "未安装", cls: "yellow", reason: "" };
      if (st.catalogHash === merged.hash) return { ok: false, status: "已最新", cls: "green", reason: "" };
      return { ok: true, status: "待更新", cls: "yellow", reason: "" };
    },
    [props.state, targetPath, merged]
  );

  const enabledHosts = useMemo(() => props.hosts.filter((h) => h.enabled), [props.hosts]);
  const selectedEnabled = useMemo(
    () => enabledHosts.filter((h) => selected.has(h.id)),
    [enabledHosts, selected]
  );
  const selectedTargets = selectedEnabled.filter((h) => pushable(h).ok);
  const allTargets = enabledHosts.filter((h) => pushable(h).ok);

  const pushBatch = async (targets: Host[]) => {
    setPushBusy(true);
    try {
      for (const h of targets) await api.pushCatalog(h.id, restartAfter);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setPushBusy(false);
    }
  };

  const toggleSelect = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const jsonExtensions = useMemo(() => [json(), linter(jsonParseLinter()), lintGutter()], []);

  return (
    <div className="catalog-page">
      {/* ===== catalog 设置 ===== */}
      <section className="panel catalog-settings">
        <label className="field grow">
          <span>OAI catalog 源地址</span>
          <input
            value={settings.sourceUrl}
            onChange={(e) => setSettings({ ...settings, sourceUrl: e.target.value })}
          />
        </label>
        <label className="field">
          <span>目标路径（各主机一致）</span>
          <input
            value={settings.targetPath}
            onChange={(e) => setSettings({ ...settings, targetPath: e.target.value })}
          />
        </label>
        <label className="field inline">
          <input
            type="checkbox"
            checked={settings.forceResponsesLiteFalse}
            onChange={(e) => setSettings({ ...settings, forceResponsesLiteFalse: e.target.checked })}
          />
          <span>合并时强制 OAI 模型 use_responses_lite=false</span>
        </label>
        <button disabled={!settingsDirty || busy === "settings"} onClick={saveSettings}>
          {busy === "settings" ? "保存中…" : "保存设置"}
        </button>
      </section>

      <div className="catalog-main">
        {/* ===== 文件列表 ===== */}
        <section className="panel catalog-files">
          <h3>catalog 文件</h3>
          {files.length === 0 && (
            <p className="muted">暂无文件。点击 models.oai.json 行的「重新下载」获取官方 catalog，或新建自定义文件。</p>
          )}
          <table className="file-table">
            <tbody>
              {files.map((f) => {
                const rangeText =
                  f.priorityMin === null ? "—" : `${f.priorityMin}~${f.priorityMax}`;
                const configured = settings.priorities[f.key]?.[0];
                return (
                  <tr key={f.name} className={f.name === activeName ? "active" : ""}>
                    <td>
                      <div className="file-head">
                        <button className="link" onClick={() => openFile(f.name)} title="点击编辑">
                          {f.name}
                        </button>
                        {f.isBuiltin && <span className="tag">内置</span>}
                        {!f.valid && <span className="tag off" title={f.error}>无效</span>}
                      </div>
                      <div className="file-meta">
                        {f.modelCount} 个模型 · 优先级 {rangeText} ·{" "}
                        {new Date(f.updatedAt).toLocaleString()}
                      </div>
                      <div className="file-actions">
                        {f.isBuiltin ? (
                          <button disabled={busy === "oai"} onClick={refreshOai} title="从源地址重新下载（会覆盖本地修改）">
                            {busy === "oai" ? "下载中…" : "重新下载"}
                          </button>
                        ) : (
                          <>
                            <input
                              className="start-input"
                              type="number"
                              min={0}
                              placeholder="起点"
                              title="优先级重排起点：按当前顺序从该值开始顺次编号"
                              value={startInputs[f.name] ?? configured ?? f.priorityMin ?? 0}
                              onChange={(e) => setStartInputs({ ...startInputs, [f.name]: e.target.value })}
                            />
                            <button
                              className="ghost"
                              disabled={busy === "renumber" || !f.valid}
                              onClick={() => renumber(f.name)}
                              title="按 (priority, slug) 排序后从起点顺次重写 priority"
                            >重排</button>
                            <button className="ghost danger" onClick={() => removeFile(f.name)}>删除</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="new-file">
            <input
              placeholder="新 catalog 名（如 groq）"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <button
              className="ghost"
              disabled={!newKey.trim() || busy === "new"}
              onClick={() =>
                run("new", async () => {
                  await api.createCatalog(newKey.trim());
                  setNewKey("");
                })
              }
            >新建</button>
          </div>
        </section>

        {/* ===== 编辑器 ===== */}
        <section className="panel catalog-editor">
          {activeName === null ? (
            <p className="muted editor-empty">从左侧选择一个文件开始编辑</p>
          ) : (
            <>
              <div className="editor-toolbar">
                <span className="editor-title">
                  {activeName}
                  {dirty && <span className="dirty-dot" title="有未保存修改" />}
                </span>
                <div className="editor-actions">
                  <button className="ghost" onClick={formatContent}>格式化</button>
                  <button
                    className="ghost"
                    disabled={!dirty}
                    onClick={() => setContent(savedContent)}
                  >放弃修改</button>
                  <button disabled={!dirty || busy === "save"} onClick={saveFile}>
                    {busy === "save" ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
              <CodeMirror
                value={content}
                height="480px"
                theme={theme}
                extensions={jsonExtensions}
                onChange={(v) => setContent(v)}
              />
            </>
          )}
        </section>
      </div>

      {/* ===== 合并预览 ===== */}
      <section className="panel catalog-merged">
        <div className="merged-head">
          <h3>合并预览</h3>
          <button className="ghost" onClick={() => loadMerged()}>刷新</button>
        </div>
        {mergedError && <p className="error-text">{mergedError}</p>}
        {merged && (
          <>
            <p className="merged-line">
              共 <b>{merged.modelCount}</b> 个模型 · hash <code>{merged.hash}</code>
              {merged.baselineHash
                ? merged.baselineHash === merged.hash
                  ? " · 与上次推送一致"
                  : ` · 较上次推送：新增 ${merged.added.length} / 删除 ${merged.removed.length} / 变化 ${merged.changed.length}`
                : " · 尚无推送基线（首次推送后建立）"}
            </p>
            {merged.conflicts.length > 0 && (
              <p className="error-text">
                slug 冲突：{merged.conflicts.map((c) => `${c.slug}（${c.files.join("、")}，${c.winner} 胜出）`).join("；")}
              </p>
            )}
            {(merged.added.length > 0 || merged.removed.length > 0 || merged.changed.length > 0) && (
              <details className="merged-detail">
                <summary>变更明细</summary>
                {merged.added.length > 0 && <p>新增：{merged.added.join("、")}</p>}
                {merged.removed.length > 0 && <p>删除：{merged.removed.join("、")}</p>}
                {merged.changed.length > 0 && <p>配置变化：{merged.changed.join("、")}</p>}
              </details>
            )}
          </>
        )}
      </section>

      {/* ===== 主机推送 ===== */}
      <section className="panel catalog-push">
        <div className="merged-head">
          <h3>推送到主机</h3>
          <label className="field inline restart-check">
            <input
              type="checkbox"
              checked={restartAfter}
              onChange={(e) => setRestartAfter(e.target.checked)}
            />
            <span>推送后重启 app-server（catalog 仅在启动时加载）</span>
          </label>
        </div>
        <div className="batchbar">
          <label className="select-all">
            <input
              type="checkbox"
              checked={
                enabledHosts.length > 0 && selectedEnabled.length === enabledHosts.length
              }
              disabled={enabledHosts.length === 0}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(enabledHosts.map((h) => h.id)) : new Set())
              }
            />
            <span>全选</span>
          </label>
          <span className="selected-count">已选 {selectedEnabled.length}/{enabledHosts.length} 台</span>
          <div className="batch-group">
            <button
              disabled={pushBusy || selectedTargets.length === 0}
              title={selectedTargets.length ? `推送选中的 ${selectedTargets.length} 台` : "选中主机中没有可推送的"}
              onClick={() => pushBatch(selectedTargets)}
            >推送选中</button>
            <button
              disabled={pushBusy || allTargets.length === 0}
              title={allTargets.length ? `推送全部 ${allTargets.length} 台（跳过已最新/未就绪）` : "所有主机均已最新或未就绪"}
              onClick={() => pushBatch(allTargets)}
            >推送全部</button>
          </div>
        </div>
        <table className="host-table push-table">
          <colgroup>
            <col className="c-check" /><col className="c-host" /><col /><col />
          </colgroup>
          <thead>
            <tr>
              <th></th>
              <th>主机</th>
              <th>catalog 状态</th>
              <th>config 中的路径</th>
            </tr>
          </thead>
          <tbody>
            {enabledHosts.map((h) => {
              const st = props.state[h.id];
              const p = pushable(h);
              return (
                <tr key={h.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(h.id)}
                      onChange={(e) => toggleSelect(h.id, e.target.checked)}
                      aria-label={`选择 ${h.name}`}
                    />
                  </td>
                  <td>
                    <div className="host-name">
                      {h.name}
                      {h.kind === "local" && <span className="tag">本机</span>}
                    </div>
                    <div className="host-meta">
                      {st?.catalogPushedAt ? `推送于 ${new Date(st.catalogPushedAt).toLocaleString()}` : "从未推送"}
                      {st?.catalogHash ? ` · hash ${st.catalogHash}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${p.cls}`}>{p.status}</span>
                    {!p.ok && p.reason && (
                      <span className="info-dot" title={p.reason}>ⓘ</span>
                    )}
                  </td>
                  <td className="path-cell">{st?.catalogJson || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
