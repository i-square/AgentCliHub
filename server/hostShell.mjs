// 主机 shell 识别与对应执行器。
// SSH 默认 shell 与最终命令环境必须一致，禁止在 Windows OpenSSH 中无条件进入 WSL bash。
import { runLocalPwsh, runRemoteBash, runRemoteCmd, runRemotePwsh } from "./exec.mjs";
import { assertWindowsLocal, detectLocalPlatform } from "./platform.mjs";

const WINDOWS_MARKER = "__ACH_WINDOWS_POWERSHELL__";
const BASH_MARKER = "__ACH_BASH_SHELL__";
const shellCache = new Map();

export function normalizeShellOverride(value) {
  const shell = String(value ?? "").trim().toLowerCase();
  if (!shell) return null;
  if (shell === "pwsh" || shell === "powershell") return { family: "windows", executable: shell, source: "override" };
  if (shell === "bash") return { family: "bash", executable: "bash", source: "override" };
  throw new Error(`非法的 shell 覆盖: ${value}；仅支持 pwsh、powershell、bash`);
}

export function parseWindowsShellProbe(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim());
  const index = lines.indexOf(WINDOWS_MARKER);
  if (index < 0) return null;
  const edition = lines.slice(index + 1).find((line) => /^(Core|Desktop)$/i.test(line));
  if (!edition) return null;
  return {
    family: "windows",
    executable: edition?.toLowerCase() === "desktop" ? "powershell" : "pwsh",
    source: "detected"
  };
}

async function detectRemoteShell(host) {
  // 该标记命令在 PowerShell 中成功，在 bash 中只是不存在的命令；不会修改目标环境。
  const windows = await runRemoteCmd(
    host.id,
    `Write-Output '${WINDOWS_MARKER}'; Write-Output $PSVersionTable.PSEdition`,
    { timeoutMs: 20_000 }
  );
  const parsed = parseWindowsShellProbe(windows.stdout);
  if (windows.code === 0 && parsed) return parsed;
  if (windows.stdout.split(/\r?\n/).includes(WINDOWS_MARKER)) {
    throw new Error(`${host.id} 已检测到 PowerShell，但无法识别 Core/Desktop；请显式配置 shell=pwsh 或 shell=powershell`);
  }

  const bash = await runRemoteBash(host.id, `printf '${BASH_MARKER}\\n'`, { timeoutMs: 20_000 });
  if (bash.code === 0 && bash.stdout.split(/\r?\n/).includes(BASH_MARKER)) {
    return { family: "bash", executable: "bash", source: "detected" };
  }
  throw new Error(`无法识别 ${host.id} 的 SSH shell；请在 hostOverrides.${host.id}.shell 中显式配置 pwsh、powershell 或 bash`);
}

/** 本机直接取进程平台；SSH 结果仅在当前 hub 进程内缓存。 */
export async function detectHostShell(host) {
  if (host.kind === "local") {
    const platform = detectLocalPlatform();
    return platform.sysname === "windows"
      ? { family: "windows", executable: "pwsh", source: "local" }
      : { family: "bash", executable: "bash", source: "local" };
  }
  const override = normalizeShellOverride(host.shell);
  if (override) return override;
  if (!shellCache.has(host.id)) {
    const pending = detectRemoteShell(host);
    shellCache.set(host.id, pending);
    try {
      await pending;
    } catch (error) {
      shellCache.delete(host.id);
      throw error;
    }
  }
  return shellCache.get(host.id);
}

// Windows OpenSSH 不一定继承桌面终端的用户 PATH。只修改本次子进程环境，不写注册表。
const WINDOWS_SSH_PATH_PRELUDE = String.raw`
$__achPathParts = @(
  [Environment]::GetEnvironmentVariable('Path', 'Machine'),
  [Environment]::GetEnvironmentVariable('Path', 'User'),
  $env:Path
)
$__achSeenPath = @{}
$__achMergedPath = foreach ($__achPart in $__achPathParts) {
  foreach ($__achEntry in ([Environment]::ExpandEnvironmentVariables([string]$__achPart) -split ';')) {
    if ($__achEntry -and -not $__achSeenPath.ContainsKey($__achEntry)) {
      $__achSeenPath[$__achEntry] = $true
      $__achEntry
    }
  }
}
$env:Path = $__achMergedPath -join ';'
Remove-Variable __achPathParts,__achSeenPath,__achMergedPath,__achPart,__achEntry -ErrorAction SilentlyContinue
`;

export async function runHostPwsh(host, script, opts = {}) {
  if (host.kind === "local") {
    assertWindowsLocal("PowerShell 操作");
    return runLocalPwsh(script, opts);
  }
  const shell = await detectHostShell(host);
  if (shell.family !== "windows") throw new Error(`${host.id} 不是 Windows PowerShell 环境`);
  return runRemotePwsh(host.id, `${WINDOWS_SSH_PATH_PRELUDE}\n${script}`, {
    ...opts,
    executable: shell.executable
  });
}

export async function runHostBash(host, script, opts = {}) {
  if (host.kind === "local") throw new Error("Linux 本机 Bash 链路尚未实现");
  const shell = await detectHostShell(host);
  if (shell.family !== "bash") throw new Error(`${host.id} 不是 Bash 环境`);
  return runRemoteBash(host.id, script, opts);
}

/** 尚未远程 Windows 化的写操作在此统一阻断，避免退回 WSL 或把 Bash 发给 PowerShell。 */
export async function assertHostBash(host, operation) {
  if (host.kind === "local") return;
  const shell = await detectHostShell(host);
  if (shell.family !== "bash") {
    throw new Error(`${host.id} 已识别为远程 Windows PowerShell；${operation} 的远程 Windows 实现尚未开放，已阻止误用 Bash/WSL`);
  }
}
