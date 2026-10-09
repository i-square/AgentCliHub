import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
// CodeMirror 体积较大，目录页按需加载
const CatalogsPage = lazy(() => import("./CatalogsPage"));
import type { Host, HostState, HostsResponse, Task } from "./types";

type ToolId = "codex" | "claude";
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

  useEffect(() => {
    refreshHosts();
    refreshTasks();
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
        if (t.status !== "running" && ["check", "update", "catalog-push"].includes(t.action)) refreshHosts();
      }
    };
    return () => es.close();
  }, [refreshHosts, refreshTasks]);

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

  /** 需要更新的主机：已安装且（未知最新版或版本落后）；未检查/未安装的不纳入"全部更新" */
  const updatable = useCallback(
    (h: Host, tool: ToolId): boolean => {
      if (!h.enabled || !data) return false;
      const s: HostState = data.state[h.id] ?? {};
      const cur = tool === "codex" ? s.codex : s.claude;
      const lat = tool === "codex" ? s.latestCodex : s.latestClaude;
      return !!cur && cur !== lat;
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
          <button className="ghost" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>

      {view === "hosts" && (
        <>
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
              tasks={taskList.filter((t) => t.hostId === h.id && t.status === "running")}
              selected={selected.has(h.id)}
              onToggleSelect={(on) => toggleSelect(h.id, on)}
              onCheck={() => runAction(() => api.checkHost(h.id))}
              onUpdate={(tool) => runAction(() => api.updateTool(h.id, tool))}
              onRestart={() => runAction(() => api.restartAppServer(h.id))}
              onEdit={() => setEditingHost(h)}
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
          excludePatterns={data.config.excludePatterns}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            refreshHosts();
          }}
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
  tasks: TaskWithLog[];
  selected: boolean;
  onToggleSelect: (on: boolean) => void;
  onCheck: () => void;
  onUpdate: (tool: ToolId) => void;
  onRestart: () => void;
  onEdit: () => void;
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
        latest={state.latestCodex}
        disabled={!host.enabled || busy}
        onUpdate={() => props.onUpdate("codex")}
        extra={
          <button
            className="restart-btn"
            disabled={!host.enabled || busy}
            onClick={props.onRestart}
            title="结束后端 codex app-server 进程，Codex desktop 重连后自动拉起新版本"
          >重启 app-server</button>
        }
      />
      <ToolCell
        current={state.claude}
        latest={state.latestClaude}
        disabled={!host.enabled || busy}
        onUpdate={() => props.onUpdate("claude")}
      />
      <td className="actions-cell">
        <div className="action-row">
          <button disabled={!host.enabled || busy} onClick={props.onCheck}>检查</button>
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
  latest?: string;
  disabled: boolean;
  onUpdate: () => void;
  extra?: React.ReactNode;
}) {
  const { current, latest } = props;
  let badge: { text: string; cls: string };
  if (!current) badge = { text: "未安装", cls: "gray" };
  else if (!latest) badge = { text: "最新版未知", cls: "gray" };
  else if (current === latest) badge = { text: "已是最新", cls: "green" };
  else badge = { text: "可更新", cls: "yellow" };
  const hasUpdate = !!latest && latest !== current;
  return (
    <td>
      <div className="ver-row">
        <span className="ver-current">{current || "—"}</span>
        <span className="ver-latest">{hasUpdate ? `→ ${latest}` : ""}</span>
      </div>
      <div className="ver-actions">
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
        <button className="update-btn" disabled={props.disabled || (!!current && current === latest)} onClick={props.onUpdate}>
          {current ? "更新" : "安装"}
        </button>
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
        {props.children}
      </div>
    </div>
  );
}

function SettingsModal(props: {
  excludePatterns: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patterns, setPatterns] = useState(props.excludePatterns.join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        excludePatterns: patterns.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      });
      props.onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="设置" onClose={props.onClose}>
      <label className="field">
        <span>主机排除模式（逗号分隔，支持 * 通配）</span>
        <input value={patterns} onChange={(e) => setPatterns(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </Modal>
  );
}

function HostEditModal(props: { host: Host; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(props.host.enabled);
  const [prelude, setPrelude] = useState(props.host.prelude);
  const [note, setNote] = useState(props.host.note);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveHostOverride(props.host.id, { enabled, prelude, note });
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
        <span>备注</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </Modal>
  );
}
