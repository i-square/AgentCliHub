// 厂商官方/备用模型目录拉取：GLM（Codex 原生格式 API + 官方文档兜底）、Kimi（厂商扩展格式映射）、
// DeepSeek（CDN 一键脚本内嵌 heredoc），以及 CC Switch 预设（无 key 时的备用通道）。
//
// Key 存放于 data/catalog-keys.json（被 .gitignore 的 data/* 覆盖，不入库），接口只回脱敏预览。
// 所有拉取结果都是「未重排 priority」的 catalog 对象，由调用方写盘后按分段 renumber。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const keysFile = path.join(dataDir, "catalog-keys.json");

export const VENDOR_KEYS = ["glm", "kimi", "deepseek"];

// 各厂商 effort 描述用语对齐本地既有 catalog（glm 官方口径）
const EFFORT_DESC = {
  low: "Light reasoning",
  high: "Enhanced reasoning",
  max: "Deep reasoning"
};

// 新模型的 Codex 模板字段（对齐本地 kimi/glm 既有条目；slug 已存在时以本地条目为模板）
const CODEX_TEMPLATE = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  base_instructions: "",
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  support_verbosity: false,
  truncation_policy: { mode: "bytes", limit: 10000 },
  effective_context_window_percent: 95,
  supports_parallel_tool_calls: true,
  experimental_supported_tools: []
};

// ---------- key 存取 ----------

export function loadCatalogKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    const keys = raw && typeof raw === "object" ? raw : {};
    // 兼容早期误存的 zhipu 键：读取时映射为 glm
    if (!keys.glm && typeof keys.zhipu === "string" && keys.zhipu.trim()) keys.glm = keys.zhipu;
    return keys;
  } catch {
    return {};
  }
}

/** 写 key：值为空字符串/null 表示清除；未出现的厂商保持不变 */
export function saveCatalogKeys(updates) {
  const keys = loadCatalogKeys();
  for (const [k, v] of Object.entries(updates ?? {})) {
    if (!VENDOR_KEYS.includes(k)) continue;
    if (typeof v === "string" && v.trim()) keys[k] = v.trim();
    else delete keys[k];
  }
  // 清除 glm 时一并清除旧 zhipu 键，避免兼容映射复活
  if (updates && "glm" in updates && !updates.glm) delete keys.zhipu;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${keysFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2));
  fs.renameSync(tmp, keysFile);
  return maskKeys();
}

/** 脱敏视图：只回前端 configured 与首尾预览，绝不回完整 key */
export function maskKeys() {
  const keys = loadCatalogKeys();
  const out = {};
  for (const k of VENDOR_KEYS) {
    const v = keys[k];
    out[k] = v
      ? { configured: true, preview: `${v.slice(0, 6)}…${v.slice(-4)}` }
      : { configured: false, preview: "" };
  }
  return out;
}

// ---------- 拉取原语 ----------

async function fetchText(url, { headers = {}, timeout = 30_000 } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "AgentCliHub-model-catalog-updater", ...headers },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}（${url}）`);
  return res.text();
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败（${url}）：${err.message}`);
  }
}

// ---------- GLM 官方通道 ----------

/**
 * 智谱 /models 响应归一化：
 * coding 端点直接返回 Codex 格式 { models: [...] }；
 * 旧版/文档页可能给 { data: [{ id, context_length, ... }] } 的 OpenAI 包装。
 */
function normalizeZhipuCatalog(raw) {
  const list = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw?.data) ? raw.data : [];
  return list
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const slug = m.slug ?? m.id;
      if (!slug) return null;
      const ctx = m.context_window ?? m.context_length ?? m.limit?.context;
      return {
        ...CODEX_TEMPLATE,
        ...m,
        slug,
        display_name: m.display_name ?? m.name ?? slug,
        context_window: ctx ?? 262144,
        max_context_window: ctx ?? 262144
      };
    })
    .filter(Boolean);
}

