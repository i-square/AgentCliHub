export interface ToolInfo {
  label: string;
  bin: string;
  npmPkg: string;
}

export interface Host {
  id: string;
  kind: "local" | "ssh";
  name: string;
  hostName: string;
  user: string;
  port: number | null;
  enabled: boolean;
  prelude: string;
  note: string;
}

export interface HostState {
  npmRoot?: string;
  node?: string;
  codex?: string;
  claude?: string;
  latestCodex?: string;
  latestClaude?: string;
  checkedAt?: string;
  home?: string;
  catalogJson?: string;
  catalogHash?: string;
  catalogPushedAt?: string;
}

export interface CatalogSettings {
  sourceUrl: string;
  targetPath: string;
  forceResponsesLiteFalse: boolean;
  priorities: Record<string, [number, number]>;
}

export interface Config {
  excludePatterns: string[];
  hostOverrides: Record<string, { enabled?: boolean; prelude?: string; note?: string }>;
  catalog: CatalogSettings;
}

export interface HostsResponse {
  hosts: Host[];
  state: Record<string, HostState>;
  tools: Record<string, ToolInfo>;
  config: Config;
}

export interface Task {
  id: string;
  hostId: string;
  action: string;
  label: string;
  status: "running" | "success" | "error";
  startedAt: string;
  endedAt: string | null;
  summary: string;
  logLength: number;
}

export interface CatalogFileInfo {
  name: string;
  key: string;
  isBuiltin: boolean;
  valid: boolean;
  error: string;
  modelCount: number;
  priorityMin: number | null;
  priorityMax: number | null;
  updatedAt: string;
}

export interface CatalogsResponse {
  files: CatalogFileInfo[];
  settings: CatalogSettings;
}

export interface MergedInfo {
  hash: string;
  modelCount: number;
  conflicts: { slug: string; files: string[]; winner: string }[];
  baselineHash: string | null;
  added: string[];
  removed: string[];
  changed: string[];
}
