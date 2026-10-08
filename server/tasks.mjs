// 任务管理：内存中保存最近任务，SSE 推送日志与状态
import { EventEmitter } from "node:events";

const MAX_TASKS = 100;
const MAX_LOG_CHARS = 300_000;

export class TaskManager extends EventEmitter {
  #tasks = new Map();
  #seq = 0;

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