/** GLM 官方目录即权威口径：直接采用官方条目（priority 由调用方按分段重排） */
async function pullGlmOfficial(sourceUrl, key) {
  const raw = await fetchJson(sourceUrl, { headers: { Authorization: `Bearer ${key}` } });
  const models = normalizeZhipuCatalog(raw);
  if (!models.length) throw new Error("GLM 接口未返回 models/data 数组");
  return { catalog: { models }, note: "" };
}


// ---------- Kimi 官方通道 ----------

/** kimi think_efforts 兼容两种形态：{valid_efforts, default_effort} 或嵌套 {support:{valid, default}} */
function mapEffort(te) {
  if (!te || typeof te !== "object") return { levels: [], def: null };
  const validRaw = te.valid_efforts ?? te.valid ?? te.support?.valid ?? te.support?.valid_efforts ?? [];
  const def = te.default_effort ?? te.default ?? te.support?.default ?? te.support?.default_effort ?? null;
  return { levels: Array.isArray(validRaw) ? validRaw : [], def };
}

function kimiEntryToCodex(m, prev) {
  const effort = mapEffort(m.think_efforts);
  // 固定思考模型（如 highspeed，官方无 think_efforts 字段）→ 空档位数组，对齐 GLM 官方 glm-5-turbo 条目
  const levels = effort.levels.map((eff) => {
    const prevLevel = prev?.supported_reasoning_levels?.find((l) => l.effort === eff);
    return { effort: eff, description: prevLevel?.description ?? EFFORT_DESC[eff] ?? eff };
  });
  const thinkingTypes = Array.isArray(m.supported_thinking_types)
    ? m.supported_thinking_types.filter((t) => typeof t === "string")
    : [];
  // Codex 无视频输入通道（Kimi 官方文档亦说明），模态只保留 text/image
  const modalities = (m.modalities?.input ?? ["text"]).filter((x) => x === "text" || x === "image");
  const ctx = m.limit?.context ?? m.context_length ?? 262144;
  return {
    // 以已有条目为模板（保留用户对工具链字段的调整），否则用通用模板
    ...(prev ?? CODEX_TEMPLATE),
    slug: m.id,
    // 展示名称保留用户修改；description 源里有则用源，否则回落本地
    display_name: prev?.display_name ?? m.display_name ?? m.id,
    description: m.description?.trim() ? m.description : (prev?.description ?? ""),
    // 官方有 priority 时覆盖，否则沿用本地相对优先级（由调用方从分段绝对值转换）
    priority: m.priority ?? prev?.priority,
    // 以下字段以官方返回为准
    default_reasoning_level: effort.def ?? "max",
    supported_reasoning_levels: levels,
    ...(thinkingTypes.length ? { supported_thinking_types: thinkingTypes } : {}),
    context_window: ctx,
    max_context_window: ctx,
    input_modalities: modalities.length ? modalities : ["text"]
  };
}

/** Kimi：/coding/v1/models 返回厂商扩展格式 { data: [...] }，映射为 Codex 条目 */
async function pullKimiOfficial(sourceUrl, key, existing) {
  const raw = await fetchJson(sourceUrl, { headers: { Authorization: `Bearer ${key}` } });
  const list = raw?.data;
  if (!Array.isArray(list) || list.length === 0) throw new Error("Kimi 接口未返回 data 数组");
  const bySlug = new Map((existing ?? []).map((m) => [m.slug, m]));
  const models = list.map((m) => kimiEntryToCodex(m, bySlug.get(m.id)));
  return { catalog: { models }, note: "" };
}

// ---------- DeepSeek 官方通道 ----------

