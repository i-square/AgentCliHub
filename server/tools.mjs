// 领域逻辑：Codex CLI / Claude Code 的状态检查、npm 更新（含 rename 失败清理重试）、app-server 重启
import fs from "node:fs";
import path from "node:path";
import { runLocalPwsh, runRemoteBash } from "./exec.mjs";

export const TOOLS = {
  codex: { label: "Codex CLI", bin: "codex", npmPkg: "@openai/codex" },
  claude: { label: "Claude Code", bin: "claude", npmPkg: "@anthropic-ai/claude-code" }
};

// nvm 管理的 node 优先：用户的 CLI 通常装在 nvm 版本目录而非系统 node 下。
// 逐目录 prepend，glob 升序展开后最高版本最终位于 PATH 最前；无 ~/.nvm 时为无操作。
const AUTO_PRELUDE = [
  'for d in "$HOME"/.nvm/versions/node/*/bin; do',
  '  [ -x "$d/npm" ] && PATH="$d:$PATH"',
  "done",
  "export PATH"
].join("\n");

function bashPrelude(host) {
  const parts = [];
  if (host.prelude?.trim()) parts.push(host.prelude.trim());
  parts.push(AUTO_PRELUDE);
  return parts.join("\n");
}

/** 从 `codex-cli 0.156.1` / `2.1.280 (Claude Code)` 这类输出中提取 semver */
function extractSemver(text) {
  const m = /\d+\.\d+\.\d+/.exec(text ?? "");
  return m ? m[0] : "";
}

function parseStatusBlock(output) {
  const m = /__STATUS_BEGIN__([\s\S]*?)__STATUS_END__/.exec(output);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)=(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2];
  }
  return {
    npmRoot: fields.npmRoot ?? "",
    node: fields.node ?? "",
    codex: extractSemver(fields.codex),
    claude: extractSemver(fields.claude),
    latestCodex: extractSemver(fields.latestCodex),
    latestClaude: extractSemver(fields.latestClaude)
  };
}

function remoteStatusScript(host) {
  return `${bashPrelude(host)}
echo "__STATUS_BEGIN__"
echo "npmRoot=$(npm root -g 2>/dev/null)"
echo "node=$(node -v 2>/dev/null)"
echo "codex=$(codex --version 2>/dev/null | head -n 1)"
echo "claude=$(claude --version 2>/dev/null | head -n 1)"
echo "latestCodex=$(npm view ${TOOLS.codex.npmPkg} version 2>/dev/null | tail -n 1)"
echo "latestClaude=$(npm view ${TOOLS.claude.npmPkg} version 2>/dev/null | tail -n 1)"
echo "__STATUS_END__"`;
}

const LOCAL_STATUS_SCRIPT = `
$ErrorActionPreference = 'Continue'
function Get-CmdVersion($name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) {
    try { return (& $name --version 2>$null | Select-Object -First 1) } catch { return '' }
  }
  return ''
}
function Get-NpmView($pkg) {
  try { return (npm view $pkg version 2>$null | Select-Object -Last 1) } catch { return '' }
}
Write-Output '__STATUS_BEGIN__'
Write-Output ('npmRoot=' + ((npm root -g 2>$null) | Select-Object -Last 1))
Write-Output ('node=' + (node -v 2>$null))
Write-Output ('codex=' + (Get-CmdVersion codex))
Write-Output ('claude=' + (Get-CmdVersion claude))
Write-Output ('latestCodex=' + (Get-NpmView '${TOOLS.codex.npmPkg}'))
Write-Output ('latestClaude=' + (Get-NpmView '${TOOLS.claude.npmPkg}'))
Write-Output '__STATUS_END__'
`;

export async function checkHost(host, onData) {
  const result =
    host.kind === "local"
      ? await runLocalPwsh(LOCAL_STATUS_SCRIPT, { onData, timeoutMs: 120_000 })
      : await runRemoteBash(host.id, remoteStatusScript(host), { onData, timeoutMs: 120_000 });
  const status = parseStatusBlock(result.output);
  if (!status) throw new Error("未能解析状态输出，请检查主机连通性与 prelude 配置");
  return status;
}

function remoteUpdateScript(host, pkg) {
  return `${bashPrelude(host)}
echo "npmRoot=$(npm root -g 2>/dev/null)"
npm install -g "${pkg}@latest" 2>&1
echo "__EXIT_CODE__=$?"`;
}

function localUpdateScript(pkg) {
  return `
$ErrorActionPreference = 'Continue'
Write-Output ('npmRoot=' + ((npm root -g 2>$null) | Select-Object -Last 1))
npm install -g "${pkg}@latest" 2>&1 | ForEach-Object { $_.ToString() }
Write-Output ('__EXIT_CODE__=' + $LASTEXITCODE)
`;
}

