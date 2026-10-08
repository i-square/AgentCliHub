import type { Config, HostsResponse, Task } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getHosts: () => req<HostsResponse>("/api/hosts"),
  getTasks: () => req<{ tasks: Task[] }>("/api/tasks"),
  getTask: (id: string) => req<Task & { log: string }>(`/api/tasks/${id}`),
  checkHost: (id: string) => req<{ taskId: string }>(`/api/hosts/${id}/check`, { method: "POST" }),
  checkAll: () => req<{ taskIds: string[] }>("/api/check-all", { method: "POST" }),
  updateTool: (id: string, tool: "codex" | "claude") =>
    req<{ taskId: string }>(`/api/hosts/${id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool })
    }),
  restartAppServer: (id: string) =>
    req<{ taskId: string }>(`/api/hosts/${id}/restart-app-server`, { method: "POST" }),
  saveHostOverride: (id: string, override: { enabled?: boolean; prelude?: string; note?: string }) =>
    req<{ ok: true }>(`/api/hosts/${id}/override`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(override)
    }),
  saveSettings: (settings: Partial<Config>) =>
    req<{ ok: true }>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    })
};
