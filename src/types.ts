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
  /** 主机级安装目录覆盖（空 = 用全局工具默认） */
  installDir: string;
  /** 强制走 hub 中转下载（直连慢/不通的内网主机） */
  preferRelay: boolean;
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

export interface CatalogSources {
  glm: { url: string; backupUrl: string };
  kimi: { url: string; backupUrl: string };
  deepseek: { url: string; backupUrl: string };
  /** 旧版三家共用配置，仅用于兼容读取 */
  ccswitch: { url: string };
}

export interface CatalogSettings {
  sourceUrl: string;
  targetPath: string;
  forceResponsesLiteFalse: boolean;
  priorities: Record<string, [number, number]>;
  sources: CatalogSources;
}

export interface CatalogKeyInfo {
  configured: boolean;
  preview: string;
}

export interface PullOfficialResult {
  ok: boolean;
  file: CatalogFileInfo;
  channel: "official" | "ccswitch";
  note: string;
  models: string[];
}

export interface CatalogDescriptionModel {
  slug: string;
  displayName: string;
  description: string;
}

export interface Config {
  excludePatterns: string[];
  hostOverrides: Record<string, { enabled?: boolean; prelude?: string; note?: string; installDir?: string; preferRelay?: boolean }>;
  catalog: CatalogSettings;
  /** 版本号统取：固定检查间隔（分钟） */
  versions: { checkIntervalMinutes: number };
  /** 外网出口：代理模板 / GitHub 镜像前缀 / token */
  download: { proxy: string; githubMirror: string; githubToken: string };
  /** 工具安装策略（method=standalone 默认 / npm 兜底；installDir 空=~/.local/bin；channel=stable|latest|prerelease|版本号） */
  tools: Record<"codex" | "claude", { method: "standalone" | "npm"; installDir: string; channel: string }>;
  /** 官方自动更新接管（默认全禁，hub 统一更新） */
  autoUpdate: {
    codex: { startupCheck: boolean; daemonAutoStart: boolean; daemonAutoUpdate: boolean; daemonIntervalMinutes: number };
    claude: { disableAutoUpdater: boolean };
  };
}

export interface HostsResponse {
  hosts: Host[];
  state: Record<string, HostState>;
  tools: Record<string, ToolInfo>;
  config: Config;
  /** 每台主机的生效安装策略（全局默认 + 主机覆盖合并）+ 渠道目标版本 */
  effectiveTools: Record<string, Record<"codex" | "claude", EffectiveTool>>;
}

export interface Task {
  id: string;
  hostId: string;
  action: string;
  label: string;
  status: "running" | "success" | "error" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  summary: string;
  /** 最后一行日志（中断时可看出进行到哪一步） */
  progress?: string;
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

// ---------- Claude Code Model Picker ----------
export interface CcModelPickerEntry {
  slug: string;
  /** 写入 settings.json 的 model 值（1M 上下文模型带 [1m] 后缀） */
  model: string;
  displayName: string;
  description: string;
  /** 来源 catalog 文件的 key（oai / glm / kimi / deepseek / 自定义名） */
  vendor: string;
  defaultChecked: boolean;
}

export interface CcModelPickerOption {
  model: string;
  label: string;
  description: string;
}

export interface CcModelPickerResponse {
  models: CcModelPickerEntry[];
  current: CcModelPickerOption[];
  path: string;
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
  /** 当前 shell 实际生效（探测时按解析路径匹配） */
  activeInShell?: boolean;
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
  prerelease?: string;
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

// ---------- 安装预检 ----------
export interface PreflightContext {
  name: string;
  /** PATH 位置（1 起），-1 = 不在该上下文 PATH 中 */
  position: number;
  total: number;
  /** 该上下文 command -v 解析到的同名程序（空 = 未找到） */
  resolved: string;
  shadowedBy: { index: number; dir: string; version: string; method: string }[];
}

export interface PreflightResult {
  status: "ok" | "shadowed" | "not-on-path" | "need-probe";
  contexts?: PreflightContext[];
  shadowedContext?: string;
  reason?: string;
  position?: number;
  totalEntries?: number;
  shadowedBy?: { index: number; dir: string; version: string; method: string }[];
  sharedWarning?: string;
  installDir?: string;
}

export interface EffectiveTool {
  method: "standalone" | "npm";
  installDir: string;
  channel: string;
  /** 渠道解析出的目标版本（版本缓存为空时为空串） */
  target: string;
}