function parseExitCode(output) {
  const m = /__EXIT_CODE__=(-?\d+)/.exec(output);
  return m ? Number(m[1]) : -1;
}

/** npm rename 失败时报错中的源/目标目录 */
function parseRenamePaths(output) {
  if (!/rename/i.test(output)) return [];
  const paths = [];
  for (const re of [/npm (?:error|ERR!) path (.+)$/gim, /npm (?:error|ERR!) dest (.+)$/gim]) {
    for (const m of output.matchAll(re)) paths.push(m[1].trim());
  }
  return [...new Set(paths)];
}

/** 只允许删除 npm 全局 node_modules 内的目录，防止误删 */
function pathsUnderNpmRoot(npmRoot, paths) {
  if (!npmRoot) return [];
  const normRoot = npmRoot.replace(/[\\/]+$/, "").toLowerCase();
  return paths.filter((p) => {
    const norm = p.replace(/[\\/]+$/, "").toLowerCase();
    return norm.startsWith(normRoot + "/") || norm.startsWith(normRoot + "\\");
  });
}

async function deletePaths(host, paths, onData) {
  if (host.kind === "local") {
    for (const p of paths) {
      onData(`[cleanup] 删除 ${p}\n`);
      await fs.promises.rm(p, { recursive: true, force: true });
    }
  } else {
    const quoted = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
    await runRemoteBash(host.id, `rm -rf -- ${quoted}`, {
      onData: (c) => onData(`[cleanup] rm -rf ${paths.join(" , ")}${c ? `\n${c}` : "\n"}`)
    });
  }
}

async function runNpmInstall(host, pkg, onData) {
  const result =
    host.kind === "local"
      ? await runLocalPwsh(localUpdateScript(pkg), { onData, timeoutMs: 600_000 })
      : await runRemoteBash(host.id, remoteUpdateScript(host, pkg), { onData, timeoutMs: 600_000 });
  const npmRoot = /npmRoot=(.+)/.exec(result.output)?.[1]?.trim() ?? "";
  return { code: parseExitCode(result.output), output: result.output, npmRoot };
}

export async function updateTool(host, toolId, onData) {
  const tool = TOOLS[toolId];
  if (!tool) throw new Error(`未知工具: ${toolId}`);

  let attempt = await runNpmInstall(host, tool.npmPkg, onData);
  if (attempt.code === 0) return { ok: true, retried: false };

  const candidates = pathsUnderNpmRoot(attempt.npmRoot, parseRenamePaths(attempt.output));
  if (candidates.length === 0) {
    throw new Error(
      "npm 更新失败且未匹配到可自动清理的 rename 目录；若是文件占用（如 app-server 正在运行），请先重启 app-server 再更新。详见日志。"
    );
  }

  onData(`\n[retry] 检测到 rename 失败，清理残留目录后重试一次……\n`);
  await deletePaths(host, candidates, onData);
  attempt = await runNpmInstall(host, tool.npmPkg, onData);
  if (attempt.code !== 0) {
    throw new Error("清理后重试仍失败，请查看日志手动处理");
  }
  return { ok: true, retried: true };
}

function remoteRestartScript(host) {
  return `${bashPrelude(host)}
pids=$(pgrep -f "codex.*app-server" || true)
if [ -n "$pids" ]; then
  echo "发现 app-server 进程: $(echo $pids | tr '\\n' ' ')"
  pkill -f "codex.*app-server"
  sleep 1
  if pgrep -f "codex.*app-server" >/dev/null; then
    echo "WARN: 仍有 app-server 进程存活"
    exit 1
  else
    echo "已停止。Codex desktop 重连后会自动拉起新版本。"
  fi
else
  echo "当前没有运行中的 app-server"
fi`;
}

const LOCAL_RESTART_SCRIPT = `
$ErrorActionPreference = 'Continue'
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'app-server' -and $_.CommandLine -match 'codex'
}
if ($procs) {
  foreach ($p in $procs) {
    Write-Output ("停止进程 PID=" + $p.ProcessId + " : " + $p.Name)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
  }
  Write-Output '已停止。Codex desktop 重连后会自动拉起新版本。'
} else {
  Write-Output '当前没有运行中的 app-server'
}
`;

export async function restartAppServer(host, onData) {
  const result =
    host.kind === "local"
      ? await runLocalPwsh(LOCAL_RESTART_SCRIPT, { onData, timeoutMs: 60_000 })
      : await runRemoteBash(host.id, remoteRestartScript(host), { onData, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error("app-server 重启失败，详见日志");
  return { ok: true };
}

export function isLocalHost(host) {
  return host.kind === "local";
}


