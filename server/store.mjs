// data/config.json 与 data/state.json 的读写（原子写入，避免损坏）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const configFile = path.join(dataDir, "config.json");
const stateFile = path.join(dataDir, "state.json");

// 每主机默认 Shell prelude 的扩展点。示例（nvm 不在默认 HOME 且 npm 需代理的主机）：
// export const DEFAULT_HOST_PRELUDES = {
//   "your-host": [
//     "export NVM_DIR=/path/to/your/nvm",
//     "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"",
//     "source <(curl -sSL https://example.com/setup_proxy.sh) >/dev/null 2>&1 || true"
//   ].join("\n")
// };
export const DEFAULT_HOST_PRELUDES = {};

const DEFAULT_CONFIG = {
  // ssh config 中匹配这些模式的主机不会出现在管理列表
  excludePatterns: ["github.com"],
  // 每主机覆盖：{ [hostId]: { enabled?: boolean, prelude?: string, note?: string } }
  hostOverrides: {},
  // 模型目录：OAI 下载源、推送目标路径、OAI 补丁开关、各 catalog 的优先级分段
  catalog: {
    sourceUrl: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
    targetPath: "~/.codex/models.json",
    forceResponsesLiteFalse: true,
    priorities: { oai: [0, 100], glm: [100, 200], kimi: [200, 300], deepseek: [300, 400] }
  }
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const raw = readJson(configFile, {});
  const defaults = structuredClone(DEFAULT_CONFIG);
  return {
    ...defaults,
    ...raw,
    hostOverrides: { ...defaults.hostOverrides, ...(raw.hostOverrides ?? {}) },
    catalog: {
      ...defaults.catalog,
      ...(raw.catalog ?? {}),
      priorities: { ...defaults.catalog.priorities, ...(raw.catalog?.priorities ?? {}) }
    }
  };
}

export function saveConfig(config) {
  writeJson(configFile, config);
}

/** state：每台主机最近一次检查到的版本信息快照，用于页面加载时直接展示 */
export function loadState() {
  return readJson(stateFile, { hosts: {} });
}

export function saveState(state) {
  writeJson(stateFile, state);
}
