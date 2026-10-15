import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
// CodeMirror 体积较大，目录页按需加载
const CatalogsPage = lazy(() => import("./CatalogsPage"));
import type { Config, EffectiveTool, Host, HostState, HostsResponse, PreflightResult, ProbeResult, Task, ToolVersions, ToolVersionsResponse } from "./types";

type ToolId = "codex" | "claude";

/** semver 比较：a<b→-1，a=b→0，a>b→1；预发布（alpha/beta）低于同三号稳定版 */
function cmpVer(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)?[\d.]*)?$/.exec(v);
    if (!m) return null;
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
type ThemeMode = "light" | "dark" | "system";

interface TaskWithLog extends Task {
  log?: string;
}

/** 主题：light / dark / system，持久化到 localStorage，作用于 <html data-theme> */
function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
  });

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const effective = mode === "system" ? (mql.matches ? "light" : "dark") : mode;
      document.documentElement.dataset.theme = effective;
    };
    apply();
    localStorage.setItem("theme", mode);
    if (mode === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [mode]);

  return [mode, setMode];
}

function ThemeSwitcher({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  const items: { id: ThemeMode; label: string }[] = [
    { id: "light", label: "浅色" },
    { id: "dark", label: "深色" },
    { id: "system", label: "系统" }
  ];
  return (
    <div className="theme-switch" role="group" aria-label="主题切换">
      {items.map((it) => (
        <button key={it.id} className={mode === it.id ? "active" : ""} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<HostsResponse | null>(null);
  const [tasks, setTasks] = useState<Map<string, TaskWithLog>>(new Map());
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [openLogTaskId, setOpenLogTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState<"hosts" | "catalogs">("hosts");
  const [versions, setVersions] = useState<ToolVersionsResponse | null>(null);
  const [probeHostId, setProbeHostId] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<{ host: Host; tool: ToolId } | null>(null);
  const [channelModalOpen, setChannelModalOpen] = useState(false);

  const refreshHosts = useCallback(async () => {
    try {
      setData(await api.getHosts());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    const { tasks: list } = await api.getTasks();
    setTasks((prev) => {
      const next = new Map(prev);
      for (const t of list) next.set(t.id, { ...next.get(t.id), ...t });
      return next;
    });
  }, []);

  const loadVersions = useCallback(async () => {
    try {
      setVersions(await api.getToolVersions());
    } catch {
      /* 版本缓存不可用不阻塞主界面 */
    }
  }, []);

  useEffect(() => {
    refreshHosts();
    refreshTasks();
    loadVersions();
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "log") {
        setTasks((prev) => {
          const next = new Map(prev);
          const t = next.get(msg.taskId);
          if (t) next.set(msg.taskId, { ...t, log: (t.log ?? "") + msg.chunk });
          return next;
        });
      } else if (msg.type === "task") {
        const t = msg.task as Task;
        setTasks((prev) => {
          const next = new Map(prev);
          next.set(t.id, { ...next.get(t.id), ...t });
          return next;
        });
        if (t.status !== "running" && ["check", "update", "catalog-push", "probe", "install", "cleanup", "path-repair", "auto-update"].includes(t.action)) refreshHosts();
      }
    };
    return () => es.close();
  }, [refreshHosts, refreshTasks, loadVersions]);

  const taskList = useMemo(
    () => [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30),
    [tasks]
  );

  // npm 全局目录互斥：有更新任务运行中时，禁用所有批量更新（同一时刻只允许一种工具批量）
  const updateRunning = taskList.some((t) => t.action === "update" && t.status === "running");
  const restartRunning = taskList.some((t) => t.action === "restart" && t.status === "running");

  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        alert((e as Error).message);
      }
    },
    []
  );

  /** 需要更新的主机：已安装且落后于该主机生效渠道的目标版本；未安装/超前/未知渠道目标的不纳入 */
  const updatable = useCallback(
    (h: Host, tool: ToolId): boolean => {
      if (!h.enabled || !data) return false;
      const cur = tool === "codex" ? (data.state[h.id]?.codex ?? "") : (data.state[h.id]?.claude ?? "");
      const target = data.effectiveTools?.[h.id]?.[tool]?.target ?? "";
      if (!cur || !target) return false;
      return cmpVer(cur, target) < 0;
    },
    [data]
  );

  const enabledHosts = useMemo(() => data?.hosts.filter((h) => h.enabled) ?? [], [data]);
  const selectedEnabled = useMemo(
    () => enabledHosts.filter((h) => selected.has(h.id)),
    [enabledHosts, selected]
  );

  /** 批量执行：对目标主机逐个发起任务（后端并行执行），完成后刷新任务列表消除竞态窗口 */
  const runBatch = useCallback(
    async (hosts: Host[], fn: (id: string) => Promise<unknown>) => {
      setBatchBusy(true);
      try {
        for (const h of hosts) await fn(h.id);
        await refreshTasks();
      } catch (e) {
        alert((e as Error).message);
      } finally {
        setBatchBusy(false);
      }
    },
    [refreshTasks]
  );

  const batchUpdate = (tool: ToolId, hosts: Host[]) =>
    runBatch(hosts.filter((h) => updatable(h, tool)), (id) => api.updateTool(id, tool));

  const batchRestart = (hosts: Host[]) =>
    runBatch(hosts, (id) => api.restartAppServer(id));

  const toggleSelect = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const allSelected = enabledHosts.length > 0 && selectedEnabled.length === enabledHosts.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(enabledHosts.map((h) => h.id)));

  if (!data) {
    return <div className="page"><p className="loading">加载中……{error && ` (${error})`}</p></div>;
  }

  const selCodexTargets = selectedEnabled.filter((h) => updatable(h, "codex"));
  const selClaudeTargets = selectedEnabled.filter((h) => updatable(h, "claude"));
  const allCodexTargets = enabledHosts.filter((h) => updatable(h, "codex"));
  const allClaudeTargets = enabledHosts.filter((h) => updatable(h, "claude"));

  return (
    <div className="page">
      <header className="topbar">
        <h1>AgentCliHub <span className="subtitle">Codex / Claude Code 更新管理</span></h1>
        <nav className="view-switch" role="group" aria-label="页面切换">
          <button className={view === "hosts" ? "active" : ""} onClick={() => setView("hosts")}>主机管理</button>
          <button className={view === "catalogs" ? "active" : ""} onClick={() => setView("catalogs")}>模型目录</button>
        </nav>
        <div className="topbar-actions">
          <ThemeSwitcher mode={theme} onChange={setTheme} />
          <button onClick={() => runAction(api.checkAll)}>全部检查</button>
          <button onClick={() => runAction(api.probeAll)} title="对所有已启用主机执行深度探测（候选列表、PATH 视图、自动更新现状）">全部探测</button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>

      {view === "hosts" && (
        <>
      <VersionBar versions={versions} onRefresh={() => runAction(async () => { await api.refreshToolVersions(); await loadVersions(); })} />
      <div className="batchbar">
        <label className="select-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={enabledHosts.length === 0} />
          <span>全选</span>
        </label>
        <span className="selected-count">已选 {selectedEnabled.length}/{enabledHosts.length} 台</span>
        <div className="batch-group">
          <button
            disabled={updateRunning || batchBusy || selCodexTargets.length === 0}
            title={selCodexTargets.length ? `更新选中的 ${selCodexTargets.length} 台` : "选中主机中没有可更新的 Codex"}
            onClick={() => batchUpdate("codex", selectedEnabled)}
          >更新 Codex</button>
          <button
            disabled={updateRunning || batchBusy || selClaudeTargets.length === 0}
            title={selClaudeTargets.length ? `更新选中的 ${selClaudeTargets.length} 台` : "选中主机中没有可更新的 Claude Code"}
            onClick={() => batchUpdate("claude", selectedEnabled)}
          >更新 Claude Code</button>
          <button
            className="ghost"
            disabled={restartRunning || batchBusy || selectedEnabled.length === 0}
            onClick={() => batchRestart(selectedEnabled)}
          >重启 app-server</button>
          <button
            className="ghost"
            disabled={batchBusy || (selectedEnabled.length === 0 && enabledHosts.length === 0)}
            title="批量设置安装方式（独立二进制/npm）与更新渠道（stable/latest…），写入主机覆盖配置"
            onClick={() => setChannelModalOpen(true)}
          >渠道设置</button>
        </div>
        <div className="batch-spacer" />
        <span className="batch-hint">一键全部</span>
        <div className="batch-group">
          <button
            disabled={updateRunning || batchBusy || allCodexTargets.length === 0}
            title={allCodexTargets.length ? `更新全部 ${allCodexTargets.length} 台（跳过已最新/未安装）` : "所有主机 Codex 均已最新或未安装"}
            onClick={() => batchUpdate("codex", enabledHosts)}
          >更新 Codex</button>
          <button
            disabled={updateRunning || batchBusy || allClaudeTargets.length === 0}
            title={allClaudeTargets.length ? `更新全部 ${allClaudeTargets.length} 台（跳过已最新/未安装）` : "所有主机 Claude Code 均已最新或未安装"}
            onClick={() => batchUpdate("claude", enabledHosts)}
          >更新 Claude Code</button>
          <button
            className="ghost"
            disabled={restartRunning || batchBusy || enabledHosts.length === 0}
            onClick={() => batchRestart(enabledHosts)}
          >重启 app-server</button>
        </div>
      </div>

      <table className="host-table">
        <colgroup>
          <col className="c-check" /><col className="c-host" /><col className="c-codex" /><col className="c-claude" /><col />
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>主机</th>
            <th>Codex CLI</th>
            <th>Claude Code</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {data.hosts.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              state={data.state[h.id] ?? {}}
              etools={data.effectiveTools?.[h.id]}
              tasks={taskList.filter((t) => t.hostId === h.id && t.status === "running")}
              selected={selected.has(h.id)}
              onToggleSelect={(on) => toggleSelect(h.id, on)}
              onCheck={() => runAction(() => api.checkHost(h.id))}
              onUpdate={(tool) => runAction(() => api.updateTool(h.id, tool))}
              onRestart={() => runAction(() => api.restartAppServer(h.id))}
              onEdit={() => setEditingHost(h)}
              onProbe={() => runAction(() => api.probeHost(h.id))}
              onInstall={(tool) => setInstallTarget({ host: h, tool })}
              onShowProbe={() => setProbeHostId(h.id)}
            />
          ))}
        </tbody>
      </table>
        </>
      )}

      {view === "catalogs" && (
        <Suspense fallback={<p className="loading">加载编辑器……</p>}>
          <CatalogsPage hosts={data.hosts} state={data.state} config={data.config} />
        </Suspense>
      )}

      <section className="tasks">
        <h2>任务日志</h2>
        {taskList.length === 0 && <p className="muted">暂无任务</p>}
        <ul className="task-list">
          {taskList.map((t) => (
            <li key={t.id} className={`task ${t.status}`}>
              <button className="task-head" onClick={() => setOpenLogTaskId(openLogTaskId === t.id ? null : t.id)}>
                <span className={`dot ${t.status}`} />
                <span className="task-label">{t.label}</span>
                <span className="task-summary">{t.summary}</span>
                <span className="task-time">{new Date(t.startedAt).toLocaleTimeString()}</span>
              </button>
              {openLogTaskId === t.id && <LogView taskId={t.id} liveLog={t.log} />}
            </li>
          ))}
        </ul>
      </section>

      {settingsOpen && (
        <SettingsModal
          config={data.config}
          versions={versions}
          onVersionsChanged={loadVersions}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            refreshHosts();
          }}
        />
      )}
      {channelModalOpen && (
        <BatchChannelModal
          hosts={selectedEnabled}
          allHosts={enabledHosts}
          onClose={() => setChannelModalOpen(false)}
          onSaved={() => { setChannelModalOpen(false); refreshHosts(); }}
        />
      )}
      {installTarget && (
        <InstallModal
          host={installTarget.host}
          tool={installTarget.tool}
          config={data.config}
          versions={versions?.versions}
          state={data.state[installTarget.host.id] ?? {}}
          onClose={() => setInstallTarget(null)}
        />
      )}
      {probeHostId && data.state[probeHostId]?.probe && (
        <ProbeModal
          host={data.hosts.find((h) => h.id === probeHostId)!}
          config={data.config}
          onAction={() => { setProbeHostId(null); refreshHosts(); }}
          hostName={data.hosts.find((h) => h.id === probeHostId)?.name ?? probeHostId}
          probe={data.state[probeHostId]!.probe!}
          onClose={() => setProbeHostId(null)}
        />
      )}
      {editingHost && (
        <HostEditModal
          host={editingHost}
          onClose={() => setEditingHost(null)}
          onSaved={() => {
            setEditingHost(null);
            refreshHosts();
          }}
        />
      )}
    </div>
  );
}

