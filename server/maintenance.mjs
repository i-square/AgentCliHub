// 维护操作：旧版本清理（保留 current + 最新 N 个，跳过运行中进程占用）与 PATH 可选修复。
// PATH 修复默认不主动执行，仅在用户显式触发时运行；远程写 managed 置顶块，本机写注册表用户 PATH。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalPwsh, runRemoteBash } from "./exec.mjs";
import { remotePathExpr, expandHomeLocal } from "./install.mjs";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- 旧版本清理 ----------

/**
 * @param {object} host
 * @param {"codex"|"claude"} tool
 * @param {number} keep 保留的最新版本数（不含 current 指向的）
 * @param {string} installDir 该主机该工具实际生效的入口目录（用于定位 claude 的 current）
 */
export async function cleanupTool(host, tool, keep = 2, onData = () => {}, installDir = "~/.local/bin") {
  const script = host.kind === "local" ? localCleanupScript(tool, keep, installDir) : remoteCleanupScript(tool, keep, installDir);
  const r = host.kind === "local"
    ? await runLocalPwsh(script, { onData, timeoutMs: 120_000 })
    : await runRemoteBash(host.id, script, { onData, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error("清理失败，详见日志");
  return "清理完成";
}

/** 远程清理：只删版本库下的项，跳过 current 指向、最新 N 个与运行中进程占用 */
function remoteCleanupScript(tool, keep, installDir) {
  const listDir = tool === "codex"
    ? '"$HOME/.codex/packages/standalone/releases"'
    : '"$HOME/.local/share/claude/versions"';
  // codex 的 current 是固定链接；claude 的 current 是实际生效 installDir 下入口链接的指向
  const currentExpr = tool === "codex"
    ? 'readlink -f "$HOME/.codex/packages/standalone/current" 2>/dev/null'
    : `readlink -f ${remotePathExpr(installDir)}/claude 2>/dev/null`;
  return `set -u
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

/** 本机 Windows 清理 */
function localCleanupScript(tool, keep, installDir) {
  const root = path.join(os.homedir(), ".codex", "packages", "standalone");
  const listDir = tool === "codex" ? path.join(root, "releases") : path.join(os.homedir(), ".local", "share", "claude", "versions");
  const currentPath = path.join(root, "current");
  const claudeExe = path.join(expandHomeLocal(installDir), "claude.exe");
  const psq = (s) => `'${s.replace(/'/g, "''")}'`;
  return `
$ErrorActionPreference = 'Continue'
$keep = ${keep}
$tool = ${psq(tool)}
$list = ${psq(listDir)}
if (-not (Test-Path $list)) { Write-Output '无版本库目录，无需清理'; exit 0 }
# 版本号：只取 \\d+.\\d+.\\d+（目录名 0.162.1-x86_64-... 或文件名 2.1.287.exe），避免尾部 "." 让 [version] 转换抛异常
function Get-Ver($name) { if ($name -match '(\\d+\\.\\d+\\.\\d+)') { return [version]$Matches[1] } return [version]'0.0.0' }
# current：codex 取 current junction 目标；claude 入口是复制件（无链接），取入口 exe 自报的版本
$current = ''; $curVer = $null
if ($tool -eq 'codex') {
  if (Test-Path ${psq(currentPath)}) { try { $current = [string](Get-Item ${psq(currentPath)}).Target } catch {} }
} elseif (Test-Path ${psq(claudeExe)}) {
  try { $o = (& ${psq(claudeExe)} --version 2>&1 | Select-Object -First 1); if ("$o" -match '(\\d+\\.\\d+\\.\\d+)') { $curVer = [version]$Matches[1] } } catch {}
}
Write-Output ("current: " + $current + $curVer)
# 运行中占用：进程可执行路径
$busy = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath } | ForEach-Object { $busy[$_.ExecutablePath] = $true }
$items = Get-ChildItem $list -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '.*' } | Sort-Object { Get-Ver $_.Name } -Descending
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
  Remove-Item $full -Recurse -Force -ErrorAction Continue
}
Write-Output '__CLEANUP_OK__'`;
}

// ---------- PATH 修复（显式触发，带备份） ----------

