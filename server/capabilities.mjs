// 技术支持范围独立于 blocked / duplicateOfLocal；连接方式不参与能力判断。
import { resolveRuntime } from "./hostShell.mjs";

const operations = {
  check: { label: "状态检查" },
  probe: { label: "深度探测" },
  standaloneInstall: { label: "独立二进制安装", platforms: ["windows", "linux"], architectures: ["x64", "arm64"] },
  npmUpdate: { label: "npm 安装与更新" },
  autoUpdate: { label: "自动更新配置" },
  catalogPush: { label: "catalog 推送" },
  claudeSettings: { label: "Claude 设置写入" },
  restart: { label: "app-server 重启" },
  cleanup: { label: "旧版本清理", platforms: ["windows", "linux"] },
  pathRepair: { label: "PATH 修复" }
};

export function capabilityFor(runtime, operation) {
  const spec = operations[operation];
  if (!spec) throw new Error(`未知操作能力: ${operation}`);
  const platform = runtime.platform;
  const supported = ["windows", "bash"].includes(runtime.family)
    && ["windows", "linux", "darwin"].includes(platform.sysname)
    && (!spec.platforms || spec.platforms.includes(platform.sysname))
    && (!spec.architectures || spec.architectures.includes(platform.machine));
  return {
    supported,
    reason: supported ? "" : `${platform.sysname}/${platform.machine} 暂不支持${spec.label}${platform.sysname === "darwin" && spec.platforms ? "（当前实现依赖 GNU/Linux 工具）" : ""}`
  };
}

export function capabilitiesFor(runtime) {
  return Object.fromEntries(Object.keys(operations).map((operation) => [operation, capabilityFor(runtime, operation)]));
}

/** 各业务入口共用；平台探测失败直接报错，不冒充技术不支持或用户屏蔽。 */
export async function requireCapability(host, operation) {
  const runtime = await resolveRuntime(host);
  const capability = capabilityFor(runtime, operation);
  if (!capability.supported) throw new Error(`${host.id}: ${capability.reason}`);
  return runtime;
}
