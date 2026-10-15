// 任务管理：内存中保存最近任务，SSE 推送日志与状态
import { EventEmitter } from "node:events";

const MAX_TASKS = 100;
const MAX_LOG_CHARS = 300_000;

export class TaskManager extends EventEmitter {
  #tasks = new Map();
  #seq = 0;
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
      summary: ""
    };
    this.#tasks.set(task.id, task);
    while (this.#tasks.size > MAX_TASKS) {
      const oldest = this.#tasks.keys().next().value;
      if (this.#tasks.get(oldest)?.status === "running") break;
      this.#tasks.delete(oldest);
    }
    this.emit("task", { type: "task", task: this.#public(task) });
    return task;
  }

  append(id, chunk) {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.log = (task.log + chunk).slice(-MAX_LOG_CHARS);
    this.emit("task", { type: "log", taskId: id, chunk });
  }

  finish(id, ok, summary) {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.status = ok ? "success" : "error";
    task.summary = summary;
    task.endedAt = new Date().toISOString();
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
      logLength: t.log.length
    };
  }
}