/** 远程：把 installDir 以「去重置顶」managed 块写入 ~/.profile 与 shell rc（幂等 + 备份） */
export async function repairPathRemote(host, installDir, onData = () => {}) {
  const dirExpr = remotePathExpr(installDir);
  const block = [
    "# >>> AgentCliHub managed PATH",
    `_ach_dir=${dirExpr}`,
    "set -f",
    "_ach_oldifs=$IFS; IFS=:",
    '_ach_rest=""',
    "for _ach_p in $PATH; do",
    '  [ -n "$_ach_p" ] && [ "$_ach_p" != "$_ach_dir" ] && _ach_rest="${_ach_rest:+$_ach_rest:}$_ach_p"',
    "done",
    "IFS=$_ach_oldifs; set +f",
    'PATH="$_ach_dir${_ach_rest:+:$_ach_rest}"',
    "export PATH",
    "unset _ach_dir _ach_rest _ach_oldifs _ach_p",
    "# <<< AgentCliHub managed PATH"
  ].join("\n");
  const b64 = Buffer.from(block, "utf8").toString("base64");
  // 写入策略：已有块则 awk 整块替换；否则追加到文件尾（保证在 nvm 初始化之后执行）
  const script = [
    "set -eu",
    `BLOCK_B64=${sq(b64)}`,
    "write_rc() {",
    '  rc="$1"',
    '  [ -f "$rc" ] || : > "$rc"',
    '  if grep -qF "# >>> AgentCliHub managed PATH" "$rc" 2>/dev/null; then',
    '    cp -p "$rc" "$rc.agentclihub.bak"',
    '    echo "$BLOCK_B64" | base64 -d > "$rc.agentclihub-block"',
    `    awk 'BEGIN{inblock=0; readblock=0}`,
    `      /^# >>> AgentCliHub managed PATH/ { if (!readblock) { while ((getline line < (rc ".agentclihub-block")) > 0) print line; readblock=1 }; inblock=1; next }`,
    `      /^# <<< AgentCliHub managed PATH/ { inblock=0; next }`,
    `      !inblock { print }' rc="$rc" "$rc" > "$rc.agentclihub-tmp"`,
    '    mv "$rc.agentclihub-tmp" "$rc"',
    '    rm -f "$rc.agentclihub-block"',
    '    echo "已更新块: $rc（备份 $rc.agentclihub.bak）"',
    "  else",
    '    cp -p "$rc" "$rc.agentclihub.bak" 2>/dev/null || true',
    '    { echo ""; echo "$BLOCK_B64" | base64 -d; } >> "$rc"',
    '    echo "已追加块: $rc"',
    "  fi",
    "}",
    'shell_name=$(basename "${SHELL:-bash}")',
    'write_rc "$HOME/.profile"',
    'if [ "$shell_name" = "zsh" ]; then write_rc "$HOME/.zshrc"; else write_rc "$HOME/.bashrc"; fi',
    'echo "__PATH_OK__"'
  ].join("\n");
  const r = await runRemoteBash(host.id, script, { onData, timeoutMs: 60_000 });
  if (r.code !== 0 || !r.output.includes("__PATH_OK__")) throw new Error("远程 PATH 修复失败，详见日志");
  return "PATH 修复完成（重开终端生效）";
}

/** 本机：注册表用户 PATH 去重置顶 installDir（备份到 data/path-backups/） */
export async function repairPathLocal(installDir, onData = () => {}) {
  const dir = installDir.trim() === "~" ? os.homedir()
    : installDir.startsWith("~/") || installDir.startsWith("~\\") ? path.join(os.homedir(), installDir.slice(2))
    : installDir;
  const psq = (s) => `'${s.replace(/'/g, "''")}'`;
  const backupDir = path.join(dataDir, "path-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
$dir = ${psq(dir)}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Output ("旧 user PATH: " + $userPath)
$entries = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })
$newPath = (@($dir) + $entries) -join ';'
Write-Output ("新 user PATH: " + $newPath)
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
Write-Output ("__NEW_PATH__=" + $newPath)
Write-Output '__PATH_OK__'`;
  const r = await runLocalPwsh(script, { onData, timeoutMs: 30_000 });
  if (r.code !== 0 || !r.output.includes("__PATH_OK__")) throw new Error("注册表 PATH 写入失败，详见日志");
  const m = /__NEW_PATH__=([^\r\n]+)/.exec(r.output);
  const backup = path.join(backupDir, `user-path-${Date.now()}.txt`);
  const before = /旧 user PATH: ([^\r\n]*)/.exec(r.output)?.[1] ?? "";
  fs.writeFileSync(backup, before, "utf8");
  // hub 进程内立即生效（新终端由系统广播负责）
  if (m) process.env.Path = `${dir};${process.env.Path}`;
  onData(`已备份旧 PATH 到 ${backup}\n`);
  return "PATH 修复完成（新开的终端生效）";
}
