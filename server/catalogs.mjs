// 模型目录（models.*.json）管理：存储、校验、合并、OAI 下载、优先级重排
// 逻辑对齐 update_models_catalog.py：自定义目录按文件名排序先合并，OAI 最后合并（冲突时胜出），
// 渲染时模型按 slug 排序、对象 key 排序，保证内容比较不受顺序影响。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const catalogsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "catalogs");

export const OAI_NAME = "models.oai.json";
export const DEFAULT_SOURCE_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const NAME_RE = /^models\.([a-z0-9][a-z0-9-]*)\.json$/i;

export function catalogKey(name) {
  return NAME_RE.exec(name)?.[1]?.toLowerCase() ?? null;
}

export function isValidName(name) {
  return NAME_RE.test(name);
}

/** 递归排序对象 key 的稳定序列化（对齐 python json.dumps(sort_keys=True)） */
function stableStringify(value, indent = 2) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sortDeep(value), null, indent);
}

/** 规范化渲染：模型按 slug 排序 + key 排序 + 末尾换行 */
export function renderCatalog(catalog) {
  const models = [...(catalog.models ?? [])].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return stableStringify({ ...catalog, models }) + "\n";
}

export function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function hashModel(model) {
  return hashText(stableStringify(model, 0));
}

/** 校验 catalog 文本：必须是含 models 数组的对象，每个模型带 slug 字符串 */
export function parseCatalogText(text) {
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`);
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("catalog 顶层必须是对象");
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error("catalog 缺少 models 数组");
  }
  for (const m of catalog.models) {
    if (!m || typeof m !== "object" || typeof m.slug !== "string" || !m.slug) {
      throw new Error("每个模型必须包含非空 slug 字符串");
    }
  }
  return catalog;
}

function catalogPath(name) {
  if (!isValidName(name)) throw new Error(`非法 catalog 文件名: ${name}`);
  return path.join(catalogsDir, name);
}

function fileInfo(name) {
  const file = path.join(catalogsDir, name);
  const stat = fs.statSync(file);
  const info = {
    name,
    key: catalogKey(name),
    isBuiltin: name === OAI_NAME,
    valid: true,
    error: "",
    modelCount: 0,
    priorityMin: null,
    priorityMax: null,
    updatedAt: stat.mtime.toISOString()
  };
  try {
    const catalog = parseCatalogText(fs.readFileSync(file, "utf8"));
    info.modelCount = catalog.models.length;
    const priorities = catalog.models.map((m) => m.priority).filter((p) => typeof p === "number");
    if (priorities.length) {
      info.priorityMin = Math.min(...priorities);
      info.priorityMax = Math.max(...priorities);
    }
  } catch (err) {
    info.valid = false;
    info.error = err.message;
  }
  return info;
}

export function listCatalogs() {
  if (!fs.existsSync(catalogsDir)) return [];
  return fs.readdirSync(catalogsDir)
    .filter((f) => isValidName(f))
    .sort((a, b) => (a === OAI_NAME ? -1 : b === OAI_NAME ? 1 : a.localeCompare(b)))
    .map(fileInfo);
}

export function readCatalogText(name) {
  return fs.readFileSync(catalogPath(name), "utf8");
}

/** 保存：校验 → 规范化渲染 → 备份 .bak → 原子写入 */
export function writeCatalog(name, text) {
  const catalog = parseCatalogText(text); // 先校验，不合法不落盘
  const file = catalogPath(name);
  fs.mkdirSync(catalogsDir, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, renderCatalog(catalog), "utf8");
  fs.renameSync(tmp, file);
  return fileInfo(name);
}

export function createCatalog(key) {
  const name = `models.${key}.json`;
  const file = catalogPath(name); // 顺带完成命名校验
  if (fs.existsSync(file)) throw new Error(`已存在: ${name}`);
  fs.mkdirSync(catalogsDir, { recursive: true });
  fs.writeFileSync(file, renderCatalog({ models: [] }), "utf8");
  return fileInfo(name);
}

export function deleteCatalog(name) {
  if (name === OAI_NAME) throw new Error("内置 OAI catalog 不可删除");
  fs.rmSync(catalogPath(name), { force: true });
}

/** 从 sourceUrl 下载最新 OAI catalog 并覆盖保存（保存原始文本，补丁在合并时应用） */
export async function refreshOai(sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { "User-Agent": "codexhub-model-catalog-updater" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const text = await res.text();
  const catalog = parseCatalogText(text); // 校验下载内容
  if (catalog.models.length === 0) throw new Error("下载的 catalog 不包含任何模型");
  fs.mkdirSync(catalogsDir, { recursive: true });
  fs.writeFileSync(catalogPath(OAI_NAME), text, "utf8");
  return fileInfo(OAI_NAME);
}

/**
 * 合并全部 catalog：自定义文件按文件名排序先合并，OAI 最后（slug 冲突时 OAI 胜出）。
 * forceResponsesLiteFalse 时给每个 OAI 模型打上 use_responses_lite=false。
 * 返回 { rendered, hash, modelCount, conflicts, catalog }
 */
export function mergeCatalogs({ forceResponsesLiteFalse = true } = {}) {
  const names = fs.existsSync(catalogsDir)
    ? fs.readdirSync(catalogsDir).filter((f) => isValidName(f))
    : [];
  // 自定义文件按文件名排序先合并，OAI 固定最后（slug 冲突时 OAI 胜出），与 python 脚本一致
  const files = [...names.filter((f) => f !== OAI_NAME).sort(), ...(names.includes(OAI_NAME) ? [OAI_NAME] : [])];
  if (files.length === 0) throw new Error("未发现任何 catalog 文件，请先下载 OAI catalog 或新建自定义 catalog");

  const merged = new Map(); // slug -> model
  const origin = new Map(); // slug -> [fileName...]
  const winner = new Map(); // slug -> fileName（最后写入者）

  for (const name of files) {
    const catalog = parseCatalogText(fs.readFileSync(path.join(catalogsDir, name), "utf8"));
    const models = catalog.models.map((m) =>
      name === OAI_NAME && forceResponsesLiteFalse ? { ...m, use_responses_lite: false } : m
    );
    for (const m of models) {
      origin.set(m.slug, [...(origin.get(m.slug) ?? []), name]);
      merged.set(m.slug, m);
      winner.set(m.slug, name);
    }
  }

  const conflicts = [...origin.entries()]
    .filter(([, fs_]) => fs_.length > 1)
    .map(([slug, fs_]) => ({ slug, files: fs_, winner: winner.get(slug) }));

  const catalog = { models: [...merged.values()] };
  const rendered = renderCatalog(catalog);
  return { rendered, hash: hashText(rendered), modelCount: catalog.models.length, conflicts, catalog };
}

/** 基线快照：{ hash, models: { slug: modelHash } }，用于计算"较上次推送"的增删改 */
export function baselineFrom(merged) {
  const models = {};
  for (const m of merged.catalog.models) models[m.slug] = hashModel(m);
  return { hash: merged.hash, models };
}

export function summarize(baseline, merged) {
  if (!baseline?.models) {
    return { added: Object.keys(baselineFrom(merged).models), removed: [], changed: [] };
  }
  const after = baselineFrom(merged).models;
  const before = baseline.models;
  const beforeSlugs = new Set(Object.keys(before));
  const afterSlugs = new Set(Object.keys(after));
  return {
    added: [...afterSlugs].filter((s) => !beforeSlugs.has(s)).sort(),
    removed: [...beforeSlugs].filter((s) => !afterSlugs.has(s)).sort(),
    changed: [...afterSlugs].filter((s) => beforeSlugs.has(s) && before[s] !== after[s]).sort()
  };
}

/** 按 (priority, slug) 排序后从 rangeStart 顺序重写 priority */
export function renumber(name, rangeStart) {
  const file = catalogPath(name);
  const catalog = parseCatalogText(fs.readFileSync(file, "utf8"));
  const models = [...catalog.models].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
      String(a.slug).localeCompare(String(b.slug))
  );
  models.forEach((m, i) => {
    m.priority = rangeStart + i;
  });
  fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, renderCatalog({ ...catalog, models }), "utf8");
  fs.renameSync(tmp, file);
  return fileInfo(name);
}
