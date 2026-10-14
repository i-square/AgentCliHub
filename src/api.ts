import type { CatalogsResponse, Config, HostsResponse, MergedInfo, Task, ToolVersions, ToolVersionsResponse } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

export const api = {
  getHosts: () => req<HostsResponse>("/api/hosts"),
  getTasks: () => req<{ tasks: Task[] }>("/api/tasks"),
  getTask: (id: string) => req<Task & { log: string }>(`/api/tasks/${id}`),
  checkHost: (id: string) => req<{ taskId: string }>(`/api/hosts/${id}/check`, { method: "POST" }),
  checkAll: () => req<{ taskIds: string[] }>("/api/check-all", { method: "POST" }),
  updateTool: (id: string, tool: "codex" | "claude") =>
    req<{ taskId: string }>(`/api/hosts/${id}/update`, json({ tool })),
  restartAppServer: (id: string) =>
    req<{ taskId: string }>(`/api/hosts/${id}/restart-app-server`, { method: "POST" }),
  saveHostOverride: (id: string, override: { enabled?: boolean; prelude?: string; note?: string }) =>
    req<{ ok: true }>(`/api/hosts/${id}/override`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(override)
    }),
  saveSettings: (settings: {
    excludePatterns?: string[];
    catalog?: Partial<Config["catalog"]>;
    versions?: { checkIntervalMinutes?: number };
    download?: { proxy?: string; githubMirror?: string; githubToken?: string };
  }) =>
    req<{ ok: true }>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    }),

  // ----- 版本缓存与深度探测（M1） -----
  getToolVersions: () => req<ToolVersionsResponse>("/api/tool-versions"),
  refreshToolVersions: () => req<{ ok: true; versions: ToolVersions }>("/api/tool-versions/refresh", { method: "POST" }),
  probeHost: (id: string) => req<{ taskId: string }>(`/api/hosts/${id}/probe`, { method: "POST" }),

  // ----- 模型目录 -----
  getCatalogs: () => req<CatalogsResponse>("/api/catalogs"),
  getMerged: () => req<MergedInfo>("/api/catalogs/merged"),
  getCatalog: (name: string) => req<{ name: string; content: string }>(`/api/catalogs/${encodeURIComponent(name)}`),
  saveCatalog: (name: string, content: string) =>
    req<{ ok: true }>(`/api/catalogs/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    }),
  createCatalog: (key: string) => req<{ ok: true }>("/api/catalogs", json({ key })),
  deleteCatalog: (name: string) =>
    req<{ ok: true }>(`/api/catalogs/${encodeURIComponent(name)}`, { method: "DELETE" }),
  refreshOai: () => req<{ ok: true }>("/api/catalogs/oai/refresh", { method: "POST" }),
  renumberCatalog: (name: string, start: number) =>
    req<{ ok: true }>(`/api/catalogs/${encodeURIComponent(name)}/renumber`, json({ start })),
  pushCatalog: (id: string, restart: boolean) =>
    req<{ taskId: string }>(`/api/hosts/${id}/catalog-push`, json({ restart }))
};
