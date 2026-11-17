// 维护操作：旧版本清理（保留 current + 最新 N 个，跳过运行中进程占用）与 PATH 可选修复。
// PATH 修复默认不主动执行，仅在用户显式触发时运行；Bash 环境写置顶块，Windows 写注册表用户 PATH。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHostPwsh, runHostBash } from "./hostShell.mjs";
import { bashPathExpr, windowsPathExpr, pwshQuote as psq, readText, writeTextAtomic } from "./hostFiles.mjs";
import { requireCapability } from "./capabilities.mjs";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

// ---------- 旧版本清理 ----------

/**
 * @param {object} host
 * @param {"codex"|"claude"} tool
 * @param {number} keep 保留的最新版本数（不含 current 指向的）
 * @param {string} installDir 该主机该工具实际生效的入口目录（用于定位 claude 的 current）
 */
export async function cleanupTool(host, tool, keep = 2, onData = () => {}, installDir = "~/.local/bin") {
  const runtime = await requireCapability(host, "cleanup");
  const script = runtime.family === "windows" ? windowsCleanupScript(tool, keep, installDir) : bashCleanupScript(tool, keep, installDir);
  const r = runtime.family === "windows"
    ? await runHostPwsh(host, script, { onData, timeoutMs: 120_000 })
    : await runHostBash(host, script, { onData, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error("清理失败，详见日志");
  return "清理完成";
}

/** Linux 清理：只删版本库下的项，跳过 current 指向、最新 N 个与运行中进程占用 */
function bashCleanupScript(tool, keep, installDir) {
  const listDir = tool === "codex"
    ? '"$HOME/.codex/packages/standalone/releases"'
    : '"$HOME/.local/share/claude/versions"';
  // codex 的 current 是固定链接；claude 的 current 是实际生效 installDir 下入口链接的指向
  const currentExpr = tool === "codex"
    ? 'readlink -f "$HOME/.codex/packages/standalone/current" 2>/dev/null'
    : `readlink -f ${bashPathExpr(installDir)}/claude 2>/dev/null`;
  return `set -eu
KEEP=${keep}
LIST=${listDir}
[ -d "$LIST" ] || { echo "无版本库目录，无需清理"; exit 0; }
CURRENT=$(${currentExpr} || true)
echo "current: \${CURRENT:-none}"
# 运行中占用：读 /proc/<pid>/exe（经 PATH 启动的进程 cmdline 里没有完整路径，不能用 cmdline 匹配）
# 比较对象均为 realpath（~/.codex 可能是软链接）
in_use() {
  real="$1"
  for p in /proc/[0-9]*/exe; do
    t=$(readlink "$p" 2>/dev/null) || continue
    case "$t" in "$real"|"$real"/*|"$real (deleted)") return 0 ;; esac
  done
  return 1
}
# 版本倒序（sort -V），保留前 KEEP 个
i=0
for item in $(ls "$LIST" 2>/dev/null | sort -rV); do
  case "$item" in .*) continue ;; esac
  full="$LIST/$item"
  real=$(readlink -f "$full" 2>/dev/null || echo "$full")
  i=$((i+1))
  if [ -n "$CURRENT" ] && [ "$real" = "$CURRENT" ]; then
    echo "保留(current): $item"; continue
  fi
  if [ $i -le $KEEP ]; then echo "保留(最新): $item"; continue; fi
  if in_use "$real"; then echo "保留(运行中): $item"; continue; fi
  echo "删除: $item"
  rm -rf -- "$full"
done
echo "__CLEANUP_OK__"`;
}

/** Windows 清理：路径始终在目标机展开。 */
function windowsCleanupScript(tool, keep, installDir) {
  const listDir = tool === "codex" ? "~/.codex/packages/standalone/releases" : "~/.local/share/claude/versions";
  const currentPath = windowsPathExpr("~/.codex/packages/standalone/current");
  const claudeExe = `(Join-Path ${windowsPathExpr(installDir)} 'claude.exe')`;
  return `
$ErrorActionPreference = 'Stop'
$keep = ${keep}
$tool = ${psq(tool)}
$list = ${windowsPathExpr(listDir)}
if (-not (Test-Path $list)) { Write-Output '无版本库目录，无需清理'; exit 0 }
# 版本号：只取 \\d+.\\d+.\\d+（目录名 0.162.1-x86_64-... 或文件名 2.1.287.exe），避免尾部 "." 让 [version] 转换抛异常
function Get-Ver($name) { if ($name -match '(\\d+\\.\\d+\\.\\d+)') { return [version]$Matches[1] } return [version]'0.0.0' }
# current：codex 取 current junction 目标；claude 入口是复制件（无链接），取入口 exe 自报的版本
$current = ''; $curVer = $null
if ($tool -eq 'codex') {
  if (Test-Path -LiteralPath ${currentPath}) { $current = [string](Get-Item -LiteralPath ${currentPath}).Target }
} elseif (Test-Path -LiteralPath ${claudeExe}) {
  $o = (& ${claudeExe} --version 2>&1 | Select-Object -First 1)
  if ("$o" -match '(\\d+\\.\\d+\\.\\d+)') { $curVer = [version]$Matches[1] }
  else { throw '无法识别当前 Claude 版本，停止清理' }
}
Write-Output ("current: " + $current + $curVer)
# 运行中占用：进程可执行路径
$busy = @{}
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { $busy[$_.ExecutablePath] = $true }
$items = Get-ChildItem -LiteralPath $list | Where-Object { $_.Name -notlike '.*' } | Sort-Object { Get-Ver $_.Name } -Descending
$i = 0
foreach ($it in $items) {
  $i++
  $full = $it.FullName
  if ($current -and ($full -eq $current -or $current.StartsWith($full))) { Write-Output ("保留(current): " + $it.Name); continue }
  if ($curVer -and (Get-Ver $it.Name) -eq $curVer) { Write-Output ("保留(current): " + $it.Name); continue }
  if ($i -le $keep) { Write-Output ("保留(最新): " + $it.Name); continue }
  $inUse = $false
  if ($it.PSIsContainer) {
    Get-ChildItem $full -Recurse -File -Include *.exe -ErrorAction SilentlyContinue | ForEach-Object { if ($busy.ContainsKey($_.FullName)) { $inUse = $true } }
  } elseif ($busy.ContainsKey($full)) { $inUse = $true }
  if ($inUse) { Write-Output ("保留(运行中): " + $it.Name); continue }
  Write-Output ("删除: " + $it.Name)
  Remove-Item -LiteralPath $full -Recurse -Force
}
Write-Output '__CLEANUP_OK__'`;
}

// ---------- PATH 修复（显式触发，带备份） ----------

/** 显式拆分冒号分隔的 PATH，兼容 Bash/zsh，不改变用户 shell 的 glob/IFS 选项。 */
export function buildManagedPathBlock(installDir) {
  return [
    "# >>> AgentCliHub managed PATH",
    `_ach_dir=${bashPathExpr(installDir)}`,
    '_ach_rest=""',
    '_ach_path=$PATH',
    'while [ -n "$_ach_path" ]; do',
    '  case "$_ach_path" in',
    '    *:*) _ach_p=${_ach_path%%:*}; _ach_path=${_ach_path#*:} ;;',
    '    *) _ach_p=$_ach_path; _ach_path="" ;;',
    '  esac',
    '  [ -n "$_ach_p" ] && [ "$_ach_p" != "$_ach_dir" ] && _ach_rest="${_ach_rest:+$_ach_rest:}$_ach_p"',
    "done",
    'PATH="$_ach_dir${_ach_rest:+:$_ach_rest}"',
    "export PATH",
    "unset _ach_dir _ach_rest _ach_path _ach_p",
    "# <<< AgentCliHub managed PATH"
  ].join("\n");
}

/** 只替换完整的托管块；损坏的边界必须报错，避免吞掉用户的后续配置。 */
export function editManagedPathRc(text, installDir) {
  const begin = "# >>> AgentCliHub managed PATH";
  const end = "# <<< AgentCliHub managed PATH";
  const block = buildManagedPathBlock(installDir);
  const lines = text.split(/\r?\n/);
  const result = [];
  let inside = false;
  let replaced = false;
  for (const line of lines) {
    if (line === begin) {
      if (inside) throw new Error("PATH 托管块边界重复，已中止写入");
      inside = true;
      if (!replaced) result.push(block);
      replaced = true;
    } else if (line === end) {
      if (!inside) throw new Error("PATH 托管块缺少起始标记，已中止写入");
      inside = false;
    } else if (!inside) result.push(line);
  }
  if (inside) throw new Error("PATH 托管块缺少结束标记，已中止写入");
  if (!replaced) result.push("", block);
  return result.join("\n").replace(/\n*$/, "\n");
}

/** 目标机负责提供默认 shell；读改写与备份共用文件层。 */
async function repairPathBash(host, installDir, onData = () => {}) {
  const result = await runHostBash(host, 'printf "__ACH_LOGIN_SHELL__=%s\\n" "${SHELL:-bash}"', { timeoutMs: 30_000 });
  const loginShell = /^__ACH_LOGIN_SHELL__=([^\r\n]+)\r?$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !loginShell) throw new Error("无法识别目标机默认 shell，已中止 PATH 修复");
  const rcPath = path.posix.basename(loginShell) === "zsh" ? "~/.zshrc" : "~/.bashrc";
  for (const target of ["~/.profile", rcPath]) {
    const cur = await readText(host, target);
    if (cur.state === "error") throw new Error(`读取 ${target} 失败，已中止 PATH 修复：${cur.reason}`);
    const old = cur.content ?? "";
    const next = editManagedPathRc(old, installDir);
    if (old !== next) await writeTextAtomic(host, target, next, { onData });
    else onData(`${target} 的 PATH 已匹配，无需修改\n`);
  }
  return "PATH 修复完成（重开终端生效）";
}

/** Windows：修改注册表前在目标机备份，并在 hub 留存副本。 */
async function repairPathWindows(host, installDir, onData = () => {}) {
  const backupDir = path.join(dataDir, "path-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
$dir = ${windowsPathExpr(installDir)}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$backupDir = Join-Path $HOME '.agentclihub/path-backups'
[IO.Directory]::CreateDirectory($backupDir) | Out-Null
$backupFile = Join-Path $backupDir ('user-path-' + [Guid]::NewGuid().ToString('N') + '.txt')
[IO.File]::WriteAllText($backupFile, [string]$userPath)
Write-Output ('已备份旧 PATH 到 ' + $backupFile)
Write-Output ("旧 user PATH: " + $userPath)
$entries = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })
$newPath = (@($dir) + $entries) -join ';'
Write-Output ("新 user PATH: " + $newPath)
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
Write-Output ("__NEW_PATH__=" + $newPath)
Write-Output '__PATH_OK__'`;
  const r = await runHostPwsh(host, script, { onData, timeoutMs: 30_000 });
  if (r.code !== 0 || !r.output.includes("__PATH_OK__")) throw new Error("注册表 PATH 写入失败，详见日志");
  const m = /__NEW_PATH__=([^\r\n]+)/.exec(r.output);
  const backup = path.join(backupDir, `user-path-${encodeURIComponent(host.id)}-${Date.now()}.txt`);
  const before = /旧 user PATH: ([^\r\n]*)/.exec(r.output)?.[1] ?? "";
  fs.writeFileSync(backup, before, "utf8");
  // hub 进程内立即生效（新终端由系统广播负责）
  if (m && host.kind === "local") process.env.Path = `${m[1]};${process.env.Path ?? ""}`;
  onData(`已备份旧 PATH 到 ${backup}\n`);
  return "PATH 修复完成（新开的终端生效）";
}

export async function repairPath(host, installDir, onData = () => {}) {
  const runtime = await requireCapability(host, "pathRepair");
  return runtime.family === "windows"
    ? repairPathWindows(host, installDir, onData)
    : repairPathBash(host, installDir, onData);
}