function HostRow(props: {
  host: Host;
  state: HostState;
  etools?: Record<ToolId, EffectiveTool>;
  tasks: TaskWithLog[];
  selected: boolean;
  onToggleSelect: (on: boolean) => void;
  onCheck: () => void;
  onUpdate: (tool: ToolId) => void;
  onRestart: () => void;
  onEdit: () => void;
  onProbe: () => void;
  onShowProbe: () => void;
  onInstall: (tool: ToolId) => void;
}) {
  const { host, state, tasks } = props;
  const busy = tasks.length > 0;
  return (
    <tr className={host.enabled ? "" : "disabled"}>
      <td>
        <input
          type="checkbox"
          checked={props.selected}
          disabled={!host.enabled}
          onChange={(e) => props.onToggleSelect(e.target.checked)}
          aria-label={`选择 ${host.name}`}
        />
      </td>
      <td>
        <div className="host-name">
          {host.name}
          {host.kind === "local" && <span className="tag">本机</span>}
          {!host.enabled && <span className="tag off">已停用</span>}
        </div>
        <div className="host-meta">
          {host.kind === "ssh" ? `${host.user}@${host.hostName}${host.port ? `:${host.port}` : ""}` : "pwsh"}
          {state.node ? ` · node ${state.node}` : ""}
          {state.checkedAt ? ` · 检查于 ${new Date(state.checkedAt).toLocaleString()}` : ""}
        </div>
      </td>
      <ToolCell
        current={state.codex}
        effective={props.etools?.codex}
        disabled={!host.enabled || busy}
        onUpdate={() => props.onUpdate("codex")}
        onInstall={() => props.onInstall("codex")}
        extra={
          <>
            <ProbeBadges state={state} tool="codex" onShow={props.onShowProbe} />
            <button className="link" disabled={!host.enabled || busy} onClick={() => props.onInstall("codex")}>安装/切换</button>
            <button
              className="restart-btn"
            disabled={!host.enabled || busy}
            onClick={props.onRestart}
            title="结束后端 codex app-server 进程，Codex desktop 重连后自动拉起新版本"
          >重启 app-server</button>
          </>
        }
      />
      <ToolCell
        current={state.claude}
        effective={props.etools?.claude}
        disabled={!host.enabled || busy}
        onUpdate={() => props.onUpdate("claude")}
        onInstall={() => props.onInstall("claude")}
        extra={<><ProbeBadges state={state} tool="claude" onShow={props.onShowProbe} /><button className="link" disabled={!host.enabled || busy} onClick={() => props.onInstall("claude")}>安装/切换</button></>}
      />
      <td className="actions-cell">
        <div className="action-row">
          <button disabled={!host.enabled || busy} onClick={props.onCheck}>检查</button>
          <button disabled={!host.enabled || busy} onClick={props.onProbe} title="只读枚举全部安装实例、PATH 视图与自动更新现状">探测</button>
          <button className="ghost" onClick={props.onEdit}>编辑</button>
        </div>
        <div className="hint-row">
          {busy && <span className="running-hint">{tasks[0].label}…</span>}
        </div>
      </td>
    </tr>
  );
}

