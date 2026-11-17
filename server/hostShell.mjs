// 主机 shell 识别与对应执行器。
// SSH 默认 shell 与最终命令环境必须一致，禁止在 Windows OpenSSH 中无条件进入 WSL bash。
import { runProcess, runSsh } from "./exec.mjs";
import { detectLocalPlatform } from "./platform.mjs";

const WINDOWS_MARKER = "__ACH_WINDOWS_POWERSHELL__";
const BASH_MARKER = "__ACH_BASH_SHELL__";

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

/** 简单依赖参数用于四种环境的契约测试；生产使用文件末尾的默认实例。 */
export function createHostShell({ run = runProcess, ssh = runSsh, localPlatform = detectLocalPlatform } = {}) {
  const shellCache = new Map();
  const runtimeCache = new Map();
  const knownRuntimes = new Map();
  const cacheKey = (host) => JSON.stringify([host.id, host.kind, host.shell, host.hostName, host.user, host.port]);

  function executeBash(host, script, opts = {}) {
    if (host.kind === "local") return run("bash", ["-c", script], opts);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    // 脚本经命令参数传递，stdin 完整留给文件内容；不能再使用 `... | bash`。
    return ssh(host.id, `bash -c "$(printf '%s' '${encoded}' | base64 -d)"`, opts);
  }

  function executePwsh(host, shell, script, opts = {}) {
    const source = host.kind === "local" ? script : `${WINDOWS_SSH_PATH_PRELUDE}\n${script}`;
    const encoded = Buffer.from(source, "utf16le").toString("base64");
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    return host.kind === "local"
      ? run(shell.executable, args, opts)
      : ssh(host.id, `${shell.executable} ${args.join(" ")}`, opts);
  }

  async function detectRemoteShell(host) {
    // 该标记命令在 PowerShell 中成功，在 bash 中只是不存在的命令；不会修改目标环境。
    const windows = await ssh(
      host.id,
      `Write-Output '${WINDOWS_MARKER}'; Write-Output $PSVersionTable.PSEdition`,
      { timeoutMs: 20_000 }
    );
    const parsed = parseWindowsShellProbe(windows.stdout);
    if (windows.code === 0 && parsed) return parsed;
    if (windows.stdout.split(/\r?\n/).includes(WINDOWS_MARKER)) {
      throw new Error(`${host.id} 已检测到 PowerShell，但无法识别 Core/Desktop；请显式配置 shell=pwsh 或 shell=powershell`);
    }

    const bash = await executeBash(host, `printf '${BASH_MARKER}\\n'`, { timeoutMs: 20_000 });
    if (bash.code === 0 && bash.stdout.split(/\r?\n/).includes(BASH_MARKER)) {
      return { family: "bash", executable: "bash", source: "detected" };
    }
    throw new Error(`无法识别 ${host.id} 的 SSH shell；请在 hostOverrides.${host.id}.shell 中显式配置 pwsh、powershell 或 bash`);
  }

  /** 本机直接取进程平台；SSH 结果仅在当前 hub 进程内缓存。 */
  async function detectHostShell(host) {
    if (host.kind === "local") {
      const platform = localPlatform();
      return platform.sysname === "windows"
        ? { family: "windows", executable: "pwsh", source: "local" }
        : { family: "bash", executable: "bash", source: "local" };
    }
    if (host.kind !== "ssh") throw new Error(`未知连接方式: ${host.kind}`);
    const override = normalizeShellOverride(host.shell);
    if (override) return override;
    const key = cacheKey(host);
    if (!shellCache.has(key)) {
      const pending = detectRemoteShell(host);
      shellCache.set(key, pending);
      try {
        await pending;
      } catch (error) {
        shellCache.delete(key);
        throw error;
      }
    }
    return shellCache.get(key);
  }

  async function runHostPwsh(host, script, opts = {}) {
    const shell = await detectHostShell(host);
    if (shell.family !== "windows") throw new Error(`${host.id} 不是 Windows PowerShell 环境`);
    return executePwsh(host, shell, script, opts);
  }

  async function runHostBash(host, script, opts = {}) {
    const shell = await detectHostShell(host);
    if (shell.family !== "bash") throw new Error(`${host.id} 不是 Bash 环境`);
    return executeBash(host, script, opts);
  }

  async function resolveRuntime(host) {
    const shell = await detectHostShell(host);
    if (host.kind === "local") return { transport: "local", ...shell, platform: localPlatform() };
    const key = cacheKey(host);
    if (!runtimeCache.has(key)) {
      const pending = (async () => {
        const script = shell.family === "windows"
          ? "$ErrorActionPreference = 'Stop'\n$arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }; Write-Output ('__ACH_PLATFORM__=windows|' + $arch + '|')"
          : "set -e\nsys=$(uname -s); machine=$(uname -m); libc=''; if [ \"$sys\" = Linux ]; then libc=glibc; if (ldd --version 2>&1 || true) | grep -qi musl; then libc=musl; fi; fi\nprintf '__ACH_PLATFORM__=%s|%s|%s\\n' \"$sys\" \"$machine\" \"$libc\"";
        const result = shell.family === "windows"
          ? await executePwsh(host, shell, script, { timeoutMs: 30_000 })
          : await executeBash(host, script, { timeoutMs: 30_000 });
        const match = /^__ACH_PLATFORM__=([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]*)\r?$/m.exec(result.stdout);
        if (result.code !== 0 || !match) throw new Error(`无法识别 ${host.id} 的目标平台（exit=${result.code}）`);
        const sysname = match[1].toLowerCase();
        const platform = detectLocalPlatform({ platform: sysname === "windows" ? "win32" : sysname, arch: match[2], libc: match[3] });
        if ((platform.sysname === "windows") !== (shell.family === "windows")) {
          throw new Error(`${host.id} 的 shell 与目标平台不一致，请检查 shell 覆盖`);
        }
        const runtime = { transport: "ssh", ...shell, platform };
        knownRuntimes.set(key, runtime);
        return runtime;
      })();
      runtimeCache.set(key, pending);
      try { await pending; } catch (error) { runtimeCache.delete(key); throw error; }
    }
    return runtimeCache.get(key);
  }

  function getKnownRuntime(host) {
    if (host.kind !== "local") return knownRuntimes.get(cacheKey(host));
    const platform = localPlatform();
    return { transport: "local", family: platform.sysname === "windows" ? "windows" : "bash", executable: platform.sysname === "windows" ? "pwsh" : "bash", platform };
  }

  return { detectHostShell, resolveRuntime, getKnownRuntime, runHostPwsh, runHostBash };
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

export const { detectHostShell, resolveRuntime, getKnownRuntime, runHostPwsh, runHostBash } = createHostShell();
