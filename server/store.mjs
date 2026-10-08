// data/config.json 与 data/state.json 的读写（原子写入，避免损坏）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const configFile = path.join(dataDir, "config.json");
const stateFile = path.join(dataDir, "state.json");

export const DEFAULT_HOST_PRELUDES = {
  // your-host：nvm 不在默认 HOME 下，且 npm 需要代理；proxy_on 定义在其 bashrc 中，
  // 本质等价于 source 这个 curl 脚本，这里直接使用确定性写法。
  "your-host": [
    "export NVM_DIR=/path/to/your/nvm",
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    "source <(curl -sSL https://example.com/setup_proxy.sh) >/dev/null 2>&1 || true"
  ].join("\n")
};

const DEFAULT_CONFIG = {
  // ssh config 中匹配这些模式的主机不会出现在管理列表
  excludePatterns: ["github.com", "internal-*"],
  // 安装方式：目前仅实现 npm；保留该设置项，避免像旧版一样替用户做决定并改 PATH
  // 每主机覆盖：{ [hostId]: { enabled?: boolean, prelude?: string, note?: string } }
  hostOverrides: {
    "your-host": { prelude: DEFAULT_HOST_PRELUDES["your-host"] }
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
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...raw,
    hostOverrides: { ...structuredClone(DEFAULT_CONFIG.hostOverrides), ...(raw.hostOverrides ?? {}) }
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