function ToolCell(props: {
  current?: string;
  effective?: EffectiveTool;
  disabled: boolean;
  onUpdate: () => void;
  onInstall: () => void;
  extra?: React.ReactNode;
}) {
  const { current, effective } = props;
  const target = effective?.target ?? "";
  const method = effective?.method ?? "npm";
  let badge: { text: string; cls: string };
  let canUpdate = false;
  let aboveChannel = false;
  if (!current) badge = { text: "未安装", cls: "gray" };
  else if (!target) badge = { text: "渠道目标未知", cls: "gray" };
  else {
    const c = cmpVer(current, target);
    if (c === 0) badge = { text: "已是目标", cls: "green" };
    else if (c < 0) {
      badge = { text: "可更新", cls: "yellow" };
      canUpdate = true;
    } else {
      badge = { text: "高于渠道", cls: "gray" };
      aboveChannel = true;
    }
  }
  return (
    <td className="tool-cell">
      <div className="ver-row">
        <span className="ver-current">{current || "—"}</span>
        <span className="ver-latest">{canUpdate ? `→ ${target}` : ""}</span>
      </div>
      <div className="ver-actions">
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
        {!current ? (
          <button className="update-btn" disabled={props.disabled} onClick={props.onInstall}>安装</button>
        ) : canUpdate ? (
          <button
            className="update-btn"
            disabled={props.disabled}
            onClick={props.onUpdate}
            title={`方式 ${method === "standalone" ? "独立二进制" : "npm"} · 渠道 ${effective?.channel ?? "-"} · 目标 ${target}`}
          >更新</button>
        ) : aboveChannel ? (
          <button
            className="update-btn"
            disabled={props.disabled}
            onClick={props.onInstall}
            title={`当前 ${current} 高于渠道目标 ${target}；点此安装/切换到渠道版本（可换安装方式，含降级）`}
          >装渠道版</button>
        ) : (
          <button className="update-btn" disabled title="已是渠道目标版本">更新</button>
        )}
        {props.extra}
      </div>
    </td>
  );
}

