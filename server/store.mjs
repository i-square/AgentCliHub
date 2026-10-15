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
  // 工具安装策略：method=standalone(默认)|npm(兜底)；installDir 空=官方默认（远程 ~/.local/bin，本机见安装器）；
  // channel=stable|latest|具体版本号。hostOverrides.<id>.tools.<tool> 可按主机覆盖
  tools: {
    codex: { method: "standalone", installDir: "", channel: "latest" },
    claude: { method: "standalone", installDir: "", channel: "stable" }
  },
  // 接管官方自动更新（默认全部禁用，由 hub 统一更新；codex 的 TUI 启动提示一并关闭）
  autoUpdate: {
    codex: { startupCheck: false, daemonAutoStart: false, daemonAutoUpdate: false, daemonIntervalMinutes: 120 },
    claude: { disableAutoUpdater: true }
  },
  // 版本号统取：固定间隔检查（分钟），启动时按上次检查时间决定是否立即检查
  versions: { checkIntervalMinutes: 360 },
  // 外网出口：代理模板（透传 curl --proxy，支持 socks5h://[user:pass@]host:port）、GitHub 镜像前缀与 token
  download: { proxy: "", githubMirror: "", githubToken: "" },
  catalog: {
    sourceUrl: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
    targetPath: "~/.codex/models.json",
    forceResponsesLiteFalse: true,
    priorities: { oai: [0, 100], glm: [100, 200], kimi: [200, 300], deepseek: [300, 400] },
    // 厂商官方拉取源（glm/kimi 需配合 data/catalog-keys.json 中的 API Key）与 CC Switch 备用源
    sources: {
      glm: { url: "https://open.bigmodel.cn/api/v1/models" },
      kimi: { url: "https://api.kimi.com/coding/v1/models" },
      deepseek: { url: "https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh" },
      ccswitch: {
        url: "https://raw.githubusercontent.com/farion1231/cc-switch/main/src/config/codexProviderPresets.ts"
      }
    }
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
    versions: { ...defaults.versions, ...(raw.versions ?? {}) },
    tools: {
      codex: { ...defaults.tools.codex, ...(raw.tools?.codex ?? {}) },
      claude: { ...defaults.tools.claude, ...(raw.tools?.claude ?? {}) }
    },
    autoUpdate: {
      codex: { ...defaults.autoUpdate.codex, ...(raw.autoUpdate?.codex ?? {}) },
      claude: { ...defaults.autoUpdate.claude, ...(raw.autoUpdate?.claude ?? {}) }
    },
    download: { ...defaults.download, ...(raw.download ?? {}) },
    catalog: {
      ...defaults.catalog,
      ...(raw.catalog ?? {}),
      priorities: { ...defaults.catalog.priorities, ...(raw.catalog?.priorities ?? {}) },
      sources: {
        ...defaults.catalog.sources,
        ...(raw.catalog?.sources ?? {}),
        glm: { ...defaults.catalog.sources.glm, ...(raw.catalog?.sources?.glm ?? {}) },
        kimi: { ...defaults.catalog.sources.kimi, ...(raw.catalog?.sources?.kimi ?? {}) },
        deepseek: { ...defaults.catalog.sources.deepseek, ...(raw.catalog?.sources?.deepseek ?? {}) },
        ccswitch: { ...defaults.catalog.sources.ccswitch, ...(raw.catalog?.sources?.ccswitch ?? {}) }
      }
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
