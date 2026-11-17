// 本机平台识别与官方资产目标映射。
// 本机只有 process 信息可用；远程 Linux 的 uname 结果也复用同一套目标映射。
const SYSNAME_BY_NODE_PLATFORM = {
  win32: "windows",
  linux: "linux",
  darwin: "darwin"
};

const OS_LABELS = {
  windows: "Windows",
  linux: "Linux",
  darwin: "macOS"
};

function normalizeMachine(machine) {
  const value = String(machine ?? "").toLowerCase();
  if (["x86_64", "amd64", "x64"].includes(value)) return "x64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return value;
}

let cachedLinuxLibc = "";
function runtimeLinuxLibc() {
  if (cachedLinuxLibc) return cachedLinuxLibc;
  // Node 官方 glibc 构建会在报告头中声明运行时 glibc 版本；musl 构建没有该字段。
  cachedLinuxLibc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
  return cachedLinuxLibc;
}

/** 自动识别 hub 本机 OS、CPU 架构与 Linux libc；参数注入仅用于回归测试。 */
export function detectLocalPlatform({ platform = process.platform, arch = process.arch, libc } = {}) {
  const sysname = SYSNAME_BY_NODE_PLATFORM[platform] ?? platform;
  const machine = normalizeMachine(arch);
  return {
    sysname,
    machine,
    libc: sysname === "linux" ? (libc ?? runtimeLinuxLibc()) : ""
  };
}

export function platformLabel(platform) {
  const os = OS_LABELS[platform.sysname] ?? platform.sysname;
  return `${os}/${platform.machine}`;
}

export function localHostName(platform = detectLocalPlatform()) {
  return `local (本机 ${platformLabel(platform)})`;
}

/** Codex 官方 codex-package 资产 target。 */
export function codexTarget(sysname, machine) {
  const s = String(sysname).toLowerCase();
  const m = normalizeMachine(machine);
  if (s.includes("linux")) {
    if (m === "x64") return "x86_64-unknown-linux-musl";
    if (m === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (s.includes("darwin")) {
    if (m === "arm64") return "aarch64-apple-darwin";
    if (m === "x64") return "x86_64-apple-darwin";
  }
  if (s.includes("windows")) {
    if (m === "x64") return "x86_64-pc-windows-msvc";
    if (m === "arm64") return "aarch64-pc-windows-msvc";
  }
  throw new Error(`不支持的平台: ${sysname} ${machine}`);
}

/** Claude Code manifest 的平台键。 */
export function claudePlatform(sysname, machine, libc = "glibc") {
  const s = String(sysname).toLowerCase();
  const m = normalizeMachine(machine);
  if (s.includes("linux")) {
    if (m !== "x64" && m !== "arm64") throw new Error(`不支持的平台: ${sysname} ${machine}`);
    return `linux-${m}${libc === "musl" ? "-musl" : ""}`;
  }
  if (s.includes("darwin")) {
    if (m !== "x64" && m !== "arm64") throw new Error(`不支持的平台: ${sysname} ${machine}`);
    return `darwin-${m}`;
  }
  if (s.includes("windows")) {
    if (m !== "x64" && m !== "arm64") throw new Error(`不支持的平台: ${sysname} ${machine}`);
    return `win32-${m}`;
  }
  throw new Error(`不支持的平台: ${sysname} ${machine}`);
}

/** 仅允许进入已实现的 Windows 本机链路；其他系统不得误入 PowerShell/注册表实现。 */
export function assertWindowsLocal(operation, platform = detectLocalPlatform()) {
  if (platform.sysname !== "windows") {
    throw new Error(`本机 ${platformLabel(platform)} 的${operation}尚未实现，请暂时通过 SSH 主机管理；不会再误走 Windows 专用逻辑`);
  }
}
