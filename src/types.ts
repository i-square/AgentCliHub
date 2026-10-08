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
}

export interface Config {
  excludePatterns: string[];
  hostOverrides: Record<string, { enabled?: boolean; prelude?: string; note?: string }>;
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