/** DeepSeek：官方一键脚本内嵌 <<'CODEX_MODELS_JSON' heredoc，免鉴权 */
async function pullDeepseekOfficial(sourceUrl) {
  const script = await fetchText(sourceUrl);
  const match = script.match(/<<'CODEX_MODELS_JSON'\r?\n([\s\S]*?)\r?\nCODEX_MODELS_JSON/);
  if (!match) throw new Error("脚本中未找到 CODEX_MODELS_JSON heredoc（脚本结构可能已变更）");
  let catalog;
  try {
    catalog = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`脚本内嵌 models.json 解析失败：${err.message}`);
  }
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error("脚本内嵌 models.json 不含任何模型");
  }
  return { catalog, note: "" };
}

// ---------- CC Switch 备用通道 ----------

const CCSWITCH_PRESETS = {
  kimi: { presetName: "Kimi For Coding", region: "cn" },
  glm: { presetName: "Zhipu GLM", region: "cn" },
  deepseek: { presetName: "DeepSeek", region: null }
};

// codex 端可识别的 thinking 类型映射（ccswitch 预设用 none/auto 表述）
const THINKING_TYPE_MAP = { none: "disabled", auto: "enabled", enabled: "enabled", disabled: "disabled" };

function mapThinkingTypes(levels) {
  if (!Array.isArray(levels)) return [];
  return [...new Set(levels.map((t) => THINKING_TYPE_MAP[String(t).toLowerCase()]).filter(Boolean))];
}

/** codex 只识别 low/high/max：ccswitch 预设出现的 ultra/xhigh 收敛为 max */
function mapCcswitchEffort(levels) {
  if (!Array.isArray(levels)) return [];
  return [...new Set(levels.map((l) => {
    const s = String(l).toLowerCase();
    return s === "ultra" || s === "xhigh" ? "max" : s;
  }).filter((s) => s === "low" || s === "high" || s === "max"))];
}

/** 从 codexProviderPresets.ts 源码中定位指定预设的 modelCatalog([...]) 块并解析 */
async function pullCcSwitch(sourceUrl, vendor, existingModels = []) {
  const preset = CCSWITCH_PRESETS[vendor];
  if (!preset) throw new Error(`CC Switch 备用通道不支持: ${vendor}`);
  const src = await fetchText(sourceUrl, { timeout: 60_000 });

  const presetIdx = findPresetIndex(src, preset);
  if (presetIdx < 0) throw new Error(`CC Switch 源码中未找到预设「${preset.presetName}」`);
  const block = extractModelCatalogBlock(src, presetIdx);
  if (!block) throw new Error(`预设「${preset.presetName}」中未找到 modelCatalog 块`);
  const entries = parseTsObjectArray(block);
  if (!entries.length) throw new Error(`预设「${preset.presetName}」modelCatalog 解析结果为空`);
  const bySlug = new Map(existingModels.map((m) => [m.slug, m]));
  const models = entries.map((e) => ccswitchEntryToCodex(e, bySlug.get(e.model)));
  return {
    catalog: { models },
    note: "来自 CC Switch 社区预设（人工核对、可能滞后于官方），建议配置 key 后改用官方通道复核"
  };
}

/** 在源码中找 name: "X" 且（需要时）regionKey 匹配 的预设对象起点 */
function findPresetIndex(src, preset) {
  const namePat = `name: "${preset.presetName}"`;
  let idx = -1;
  while ((idx = src.indexOf(namePat, idx + 1)) >= 0) {
    if (!preset.region) return idx;
    // 同名预设的国内/国际变体相邻，向后看 400 字符内的 regionKey
    const tail = src.slice(idx, idx + 400);
    if (tail.includes(`regionKey: "${preset.region}"`)) return idx;
  }
  return -1;
}

