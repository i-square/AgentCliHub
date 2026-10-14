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
  /** 深度探测快照（M1 新增，只读采集） */
  probe?: ProbeResult;
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
  /** 版本号统取：固定检查间隔（分钟） */
  versions: { checkIntervalMinutes: number };
  /** 外网出口：代理模板 / GitHub 镜像前缀 / token */
  download: { proxy: string; githubMirror: string; githubToken: string };
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

// ---------- 深度探测（M1） ----------
export interface ProbePathEntry {
  index: number;
  dir: string;
  codex: boolean;
  claude: boolean;
}

export interface ProbeCandidate {
  path: string;
  realPath: string;
  versionRaw: string;
  version: string;
  tool: "codex" | "claude";
  method: string;
  shared: boolean;
}

export interface ProbeResult {
  probedAt: string;
  meta: Record<string, string>;
  pathEntries: ProbePathEntry[];
  regUserPath: ProbePathEntry[];
  regMachPath: ProbePathEntry[];
  contexts: Record<string, Record<string, string>>;
  candidates: ProbeCandidate[];
  pkgRoots: { base: string; sub: string; current: string; releases: string[] }[];
  autoUpdate: Record<string, string>;
  rcFiles: { file: string; localBinHits: number; nvmHits: number }[];
  procs: string;
  done: boolean;
}

// ---------- 版本缓存（仅 hub 本机查外网） ----------
export interface ToolVersionEntry {
  latest?: string;
  stable?: string;
  source?: string;
  fetchedAt?: string;
  stale?: boolean;
  error?: string;
}

export interface ToolVersions {
  fetchedAt?: string;
  codex?: ToolVersionEntry;
  claude?: ToolVersionEntry;
}

export interface ToolVersionsResponse {
  versions: ToolVersions;
  checkIntervalMinutes: number;
  proxyConfigured: boolean;
}
