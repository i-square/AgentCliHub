import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { api } from "./api";
import type {
  CatalogFileInfo,
  CatalogKeyInfo,
  CatalogSettings,
  CcModelPickerEntry,
  CcModelPickerOption,
  Config,
  Host,
  HostState,
  MergedInfo
} from "./types";

// 厂商 key（来源 catalog 文件名）-> 显示名称；未登记的按自定义文件名展示
const VENDOR_LABELS: Record<string, string> = {
  oai: "OpenAI",
  glm: "ZAI（智谱）",
  kimi: "Kimi",
  deepseek: "DeepSeek"
};
const VENDOR_ORDER = ["oai", "glm", "kimi", "deepseek"];

function groupByVendor(models: CcModelPickerEntry[]) {
  const groups = new Map<string, CcModelPickerEntry[]>();
  for (const m of models) groups.set(m.vendor, [...(groups.get(m.vendor) ?? []), m]);
  const rank = (v: string) => (VENDOR_ORDER.includes(v) ? VENDOR_ORDER.indexOf(v) : VENDOR_ORDER.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([vendor, ms]) => ({ vendor, label: VENDOR_LABELS[vendor] ?? vendor, models: ms }));
}

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

// 有官方拉取通道的厂商（对应 models.<key>.json）
const OFFICIAL_VENDORS = ["glm", "kimi", "deepseek"] as const;

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
  const [bandDrafts, setBandDrafts] = useState<Record<string, string>>({});
  // 每个 catalog 文件的官方拉取状态：idle(不渲染标记) / pulling(转圈) / ok / fail
  const [pullState, setPullState] = useState<Record<string, { phase: "pulling" | "ok" | "fail"; text: string }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restartAfter, setRestartAfter] = useState(true);
  const [pushBusy, setPushBusy] = useState(false);
  const [keysInfo, setKeysInfo] = useState<Record<string, CatalogKeyInfo>>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  // CC Model Picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerScope, setPickerScope] = useState<"local" | "selected" | "all">("all");
  const [pickerModels, setPickerModels] = useState<CcModelPickerEntry[]>([]);
  const [pickerChecked, setPickerChecked] = useState<Set<string>>(new Set());
  const [pickerSaving, setPickerSaving] = useState(false);
  const editorRef = useRef<{ name: string } | null>(null);

  const dirty = activeName !== null && content !== savedContent;
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const loadFiles = useCallback(async () => {
    const data = await api.getCatalogs();
    setFiles(data.files);
    setSettings(data.settings);
    setSavedSettings(data.settings);
  }, []);

  const loadKeys = useCallback(async () => {
    const data = await api.getCatalogKeys();
    setKeysInfo(data.keys);
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
    loadKeys().catch(() => {});
  }, [loadFiles, loadMerged, loadKeys]);

  /** 打开 Claude Code 模型选择器：读取合并后的模型 + hub 本机 settings.json 现有配置作为初始勾选 */
  const openPicker = async (scope: "local" | "selected" | "all") => {
    try {
      const data = await api.getCcModelPicker();
      const configured = new Set(data.current.map((o) => o.model.replace(/\[[^\]]*\]$/, "")));
      const hasAny = data.models.some((m) => configured.has(m.slug));
      setPickerModels(data.models);
      setPickerChecked(
        new Set(data.models.filter((m) => (hasAny ? configured.has(m.slug) : m.defaultChecked)).map((m) => m.slug))
      );
      setPickerScope(scope);
      setPickerOpen(true);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  /** 把勾选结果写入目标主机：每台主机一个后台任务（同主机串行），进度见页面底部任务日志 */
  const applyPicker = async () => {
    setPickerSaving(true);
    try {
      const options: CcModelPickerOption[] = pickerModels
        .filter((m) => pickerChecked.has(m.slug))
        .map((m) => ({ model: m.model, label: m.displayName, description: m.description }));
      for (const h of pickerTargets) await api.applyCcPicker(h.id, options);
      setPickerOpen(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setPickerSaving(false);
    }
  };

  const togglePicker = (slugs: string[], on: boolean) =>
    setPickerChecked((prev) => {
      const next = new Set(prev);
      slugs.forEach((x) => (on ? next.add(x) : next.delete(x)));
      return next;
    });

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

  /** 官方源拉取（不弹窗）：行内图标转圈 → ✅/❌ 标记，明细放 title 提示 */
  const runPull = <T,>(name: string, fn: () => Promise<T>, okText: (r: T) => string) => {
    setPullState((prev) => ({ ...prev, [name]: { phase: "pulling", text: "" } }));
    (async () => {
      try {
        const r = await fn();
        await loadFiles();
        await loadMerged();
        if (activeName === name) {
          const data = await api.getCatalog(name);
          setContent(data.content);
          setSavedContent(data.content);
        }
        setPullState((prev) => ({ ...prev, [name]: { phase: "ok", text: okText(r) } }));
      } catch (e) {
        setPullState((prev) => ({ ...prev, [name]: { phase: "fail", text: (e as Error).message } }));
      }
    })();
  };

  const pullOfficial = (vendor: string) => {
    const name = `models.${vendor}.json`;
    runPull(
      name,
      () => api.pullOfficial(name, "auto"),
      (r) => `${r.channel === "official" ? "官方" : "备用"} · ${r.models.join("、")}${r.note ? `（${r.note}）` : ""}`
    );
  };

  /** 备用通道（CC Switch 社区预设源，人工维护、可能滞后于官方） */
  const pullBackup = (vendor: string) => {
    const name = `models.${vendor}.json`;
    runPull(
      name,
      () => api.pullOfficial(name, "ccswitch"),
      (r) => `备用 · ${r.models.join("、")}${r.note ? `（${r.note}）` : ""}`
    );
  };

  /** 一键拉取全部：OAI 官方 catalog + 三家厂商（官方优先，失败自动回落备用源） */
  const pullAll = () => {
    void runPull("models.oai.json", () => api.refreshOai(), () => "已更新");
    OFFICIAL_VENDORS.forEach((v) => pullOfficial(v));
  };
  const pullAllBusy = Object.values(pullState).some((s) => s.phase === "pulling");

  const saveKey = (vendor: string) =>
    run("keys", async () => {
      const v = (keyInputs[vendor] ?? "").trim();
      if (!v) return;
      const data = await api.saveCatalogKeys({ [vendor]: v });
      setKeysInfo(data.keys);
      setKeyInputs((prev) => ({ ...prev, [vendor]: "" }));
    });

  const clearKey = (vendor: string) => {
    if (!window.confirm(`确定清除 ${vendor} 的 API Key？`)) return;
    run("keys", async () => {
      const data = await api.saveCatalogKeys({ [vendor]: null });
      setKeysInfo(data.keys);
    });
  };

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
      const start = Number(bandDrafts[name]);
      if (!Number.isInteger(start) || start < 0) return;
      await api.renumberCatalog(name, start);
      setBandDrafts((prev) => ({ ...prev, [name]: "" }));
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
  // 选中的主机是用户的明确意图：只要就绪（config.toml 已指向目标路径）就允许推送，含「已最新」的强制重推
  const selectedTargets = selectedEnabled.filter((h) => readiness(h, props.state[h.id], targetPath).ready && merged !== null);
  const allTargets = enabledHosts.filter((h) => pushable(h).ok);

  const SCOPE_LABEL = { local: "本机", selected: "选中主机", all: "全部主机" } as const;
  const pickerTargets = useMemo(
    () =>
      pickerScope === "local"
        ? enabledHosts.filter((h) => h.kind === "local")
        : pickerScope === "selected"
          ? selectedEnabled
          : enabledHosts,
    [pickerScope, enabledHosts, selectedEnabled]
  );

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

      {/* ===== 厂商 API Key（仅本机保存，已被 gitignore） ===== */}
      <section className="panel catalog-keys">
        <div className="keys-head">
          <h3>厂商 API Key</h3>
          <span className="muted">
            仅保存到本机 data/catalog-keys.json（不提交 git），供「官方拉取」通道使用；不配置则自动回落 CC Switch 社区源。DeepSeek 目录托管在公开 CDN，无需 Key。
          </span>
        </div>
        {(["glm", "kimi"] as const).map((v) => (
          <div className="key-row" key={v}>
            <span className="key-label">{v === "glm" ? "GLM（智谱）" : "Kimi"}</span>
            <input
              type="password"
              autoComplete="off"
              placeholder={keysInfo[v]?.configured ? `已配置 ${keysInfo[v].preview}（输入新 key 覆盖）` : "未配置"}
              value={keyInputs[v] ?? ""}
              onChange={(e) => setKeyInputs({ ...keyInputs, [v]: e.target.value })}
            />
            <button disabled={!(keyInputs[v] ?? "").trim() || busy === "keys"} onClick={() => saveKey(v)}>
              {busy === "keys" ? "保存中…" : "保存"}
            </button>
            <button className="ghost danger" disabled={!keysInfo[v]?.configured || busy === "keys"} onClick={() => clearKey(v)}>
              清除
            </button>
          </div>
        ))}
      </section>

      <div className="catalog-main">
        {/* ===== 文件列表 ===== */}
        <section className="panel catalog-files">
          <div className="files-head">
            <h3>catalog 文件</h3>
            <button
              disabled={pullAllBusy}
              onClick={pullAll}
              title="一键拉取：OAI 官方 catalog + glm / kimi / deepseek 官方源（官方优先，失败自动回落 CC Switch 备用源），结果在各自行内标记"
            >
              {pullAllBusy ? "拉取中…" : "一键拉取全部"}
            </button>
          </div>
          {files.length === 0 && (
            <p className="muted">暂无文件。点击 models.oai.json 行的「重新下载」获取官方 catalog，或新建自定义文件。</p>
          )}
          <table className="file-table">
            <tbody>
              {files.map((f) => {
                const rangeText =
                  f.priorityMin === null ? "—" : `${f.priorityMin}~${f.priorityMax}`;
                const st = pullState[f.name];
                const isVendorFile = (OFFICIAL_VENDORS as readonly string[]).includes(f.key);
                const pullIcon = !st || st.phase === "pulling" ? "🔄" : st.phase === "ok" ? "✅" : "❌";
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
                        <span>
                          {f.modelCount} 个模型 · 优先级 {rangeText} ·{" "}
                          {new Date(f.updatedAt).toLocaleString()}
                        </span>
                        {isVendorFile && (
                          <span className="file-pull">
                            <button
                              className={`icon-pull ${st?.phase === "pulling" ? "spinning" : ""}`}
                              title={
                                st?.phase === "fail"
                                  ? `拉取失败：${st.text}`
                                  : st?.phase === "ok"
                                    ? `拉取成功：${st.text}`
                                    : `从官方源拉取并覆盖 ${f.name}（未配置 API Key 时自动回落 CC Switch 社区源）`
                              }
                              disabled={st?.phase === "pulling"}
                              onClick={() => pullOfficial(f.key)}
                            >
                              {pullIcon}
                            </button>
                            <button
                              className={`icon-pull ${st?.phase === "pulling" ? "spinning" : ""}`}
                              title="备用通道：从 CC Switch 社区预设源拉取并覆盖（人工维护、可能滞后于官方）"
                              disabled={st?.phase === "pulling"}
                              onClick={() => pullBackup(f.key)}
                            >
                              🔀
                            </button>
                            {st && st.phase !== "pulling" && (
                              <span className={`pull-note ${st.phase}`} title={st.text}>
                                {st.phase === "ok" ? st.text.split(" · ")[0] : "失败"}
                              </span>
                            )}
                          </span>
                        )}
                        {/* 非厂商行（如一键拉取时的 models.oai.json）：只显示状态标记 */}
                        {!isVendorFile && st && (
                          <span className="file-pull">
                            {st.phase === "pulling" ? (
                              <span className="icon-pull spinning">🔄</span>
                            ) : (
                              <span className={`pull-note ${st.phase}`} title={st.text}>
                                {st.phase === "ok" ? `✅ ${st.text}` : "❌ 失败"}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="file-actions">
                        {f.isBuiltin ? (
                          <button disabled={busy === "oai"} onClick={refreshOai} title="从源地址重新下载（会覆盖本地修改）">
                            {busy === "oai" ? "下载中…" : "重新下载"}
                          </button>
                        ) : (
                          <button className="ghost danger" onClick={() => removeFile(f.name)}>删除</button>
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

          {/* ===== priority 分段（留空 = 不重排） ===== */}
          <div className="catalog-bands">
            <h4>priority 分段（留空 = 不重排）</h4>
            {files.map((f) => {
              const configured = settings.priorities[f.key]?.[0];
              const draft = bandDrafts[f.name] ?? "";
              return (
                <div className="band-row" key={f.name}>
                  <span className="band-name">{f.name}</span>
                  <span className="band-range">
                    {f.priorityMin === null ? "—" : `${f.priorityMin}~${f.priorityMax}`}
                  </span>
                  <input
                    type="number"
                    min={0}
                    placeholder={configured !== undefined ? String(configured) : "起点"}
                    value={draft}
                    onChange={(e) => setBandDrafts({ ...bandDrafts, [f.name]: e.target.value })}
                  />
                  <button
                    className="ghost"
                    disabled={busy === "renumber" || !f.valid || draft.trim() === ""}
                    onClick={() => renumber(f.name)}
                    title="按 (priority, slug) 排序后从起点顺次重写 priority"
                  >应用</button>
                </div>
              );
            })}
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

      {pickerOpen && (
        <div className="modal-mask" onClick={() => setPickerOpen(false)}>
          <div className="modal picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>配置 Claude Code 模型选择器</h3>
              <button className="ghost" onClick={() => setPickerOpen(false)}>关闭</button>
            </div>
            <div className="modal-body">
              <p className="muted picker-hint">
                勾选的模型写入目标主机 ~/.claude/settings.json 的 modelPicker.options；不属于 catalog 的手工条目会保留，覆盖前自动备份为 settings.json.bak。OpenAI（GPT）默认不勾选。
              </p>
              {pickerModels.length === 0 && <p className="muted">暂无模型，请先拉取 catalog 文件。</p>}
              {groupByVendor(pickerModels).map(({ vendor, label, models: vms }) => {
                const slugs = vms.map((m) => m.slug);
                const n = slugs.filter((x) => pickerChecked.has(x)).length;
                return (
                  <div key={vendor} className="picker-vendor-group">
                    <label className="picker-vendor-label">
                      <input
                        type="checkbox"
                        checked={n === slugs.length}
                        ref={(el) => { if (el) el.indeterminate = n > 0 && n < slugs.length; }}
                        onChange={(e) => togglePicker(slugs, e.target.checked)}
                      />
                      <strong>{label}</strong>
                      <span className="muted">{n}/{slugs.length}</span>
                    </label>
                    <table className="picker-model-table">
                      <tbody>
                        {vms.map((m) => (
                          <tr key={m.slug}>
                            <td className="c-check">
                              <input
                                type="checkbox"
                                checked={pickerChecked.has(m.slug)}
                                onChange={(e) => togglePicker([m.slug], e.target.checked)}
                                aria-label={m.displayName}
                              />
                            </td>
                            <td className="picker-slug"><code>{m.model}</code></td>
                            <td className="picker-name">{m.displayName}</td>
                            <td className="picker-desc muted">{m.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
              <div className="modal-actions picker-modal-actions">
                <span className="muted">
                  已选 {pickerChecked.size} / {pickerModels.length} · 目标：{SCOPE_LABEL[pickerScope]}（{pickerTargets.length} 台：{pickerTargets.map((h) => h.name).join("、") || "无"}）
                </span>
                <button className="ghost" onClick={() => setPickerOpen(false)}>取消</button>
                <button disabled={pickerSaving || pickerModels.length === 0 || pickerTargets.length === 0} onClick={applyPicker}>
                  {pickerSaving ? "提交中…" : `写入 ${pickerTargets.length} 台`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
              title={selectedTargets.length
                ? `推送 models.json 到选中的 ${selectedTargets.length} 台（已最新的也会重推；未就绪的跳过）`
                : selectedEnabled.length ? "选中的主机均未就绪（见右侧 ⓘ）" : "请先勾选主机"}
              onClick={() => pushBatch(selectedTargets)}
            >推送选中</button>
            <button
              disabled={pushBusy || allTargets.length === 0}
              title={allTargets.length ? `推送 models.json 到 ${allTargets.length} 台待更新主机（跳过已最新/未就绪）` : "没有待更新的主机：全部已最新或未就绪"}
              onClick={() => pushBatch(allTargets)}
            >推送全部</button>
          </div>
          <span className="batchbar-sep" aria-hidden="true" />
          <div className="batch-group">
            <button
              className="ghost"
              disabled={!enabledHosts.some((h) => h.kind === "local")}
              title="仅配置本机的 Claude Code 模型选择器（~/.claude/settings.json）"
              onClick={() => openPicker("local")}
            >配置本机 CC 模型</button>
            <button
              className="ghost"
              disabled={selectedEnabled.length === 0}
              title={selectedEnabled.length ? `配置选中的 ${selectedEnabled.length} 台主机的 Claude Code 模型选择器` : "请先勾选主机"}
              onClick={() => openPicker("selected")}
            >配置选中</button>
            <button
              className="ghost"
              disabled={enabledHosts.length === 0}
              title={`配置全部 ${enabledHosts.length} 台已启用主机的 Claude Code 模型选择器`}
              onClick={() => openPicker("all")}
            >配置全部</button>
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