function LogView({ taskId, liveLog }: { taskId: string; liveLog?: string }) {
  const [log, setLog] = useState(liveLog ?? "");
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (liveLog !== undefined) {
      setLog(liveLog);
      return;
    }
    api.getTask(taskId).then((t) => setLog(t.log));
  }, [taskId, liveLog]);

  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [log]);

  return <pre ref={ref} className="log">{log || "（暂无输出）"}</pre>;
}

function Modal(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="ghost" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

function SettingsModal(props: {
  config: Config;
  versions: ToolVersionsResponse | null;
  onVersionsChanged: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patterns, setPatterns] = useState(props.config.excludePatterns.join(", "));
  const [intervalMin, setIntervalMin] = useState(String(props.config.versions?.checkIntervalMinutes ?? 360));
  const [proxy, setProxy] = useState(props.config.download?.proxy ?? "");
  const [mirror, setMirror] = useState(props.config.download?.githubMirror ?? "");
  const [token, setToken] = useState(props.config.download?.githubToken ?? "");
  const [toolsCfg, setToolsCfg] = useState({
    codex: { method: props.config.tools?.codex?.method ?? "standalone", channel: props.config.tools?.codex?.channel ?? "latest", installDir: props.config.tools?.codex?.installDir ?? "" },
    claude: { method: props.config.tools?.claude?.method ?? "standalone", channel: props.config.tools?.claude?.channel ?? "stable", installDir: props.config.tools?.claude?.installDir ?? "" }
  });
  const [auCfg, setAuCfg] = useState({
    codex: {
      startupCheck: props.config.autoUpdate?.codex?.startupCheck ?? false,
      daemonAutoStart: props.config.autoUpdate?.codex?.daemonAutoStart ?? false,
      daemonAutoUpdate: props.config.autoUpdate?.codex?.daemonAutoUpdate ?? false,
      daemonIntervalMinutes: props.config.autoUpdate?.codex?.daemonIntervalMinutes ?? 120
    },
    claude: { disableAutoUpdater: props.config.autoUpdate?.claude?.disableAutoUpdater ?? true }
  });
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /** 保存设置；applyNow 时随后立即把自动更新设置写到所有已启用主机 */
  const save = async (applyNow = false) => {
    setSaving(true);
    try {
      await api.saveSettings({
        excludePatterns: patterns.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        versions: { checkIntervalMinutes: Number(intervalMin) || 360 },
        download: { proxy, githubMirror: mirror, githubToken: token },
        tools: toolsCfg,
        autoUpdate: auCfg
      });
      if (applyNow) await api.autoUpdateAll();
      props.onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await api.refreshToolVersions();
      props.onVersionsChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const v = props.versions?.versions;
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "从未");
  return (
    <Modal title="设置" onClose={props.onClose}>
      <label className="field">
        <span>主机排除模式（逗号分隔，支持 * 通配）</span>
        <input value={patterns} onChange={(e) => setPatterns(e.target.value)} />
      </label>

      <fieldset className="field-group">
        <legend>版本号缓存（只有本机查外网，远程主机不查）</legend>
        <div className="kv muted">
          codex 最新：{v?.codex?.latest ?? "未知"}{v?.codex?.stale ? "（获取失败，沿用旧值）" : ""}
          {v?.codex?.source ? ` · 源 ${v.codex.source}` : ""}
          <br />
          claude 最新：{v?.claude?.latest ?? "未知"}（stable {v?.claude?.stable ?? "未知"}）
          {v?.claude?.stale ? "（获取失败，沿用旧值）" : ""}
          <br />
          上次检查：{fmt(v?.fetchedAt)}
          <button className="link" onClick={refreshNow} disabled={refreshing}>{refreshing ? "刷新中…" : "立即刷新"}</button>
        </div>
        <label className="field">
          <span>检查间隔（分钟，默认 360 = 6 小时；启动时按上次检查时间决定是否检查）</span>
          <input type="number" min={5} value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>外网出口</legend>
        <label className="field">
          <span>代理模板（透传 curl --proxy，留空直连；例 socks5h://127.0.0.1:8888，认证内嵌 socks5h://user:pass@host:port）</span>
          <input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="socks5h://127.0.0.1:8888" />
        </label>
        <label className="field">
          <span>GitHub 镜像前缀（可选，用于下载加速）</span>
          <input value={mirror} onChange={(e) => setMirror(e.target.value)} placeholder="https://ghproxy.net/" />
        </label>
        <label className="field">
          <span>GitHub Token（可选，提高 api.github.com 限额；仅存本机 config.json）</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>默认安装策略（安装目录可在主机「编辑」里按主机覆盖）</legend>
        {(["codex", "claude"] as const).map((t) => (
          <div key={t} className="kv" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <strong style={{ width: 90 }}>{t === "codex" ? "Codex CLI" : "Claude Code"}</strong>
            <label>方式
              <select value={toolsCfg[t].method} onChange={(e) => setToolsCfg({ ...toolsCfg, [t]: { ...toolsCfg[t], method: e.target.value as "standalone" | "npm" } })}>
                <option value="standalone">独立二进制</option>
                <option value="npm">npm（兜底）</option>
              </select>
            </label>
            <label>通道
              <select
                value={["latest", "stable", "prerelease"].includes(toolsCfg[t].channel) ? toolsCfg[t].channel : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  setToolsCfg({ ...toolsCfg, [t]: { ...toolsCfg[t], channel: v === "custom" ? "" : v } });
                }}
              >
                {t === "codex"
                  ? <><option value="stable">stable（稳定线）</option><option value="latest">latest（同稳定线）</option><option value="prerelease">prerelease（预发布）</option></>
                  : <><option value="stable">stable（约慢一周）</option><option value="latest">latest</option></>}
                <option value="custom">自定义版本号…</option>
              </select>
            </label>
            {!["latest", "stable", "prerelease"].includes(toolsCfg[t].channel) && (
              <input style={{ width: 110 }} placeholder="x.y.z" value={toolsCfg[t].channel}
                onChange={(e) => setToolsCfg({ ...toolsCfg, [t]: { ...toolsCfg[t], channel: e.target.value.trim() } })} />
            )}
            <label>安装目录
              <input style={{ width: 220 }} value={toolsCfg[t].installDir} placeholder="~/.local/bin"
                onChange={(e) => setToolsCfg({ ...toolsCfg, [t]: { ...toolsCfg[t], installDir: e.target.value } })} />
            </label>
          </div>
        ))}
      </fieldset>

      <fieldset className="field-group">
        <legend>官方自动更新接管（默认全禁，由 hub 统一更新；安装时会自动写入，也可随时立即应用）</legend>
        <label className="field inline">
          <input type="checkbox" checked={auCfg.codex.startupCheck} onChange={(e) => setAuCfg({ ...auCfg, codex: { ...auCfg.codex, startupCheck: e.target.checked } })} />
          <span>codex 启动时检查更新提示（关闭可避免 TUI 弹窗）</span>
        </label>
        <label className="field inline">
          <input type="checkbox" checked={auCfg.codex.daemonAutoStart} onChange={(e) => setAuCfg({ ...auCfg, codex: { ...auCfg.codex, daemonAutoStart: e.target.checked } })} />
          <span>codex 交互启动时自动拉起 daemon</span>
        </label>
        <label className="field inline">
          <input type="checkbox" checked={auCfg.codex.daemonAutoUpdate} onChange={(e) => setAuCfg({ ...auCfg, codex: { ...auCfg.codex, daemonAutoUpdate: e.target.checked } })} />
          <span>codex daemon 自动更新（pid-update-loop）</span>
        </label>
        <label className="field">
          <span>daemon 更新检查间隔（分钟）</span>
          <input type="number" min={15} value={auCfg.codex.daemonIntervalMinutes}
            onChange={(e) => setAuCfg({ ...auCfg, codex: { ...auCfg.codex, daemonIntervalMinutes: Number(e.target.value) || 120 } })} />
        </label>
        <label className="field inline">
          <input type="checkbox" checked={auCfg.claude.disableAutoUpdater} onChange={(e) => setAuCfg({ ...auCfg, claude: { disableAutoUpdater: e.target.checked } })} />
          <span>禁用 claude 后台静默自动更新（DISABLE_AUTOUPDATER=1）</span>
        </label>
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <button className="ghost" disabled={saving}
            title="先保存当前设置，再把上述开关写入所有已启用主机的 codex / claude 配置（内容已匹配则不改；写前自动备份 .agentclihub.bak）"
            onClick={() => {
              if (confirm("保存设置，并立即把官方自动更新开关应用到所有已启用主机？\n将改写各机 ~/.codex/config.toml、app-server-daemon/settings.json 和 ~/.claude/settings.json（已匹配的不改，写前自动备份）。")) save(true);
            }}
          >保存并立即应用到所有主机</button>
        </div>
      </fieldset>

      <div className="modal-actions">
        <button onClick={() => save()} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </Modal>
  );
}

function HostEditModal(props: { host: Host; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(props.host.enabled);
  const [prelude, setPrelude] = useState(props.host.prelude);
  const [note, setNote] = useState(props.host.note);
  const [installDir, setInstallDir] = useState(props.host.installDir ?? "");
  const [preferRelay, setPreferRelay] = useState(props.host.preferRelay ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveHostOverride(props.host.id, { enabled, prelude, note, installDir, preferRelay });
      props.onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`编辑主机：${props.host.name}`} onClose={props.onClose}>
      <label className="field inline">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>纳入管理</span>
      </label>
      {props.host.kind === "ssh" && (
        <label className="field">
          <span>Shell prelude（远程命令前执行；留空则仅使用 nvm 自动探测）</span>
          <textarea rows={6} value={prelude} onChange={(e) => setPrelude(e.target.value)}
            placeholder={"export NVM_DIR=...\nsource <(curl -sSL ...)  # 代理"} />
        </label>
      )}
      <label className="field">
        <span>安装目录覆盖（两工具共用；留空用全局默认 ~/.local/bin；例 /mnt/shared/bin）</span>
        <input value={installDir} onChange={(e) => setInstallDir(e.target.value)} placeholder="~/.local/bin" />
      </label>
      <label className="field inline">
        <input type="checkbox" checked={preferRelay} onChange={(e) => setPreferRelay(e.target.checked)} />
        <span>强制走 hub 中转下载（直连慢/不通的内网主机）</span>
      </label>
      <label className="field">
        <span>备注</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </Modal>
  );
}

// ---------- M1：版本缓存条与深度探测 ----------

const METHOD_LABELS: Record<string, { text: string; cls: string }> = {
  "standalone-official": { text: "独立", cls: "green" },
  "standalone-daemon": { text: "daemon", cls: "green" },
  "standalone-entry": { text: "独立·入口", cls: "green" },
  "npm-global": { text: "npm", cls: "gray" },
  "npm-local": { text: "npm本地", cls: "gray" },
  "desktop-bundled": { text: "桌面版", cls: "yellow" },
  unknown: { text: "未知", cls: "gray" }
};

function VersionBar(props: { versions: ToolVersionsResponse | null; onRefresh: () => void }) {
  if (!props.versions) return null;
  const v = props.versions.versions;
  const ago = v.fetchedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(v.fetchedAt)) / 60000))} 分钟前` : "从未";
  return (
    <div className="version-bar">
      <span className="muted">版本缓存</span>
      <span>codex {v.codex?.latest ?? "未知"}{v.codex?.prerelease ? `（预发布 ${v.codex.prerelease}）` : ""}{v.codex?.stale ? " *" : ""}</span>
      <span>claude stable {v.claude?.stable ?? "未知"} / latest {v.claude?.latest ?? "未知"}{v.claude?.stale ? " *" : ""}</span>
      <span className="muted">更新于 {ago} · 每 {props.versions.checkIntervalMinutes} 分钟检查</span>
      <button className="link" onClick={props.onRefresh}>立即刷新</button>
    </div>
  );
}

/** 工具单元格里的探测徽标：生效实例的安装方式 + 候选数量入口 */
function ProbeBadges(props: { state: HostState; tool: ToolId; onShow: () => void }) {
  const probe = props.state.probe;
  if (!probe) return null;
  const cands = probe.candidates.filter((c) => c.tool === props.tool);
  if (!cands.length) return null;
  const active = cands.find((c) => c.activeInShell);
  const m = METHOD_LABELS[active?.method ?? "unknown"];
  return (
    <>
      {active && <span className={`badge ${m.cls}`} title={active.path}>{m.text}</span>}
      <button className="link" onClick={props.onShow} title="查看全部安装候选与 PATH 实况">候选×{cands.length}</button>
    </>
  );
}

const CTX_LABELS: Record<string, string> = { shell: "当前 shell", login: "登录 shell", interactive: "交互 shell" };

function ProbeModal(props: { host: Host; config: Config; onAction: () => void; hostName: string; probe: ProbeResult; onClose: () => void }) {
  const p = props.probe;
  const kv = (label: string, value?: string) =>
    value ? <div><span className="muted">{label}</span> <code>{value}</code></div> : null;
  const hitEntries = p.pathEntries.filter((e) => e.codex || e.claude);
  return (
    <Modal title={`探测结果：${props.hostName}`} onClose={props.onClose}>
      <div className="probe">
        <p className="muted">探测于 {new Date(p.probedAt).toLocaleString()}{p.done ? "" : "（未完整结束，结果可能不全）"}</p>

        <h4>环境</h4>
        <div className="kv">
          {kv("HOME", p.meta.home)}{kv("shell", p.meta.shell)}{kv("系统", p.meta.uname)}
          {kv("node", p.meta.node)}{kv("npm 全局目录", p.meta.npmRoot)}
          {kv("~/.codex 实际路径", p.meta.codexHomeReal)}
        </div>

        <h4>命令解析（PATH 生效顺序）</h4>
        <div className="kv">
          {(["shell", "login", "interactive"] as const).map((ctx) =>
            p.contexts?.[ctx] ? (
              <div key={ctx}>
                <span className="muted">{CTX_LABELS[ctx]}</span>{" "}
                codex → <code>{p.contexts[ctx].codex || "（未找到）"}</code>，
                claude → <code>{p.contexts[ctx].claude || "（未找到）"}</code>
              </div>
            ) : null
          )}
        </div>

        <h4>安装候选（{p.candidates.length}）</h4>
        {p.candidates.length === 0 ? <p className="muted">未发现任何安装</p> : (
          <table className="probe-table">
            <thead><tr><th>工具</th><th>版本</th><th>方式</th><th>路径</th><th>实际指向</th></tr></thead>
            <tbody>
              {p.candidates.map((c) => {
                const m = METHOD_LABELS[c.method] ?? METHOD_LABELS.unknown;
                return (
                  <tr key={c.path}>
                    <td>{c.tool}{c.activeInShell ? " ●" : ""}</td>
                    <td>{c.version || "—"}</td>
                    <td><span className={`badge ${m.cls}`}>{m.text}</span>{c.shared && <span className="badge yellow">共享盘</span>}</td>
                    <td><code>{c.path}</code></td>
                    <td><code className="muted">{c.realPath}</code></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h4>PATH 命中（{hitEntries.length}/{p.pathEntries.length}）</h4>
        {hitEntries.length === 0 ? <p className="muted">当前 PATH 中没有 codex/claude</p> : (
          <table className="probe-table">
            <thead><tr><th>#</th><th>目录</th><th>codex</th><th>claude</th></tr></thead>
            <tbody>
              {hitEntries.map((e) => (
                <tr key={e.index}><td>{e.index}</td><td><code>{e.dir}</code></td><td>{e.codex ? "✓" : ""}</td><td>{e.claude ? "✓" : ""}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        <h4>官方自动更新现状</h4>
        <div className="kv">
          {kv("codex 启动检查", p.autoUpdate.codexCfgStartupCheck)}
          {kv("codex daemon 自启", p.autoUpdate.codexCfgDaemonAutoStart)}
          {kv("codex daemon 设置", p.autoUpdate.codexDaemonSettings)}
          {kv("claude 设置", p.autoUpdate.claudeSettings)}
        </div>

        {p.procs && (
          <>
            <h4>相关进程</h4>
            <pre className="log small">{p.procs.split(";").filter(Boolean).join("\n")}</pre>
          </>
        )}
        <div className="modal-actions">
          <button className="ghost"
            title="把设置里的官方自动更新开关写入该主机的 codex / claude 配置（内容已匹配则不改，写前自动备份）"
            onClick={() => {
              if (confirm(`把官方自动更新设置应用到 ${props.hostName}？\n改写 ~/.codex/config.toml、app-server-daemon/settings.json 和 ~/.claude/settings.json（已匹配的不改，写前自动备份）。`)) {
                api.autoUpdateHost(props.host.id).then(props.onAction).catch((e) => alert((e as Error).message));
              }
            }}
          >应用自动更新设置</button>
          {(["codex", "claude"] as const).map((t) => {
            const hasLib = t === "codex" ? p.pkgRoots.some((r) => r.sub === "standalone") : p.meta.claudeVersionsDir !== "(absent)";
            return (
              <button key={t} className="ghost" disabled={!hasLib}
                title={hasLib ? `清理 ${t} 旧版本（保留 current + 最新 2 个，跳过运行中）` : "无 standalone 版本库"}
                onClick={() => {
                  if (confirm(`清理 ${t} 的旧版本？\n保留 current 指向与最新 2 个，跳过正在运行的版本。`)) {
                    api.cleanupTool(props.host.id, t, 2).then(props.onAction).catch((e) => alert((e as Error).message));
                  }
                }}
              >清理 {t} 旧版本</button>
            );
          })}
          <button className="ghost"
            title="把安装目录以去重置顶块写入 shell rc（远程）或注册表用户 PATH（本机），含备份"
            onClick={() => {
              const dir = props.host.installDir || props.config.tools.codex.installDir || "~/.local/bin";
              if (confirm(`PATH 修复：将安装目录（${dir}）去重置顶到 PATH？\n远程写入 ~/.profile 与 shell rc（幂等块，自动备份）；本机写注册表用户 PATH（备份到 data/path-backups/）。\n新开的终端生效。`)) {
                api.pathRepair(props.host.id, "codex").then(props.onAction).catch((e) => alert((e as Error).message));
              }
            }}
          >PATH 修复（安装目录置顶）</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- M2：安装/切换弹窗（standalone 默认，含 PATH 预检） ----------

const VERSION_CHANNELS: Record<ToolId, { value: string; label: string }[]> = {
  codex: [
    { value: "stable", label: "stable（稳定线）" },
    { value: "latest", label: "latest（同稳定线）" },
    { value: "prerelease", label: "prerelease（预发布）" }
  ],
  claude: [
    { value: "stable", label: "stable（约慢一周）" },
    { value: "latest", label: "latest" }
  ]
};

function InstallModal(props: {
  host: Host;
  tool: ToolId;
  config: Config;
  versions: ToolVersions | undefined;
  state: HostState;
  onClose: () => void;
}) {
  const { host, tool } = props;
  const toolCfg = props.config.tools?.[tool];
  const [method, setMethod] = useState<"standalone" | "npm">(toolCfg?.method ?? "standalone");
  const [channel, setChannel] = useState(toolCfg?.channel || (tool === "claude" ? "stable" : "latest"));
  const [customVersion, setCustomVersion] = useState("");
  const [installDir, setInstallDir] = useState(host.installDir || toolCfg?.installDir || "~/.local/bin");
  const [pf, setPf] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);

  const versionSpec = channel === "custom" ? customVersion.trim() : channel;
  const v = props.versions;
  const resolvedHint = (() => {
    if (channel === "custom") return customVersion.trim() || "（未填）";
    if (tool === "codex") {
      if (channel === "latest" || channel === "stable") return v?.codex?.latest ? v.codex.latest : "未知（先刷新版本缓存）";
      if (channel === "prerelease") return v?.codex?.prerelease ?? "未知";
    } else {
      if (channel === "stable") return v?.claude?.stable ?? "未知";
      if (channel === "latest") return v?.claude?.latest ?? "未知";
    }
    return "";
  })();

  const active = props.state.probe?.contexts?.shell?.[tool] ?? "";

  const doPreflight = async () => {
    setBusy(true);
    try {
      setPf(await api.preflight(host.id, tool, installDir));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (method === "standalone" && !versionSpec) return alert("请选择版本通道或填写版本号");
    if (method === "standalone" && channel === "custom" && !/^\d+\.\d+\.\d+(-(alpha|beta)[\d.]*)?$/.test(customVersion.trim()))
      return alert("版本号格式不正确（x.y.z 或 x.y.z-alpha.N）");
    if (pf?.status === "not-on-path") {
      if (!confirm(`警告：${pf.installDir} 不在 PATH 中，安装后无法直接调用。${"\n"}可先在探测详情里做「PATH 修复」。仍要继续安装吗？`)) return;
    } else if (pf?.status === "shadowed") {
      const list = pf.shadowedBy!.map((x) => `#${x.index} ${x.dir}（${x.version || "版本未知"}）`).join("\n");
      if (!confirm(`警告：以下 PATH 条目排在安装目录之前且含同名程序，新安装会被遮蔽：\n${list}\n\n仍要继续安装吗？`)) return;
    }
    if (pf?.sharedWarning && !confirm(`共享挂载警告：${pf.sharedWarning}\n\n仍要继续吗？`)) return;
    setBusy(true);
    try {
      await api.installTool(host.id, {
        tool,
        method,
        version: method === "standalone" ? versionSpec : undefined,
        installDir: method === "standalone" ? installDir : undefined
      });
      props.onClose();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`安装/切换：${host.name} · ${tool === "codex" ? "Codex CLI" : "Claude Code"}`} onClose={props.onClose}>
      {active && <p className="kv muted">当前生效：<code>{active}</code></p>}
      <div className="kv" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <label>方式
          <select value={method} onChange={(e) => setMethod(e.target.value as "standalone" | "npm")}>
            <option value="standalone">独立二进制（推荐）</option>
            <option value="npm">npm（兜底）</option>
          </select>
        </label>
        {method === "standalone" && (
          <>
            <label>版本
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {VERSION_CHANNELS[tool].map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                <option value="custom">自定义版本号…</option>
              </select>
            </label>
            {channel === "custom" && (
              <input style={{ width: 130 }} placeholder="x.y.z" value={customVersion} onChange={(e) => setCustomVersion(e.target.value)} />
            )}
            <span className="muted">→ {resolvedHint}</span>
          </>
        )}
      </div>
      {method === "standalone" && (
        <>
          <label className="field">
            <span>安装目录（入口链接位置；版本库固定在官方目录）</span>
            <input value={installDir} onChange={(e) => { setInstallDir(e.target.value); setPf(null); }} placeholder="~/.local/bin" />
          </label>
          <div className="kv">
            <button className="ghost" onClick={doPreflight} disabled={busy}>{busy ? "检查中…" : "PATH 预检"}</button>
            {pf && (
              <div style={{ marginTop: 6 }}>
                {pf.status === "need-probe" && <span className="badge yellow">{pf.reason}</span>}
                {pf.status === "not-on-path" && <span className="badge red">不在 PATH：{pf.reason}</span>}
                {pf.status === "ok" && <span className="badge green">PATH 第 {pf.position}/{pf.totalEntries} 位，无遮蔽</span>}
                {pf.status === "shadowed" && <span className="badge yellow">被遮蔽（{CTX_LABELS[pf.shadowedContext ?? ""] ?? pf.shadowedContext}）</span>}
                {pf.status === "shadowed" && pf.shadowedBy!.length > 0 && (
                  <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                    {pf.shadowedBy!.map((x) => <li key={x.dir}><code>#{x.index} {x.dir}</code>（{x.version || "版本未知"}）</li>)}
                  </ul>
                )}
                {pf.contexts && pf.contexts.length > 0 && (
                  <div className="kv muted" style={{ marginTop: 4 }}>
                    {pf.contexts.map((c) => (
                      <div key={c.name}>
                        {CTX_LABELS[c.name] ?? c.name}：
                        {c.position < 0 ? "不在 PATH" : `PATH 第 ${c.position}/${c.total} 位`}
                        {c.resolved ? `，生效 → ${c.resolved}` : ""}
                        {c.shadowedBy.length > 0 ? "（遮蔽）" : ""}
                      </div>
                    ))}
                  </div>
                )}
                {pf.sharedWarning && <div className="badge yellow" style={{ marginTop: 4 }}>{pf.sharedWarning}</div>}
              </div>
            )}
          </div>
          <p className="muted kv">安装后由 hub 接管官方自动更新（当前默认：全部禁用，含 codex 启动提示与 claude 后台静默更新；在设置页可调整）。固定版本号时 claude 会写入 minimumVersion 防止漂移。</p>
        </>
      )}
      <div className="modal-actions">
        <button onClick={install} disabled={busy}>{busy ? "提交中…" : "开始安装"}</button>
      </div>
    </Modal>
  );
}

// ---------- 批量渠道设置 ----------

function BatchChannelModal(props: {
  hosts: Host[];
  allHosts: Host[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tool, setTool] = useState<ToolId>("codex");
  const [method, setMethod] = useState<"" | "standalone" | "npm">("");
  const [channel, setChannel] = useState("");
  const [custom, setCustom] = useState("");
  const [scope, setScope] = useState<"selected" | "all">("selected");
  const [busy, setBusy] = useState(false);
  const targets = scope === "selected" ? props.hosts : props.allHosts;
  const channelOptions = tool === "codex" ? ["stable", "latest", "prerelease"] : ["stable", "latest"];
  const effectiveChannel = channel === "custom" ? custom.trim() : channel;

  const save = async () => {
    if (!method && !effectiveChannel) return alert("请至少选择一项要设置的内容（方式或渠道）");
    setBusy(true);
    try {
      await api.setToolsConfig(
        targets.map((h) => h.id),
        tool,
        method || undefined,
        effectiveChannel || undefined
      );
      props.onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="批量渠道设置" onClose={props.onClose}>
      <div className="kv" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <label>工具
          <select value={tool} onChange={(e) => { setTool(e.target.value as ToolId); setChannel(""); }}>
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>安装方式
          <select value={method} onChange={(e) => setMethod(e.target.value as "" | "standalone" | "npm")}>
            <option value="">（不变）</option>
            <option value="standalone">独立二进制</option>
            <option value="npm">npm</option>
          </select>
        </label>
        <label>更新渠道
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">（不变）</option>
            {channelOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="custom">自定义版本号…</option>
          </select>
        </label>
        {channel === "custom" && (
          <input style={{ width: 130 }} placeholder="x.y.z" value={custom} onChange={(e) => setCustom(e.target.value)} />
        )}
      </div>
      <div className="kv" style={{ marginTop: 10 }}>
        <label className="field inline">
          <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} disabled={props.hosts.length === 0} />
          <span>选中主机（{props.hosts.length} 台）</span>
        </label>
        <label className="field inline">
          <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
          <span>全部启用主机（{props.allHosts.length} 台）</span>
        </label>
      </div>
      <p className="muted kv">写入各主机的覆盖配置（hostOverrides）。全局默认值请在设置页修改。</p>
      <div className="modal-actions">
        <button onClick={save} disabled={busy || targets.length === 0}>{busy ? "保存中…" : `应用到 ${targets.length} 台`}</button>
      </div>
    </Modal>
  );
}
