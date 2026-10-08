import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Host, HostState, HostsResponse, Task } from "./types";

type ToolId = "codex" | "claude";

interface TaskWithLog extends Task {
  log?: string;
}

export default function App() {
  const [data, setData] = useState<HostsResponse | null>(null);
  const [tasks, setTasks] = useState<Map<string, TaskWithLog>>(new Map());
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [openLogTaskId, setOpenLogTaskId] = useState<string | null>(null);

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
        if (t.status !== "running" && (t.action === "check" || t.action === "update")) refreshHosts();
      }
    };
    return () => es.close();
  }, [refreshHosts, refreshTasks]);

  const taskList = useMemo(
    () => [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30),
    [tasks]
  );

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

  if (!data) {
    return <div className="page"><p className="loading">加载中……{error && ` (${error})`}</p></div>;
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>CodexHub <span className="subtitle">Codex / Claude Code 更新管理</span></h1>
        <div className="topbar-actions">
          <button onClick={() => runAction(api.checkAll)}>全部检查</button>
          <button className="ghost" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>

      <table className="host-table">
        <thead>
          <tr>
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
              onCheck={() => runAction(() => api.checkHost(h.id))}
              onUpdate={(tool) => runAction(() => api.updateTool(h.id, tool))}
              onRestart={() => runAction(() => api.restartAppServer(h.id))}
              onEdit={() => setEditingHost(h)}
            />
          ))}
        </tbody>
      </table>

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
          installMethod={data.config.installMethod}
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
      />
      <ToolCell
        current={state.claude}
        latest={state.latestClaude}
        disabled={!host.enabled || busy}
        onUpdate={() => props.onUpdate("claude")}
      />
      <td className="actions">
        <button disabled={!host.enabled || busy} onClick={props.onCheck}>检查</button>
        <button disabled={!host.enabled || busy} onClick={props.onRestart} title="结束后端 codex app-server 进程，Codex desktop 重连后自动拉起新版本">
          重启 app-server
        </button>
        <button className="ghost" onClick={props.onEdit}>编辑</button>
        {busy && <span className="running-hint">{tasks[0].label}…</span>}
      </td>
    </tr>
  );
}

function ToolCell(props: { current?: string; latest?: string; disabled: boolean; onUpdate: () => void }) {
  const { current, latest } = props;
  let badge: { text: string; cls: string };
  if (!current) badge = { text: "未安装", cls: "gray" };
  else if (!latest) badge = { text: "最新版未知", cls: "gray" };
  else if (current === latest) badge = { text: "已是最新", cls: "green" };
  else badge = { text: "可更新", cls: "yellow" };
  return (
    <td>
      <div className="ver">
        <span className="ver-current">{current || "—"}</span>
        {latest && latest !== current && <span className="ver-latest">→ {latest}</span>}
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>
      <button className="update-btn" disabled={props.disabled || (!!current && current === latest)} onClick={props.onUpdate}>
        {current ? "更新" : "安装"}
      </button>
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
  installMethod: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patterns, setPatterns] = useState(props.excludePatterns.join(", "));
  const [method, setMethod] = useState(props.installMethod);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        excludePatterns: patterns.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        installMethod: method
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
      <label className="field">
        <span>安装方式</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="npm">npm（推荐，沿用现有 npm/nvm 管理）</option>
          <option value="standalone" disabled>standalone（未实现；旧版会下载二进制并修改 PATH）</option>
        </select>
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
            placeholder={'export NVM_DIR=...\nsource <(curl -sSL ...)  # 代理'} />
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