/** 从预设起点提取 modelCatalog([...]) 的数组字面量（按方括号配平） */
function extractModelCatalogBlock(src, fromIdx) {
  const marker = src.indexOf("modelCatalog(", fromIdx);
  if (marker < 0) return null;
  const open = src.indexOf("[", marker);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** 把 TS 对象数组字面量转成 JSON 再解析（键加引号、去尾逗号、去行注释） */
function parseTsObjectArray(literal) {
  const jsonish = literal
    .replace(/\/\/[^\n]*/g, "")
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  try {
    const arr = JSON.parse(jsonish);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    throw new Error(`CC Switch modelCatalog 解析失败：${err.message}`);
  }
}

function ccswitchEntryToCodex(e, prev) {
  const levels = mapCcswitchEffort(e.reasoningLevels).map((effort) => ({
    effort,
    description: EFFORT_DESC[effort] ?? effort
  }));
  const thinkingTypes = mapThinkingTypes(e.thinkingTypeLevels);
  const ctx = e.contextWindow ?? 262144;
  const modalities = (e.inputModalities ?? ["text"]).filter((x) => x === "text" || x === "image");
  return {
    ...CODEX_TEMPLATE,
    slug: e.model,
    display_name: e.displayName ?? e.model,
    description: e.description?.trim() ? e.description : (prev?.description ?? ""),
    priority: e.priority ?? prev?.priority,
    default_reasoning_level: e.defaultReasoningLevel ?? (levels.length ? levels[0].effort : "max"),
    supported_reasoning_levels: levels,
    ...(thinkingTypes.length ? { supported_thinking_types: thinkingTypes } : {}),
    context_window: ctx,
    max_context_window: ctx,
    supports_parallel_tool_calls: e.supportsParallelToolCalls ?? true,
    input_modalities: modalities.length ? modalities : ["text"]
  };
}

// ---------- 统一入口 ----------

const OFFICIAL_PULLERS = { glm: pullGlmOfficial, kimi: pullKimiOfficial, deepseek: pullDeepseekOfficial };

/**
 * 拉取指定厂商 catalog。
 * channel: "auto"（默认，官方优先、失败回落 CC Switch）| "official" | "ccswitch"
 * sources: config.catalog.sources（含各 url）；existingModels: 现有条目（Kimi 用于保留展示文案）
 * 返回 { catalog, channel, note }
 */
export async function pullVendorCatalog(vendor, { channel = "auto", sources = {}, existingModels = [] } = {}) {
  const official = OFFICIAL_PULLERS[vendor];
  if (!official) throw new Error(`厂商 ${vendor} 没有官方拉取通道`);

  const needsKey = vendor === "glm" || vendor === "kimi";
  const key = loadCatalogKeys()[vendor];
  const officialUrl = sources[vendor]?.url;
  const ccswitchUrl = sources[vendor]?.backupUrl || sources.ccswitch?.url;

  const tryOfficial = async () => {
    if (!officialUrl) throw new Error(`未配置 ${vendor} 官方源地址`);
    if (needsKey && !key) throw new Error(`未配置 ${vendor} 的 API Key`);
    if (vendor === "glm") return pullGlmOfficial(officialUrl, key);
    if (vendor === "kimi") return pullKimiOfficial(officialUrl, key, existingModels);
    return pullDeepseekOfficial(officialUrl);
  };
  const tryBackup = () => {
    if (!ccswitchUrl) throw new Error("未配置 CC Switch 备用源地址");
    return pullCcSwitch(ccswitchUrl, vendor, existingModels);
  };

  if (channel === "official") {
    const r = await tryOfficial();
    return { ...r, channel: "official" };
  }
  if (channel === "ccswitch") {
    const r = await tryBackup();
    return { ...r, channel: "ccswitch" };
  }
  // auto：官方优先，失败回落备用并记录原因
  try {
    const r = await tryOfficial();
    return { ...r, channel: "official" };
  } catch (err) {
    const r = await tryBackup().catch((backupErr) => {
      throw new Error(`官方通道失败（${err.message}）；备用通道也失败（${backupErr.message}）`);
    });
    return { ...r, channel: "ccswitch", note: `官方通道不可用（${err.message}），已回落备用源。${r.note}` };
  }
}
