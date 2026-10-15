// 任务管理：内存保存最近任务（SSE 推送日志与状态），并持久化到 data/tasks.json。
// 持久化的目的是服务重启（崩溃/OOM/手动重启）后不丢失任务历史：重启时仍为 running 的任务
// 一定已随进程死亡，恢复时统一标记为 interrupted，而不是无声消失或永远显示「进行中」。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const MAX_TASKS = 100;
const MAX_LOG_CHARS = 300_000;
const MAX_PERSIST_LOG_CHARS = 30_000; // 落盘只留日志尾部，够排查，文件不会膨胀
const PERSIST_DEBOUNCE_MS = 1500;
const SCHEMA_VERSION = 1;
const tasksFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "tasks.json");

/**
 * 任务状态机：
 *   running ──► success | error          （正常结束）
 *   running ──► interrupted              （进程重启/停止时仍在运行；恢复时或优雅退出时标记）
 *
 * 落盘记录结构（data/tasks.json → { version, savedAt, tasks: PersistedTask[] }）：
 *   id, hostId, action, label        任务标识
 *   status                           见上
 *   startedAt, endedAt, updatedAt    ISO 时间；updatedAt = 最后一次有日志输出的时间（interrupted 的 endedAt 取它）
 *   summary                          结果摘要 / 中断原因
 *   progress                         最后一行非空日志（如「下载中… 45%」），用于展示中断时进行到哪
 *   log                              日志尾部（≤ 30000 字符）
 */

export class TaskManager extends EventEmitter {
  #tasks = new Map();
  #seq = 0;
  #timer = null;
  #hostLocks = new Map(); // hostId → { tail: Promise, n: 排队+运行中的任务数 }

  /**
   * 同一主机的写操作串行执行（install/update/cleanup/path-repair 共用暂存目录与 current 链接，不能并发）。
   * 排队而不是报错：批量更新遇到忙碌主机时不会中断其余主机。
   */
  async withHostLock(hostId, onWait, fn) {
    const lock = this.#hostLocks.get(hostId) ?? { tail: Promise.resolve(), n: 0 };
    this.#hostLocks.set(hostId, lock);
    const prev = lock.tail;
    let release;
    lock.tail = new Promise((r) => (release = r));
    if (lock.n > 0) onWait();
    lock.n++;
    try {
      await prev;
      return await fn();
    } finally {
      lock.n--;
      release();
      if (lock.n === 0) this.#hostLocks.delete(hostId);
    }
  }

  constructor() {
    super();
    this.#restore();
  }

  /** 启动时从磁盘恢复；上次进程退出时仍为 running 的任务标记为 interrupted */
  #restore() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    } catch {
      return; // 无文件或损坏：从空开始
    }
    if (saved?.version !== SCHEMA_VERSION || !Array.isArray(saved.tasks)) return;
    let changed = false;
    for (const t of saved.tasks) {
      if (!t?.id || !t.hostId || !t.action) continue;
      if (t.status === "running") {
        const where = t.progress ? `，中断前进度：${t.progress}` : "";
        this.#markInterrupted(t, `服务重启时任务仍在运行，已中断${where}`, t.updatedAt);
        changed = true;
      }
      this.#tasks.set(t.id, { log: "", progress: "", updatedAt: t.startedAt, ...t });
    }
    if (changed) this.#flush();
  }

  #markInterrupted(t, reason, endedAt) {
    t.status = "interrupted";
    t.endedAt = endedAt || new Date().toISOString();
    t.summary = reason;
    t.log = ((t.log ?? "") + `\n[interrupted] ${reason}\n`).slice(-MAX_LOG_CHARS);
  }

  /** 优雅停止（SIGINT/SIGTERM）时调用：把仍在运行的任务标记为 interrupted 并立即落盘 */
  interruptRunning(reason) {
    for (const t of this.#tasks.values()) {
      if (t.status === "running") this.#markInterrupted(t, reason, new Date().toISOString());
    }
    this.#flush();
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#flush(), PERSIST_DEBOUNCE_MS);
    this.#timer.unref?.();
  }

  #flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      const tasks = [...this.#tasks.values()].map((t) => ({
        id: t.id,
        hostId: t.hostId,
        action: t.action,
        label: t.label,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        updatedAt: t.updatedAt,
        summary: t.summary,
        progress: t.progress,
        log: (t.log ?? "").slice(-MAX_PERSIST_LOG_CHARS)
      }));
      fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
      const tmp = `${tasksFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: SCHEMA_VERSION, savedAt: new Date().toISOString(), tasks }));
      fs.renameSync(tmp, tasksFile);
    } catch (e) {
      console.error("[tasks] 持久化失败:", e.message); // 持久化失败不应影响任务本身
    }
  }

  create({ hostId, action, label }) {
    const task = {
      id: `t${Date.now()}-${++this.#seq}`,
      hostId,
      action,
      label,
      status: "running",
      log: "",
      startedAt: new Date().toISOString(),
      endedAt: null,
      updatedAt: new Date().toISOString(),
      summary: "",
      progress: ""
    };
    this.#tasks.set(task.id, task);
    while (this.#tasks.size > MAX_TASKS) {
      const oldest = this.#tasks.keys().next().value;
      if (this.#tasks.get(oldest)?.status === "running") break;
      this.#tasks.delete(oldest);
    }
    this.#flush(); // 创建即落盘：即使马上崩溃，重启后也能看到这条被中断的任务
    this.emit("task", { type: "task", task: this.#public(task) });
    return task;
  }

  append(id, chunk) {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.log = (task.log + chunk).slice(-MAX_LOG_CHARS);
    task.updatedAt = new Date().toISOString();
    const lastLine = String(chunk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    if (lastLine) task.progress = lastLine.slice(0, 200);
    this.#schedule();
    this.emit("task", { type: "log", taskId: id, chunk });
  }

  finish(id, ok, summary) {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.status = ok ? "success" : "error";
    task.summary = summary;
    task.endedAt = new Date().toISOString();
    this.#flush(); // 终态立即落盘
    this.emit("task", { type: "task", task: this.#public(task) });
  }

  get(id) {
    return this.#tasks.get(id) ?? null;
  }

  list() {
    return [...this.#tasks.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50)
      .map((t) => this.#public(t));
  }

  #public(t) {
    return {
      id: t.id,
      hostId: t.hostId,
      action: t.action,
      label: t.label,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      summary: t.summary,
      progress: t.progress,
      logLength: (t.log ?? "").length
    };
  }
}
