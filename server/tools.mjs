// 领域逻辑：Codex CLI / Claude Code 的状态检查、npm 更新（含 rename 失败清理重试）、app-server 重启、模型目录推送
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLocalPwsh, runRemoteBash, runRemoteCmd } from "./exec.mjs";

export const TOOLS = {
  codex: { label: "Codex CLI", bin: "codex", npmPkg: "@openai/codex" },
  claude: { label: "Claude Code", bin: "claude", npmPkg: "@anthropic-ai/claude-code" }
};

export const DEFAULT_CATALOG_TARGET = "~/.codex/models.json";

// nvm 管理的 node 优先：用户的 CLI 通常装在 nvm 版本目录而非系统 node 下。
// 逐目录 prepend，glob 升序展开后最高版本最终位于 PATH 最前；无 ~/.nvm 时为无操作。
const AUTO_PRELUDE = [
  "for d in \"$HOME\"/.nvm/versions/node/*/bin; do",
  "  [ -x \"$d/npm\" ] && PATH=\"$d:$PATH\"",
  "done",
  "export PATH"
].join("\n");

function bashPrelude(host) {
  const parts = [];
  if (host.prelude?.trim()) parts.push(host.prelude.trim());
  parts.push(AUTO_PRELUDE);
  return parts.join("\n");
}

/** bash 单引号包裹（内含单引号的安全转义） */
function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 目标路径在远程 bash 中的展开表达式：~/ 前缀交给 $HOME，其余按字面量 */
function remotePathExpr(p) {
  const t = (p ?? "").trim();
  if (t === "~") return '"$HOME"';
  if (t.startsWith("~/")) return `"$HOME/${t.slice(2).replace(/["$`\\]/g, "\\$&")}"`;
  return sq(t);
}

/** 本机路径展开：~ 前缀替换为 os.homedir() */
function expandHomeLocal(p) {
  const t = (p ?? "").trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(os.homedir(), t.slice(2));
  return t;
}

/** 路径等价比较：展开 ~、统一分隔符；本机 Windows 不区分大小写 */
function normalizeCatalogPath(p, home, caseInsensitive) {
  let s = (p ?? "").trim();
  if (!s) return "";
  if (s === "~") s = home;
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = home.replace(/[\\/]+$/, "") + "/" + s.slice(2);
  s = s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? s.toLowerCase() : s;
}

/**
 * catalog 推送就绪判定（仅提示与门控，不修改目标机 config.toml）：
 * config.toml 开启了 model_catalog_json 且路径与 hub 设置的目标路径一致，才允许推送。
 */
export function catalogReadiness(host, st, targetPath) {
  if (!st?.checkedAt || st.catalogJson === undefined) {
    return { ready: false, reason: "尚未采集该主机的 catalog 配置，请先执行一次「检查」" };
  }
  const configured = (st.catalogJson ?? "").trim();
  if (!configured) {
    return { ready: false, reason: "该主机 config.toml 未开启 model_catalog_json，codex 不会加载本地 catalog 文件" };
  }
  const home = host.kind === "local" ? os.homedir() : st.home ?? "~";
  const caseInsensitive = host.kind === "local";
  if (normalizeCatalogPath(configured, home, caseInsensitive) !== normalizeCatalogPath(targetPath, home, caseInsensitive)) {
    return { ready: false, reason: `config.toml 中的路径「${configured}」与目标路径「${targetPath}」不一致` };
  }
  return { ready: true, reason: "" };
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
    latestClaude: extractSemver(fields.latestClaude),
    home: fields.home ?? "",
    catalogJson: fields.catalogJson ?? "",
    catalogHash: fields.catalogHash ?? ""
  };
}

function remoteStatusScript(host, catalogTarget) {
  return `${bashPrelude(host)}
echo "__STATUS_BEGIN__"
echo "npmRoot=$(npm root -g 2>/dev/null)"
echo "node=$(node -v 2>/dev/null)"
echo "codex=$(codex --version 2>/dev/null | head -n 1)"
echo "claude=$(claude --version 2>/dev/null | head -n 1)"
echo "latestCodex=$(npm view ${TOOLS.codex.npmPkg} version 2>/dev/null | tail -n 1)"
echo "latestClaude=$(npm view ${TOOLS.claude.npmPkg} version 2>/dev/null | tail -n 1)"
echo "home=$HOME"
cfg="$HOME/.codex/config.toml"
mcj=$(grep -E "^[[:space:]]*model_catalog_json[[:space:]]*=" "$cfg" 2>/dev/null | head -n 1 | sed -E "s/^[^\\"]*\\"([^\\"]*)\\".*$/\\1/")
echo "catalogJson=$mcj"
t=${remotePathExpr(catalogTarget)}
if [ -f "$t" ]; then
  h=$(sha256sum "$t" 2>/dev/null | cut -c1-12)
  [ -z "$h" ] && h=$(shasum -a 256 "$t" 2>/dev/null | cut -c1-12)
  [ -z "$h" ] && h=$(openssl dgst -sha256 "$t" 2>/dev/null | sed -E "s/.*= //" | cut -c1-12)
  echo "catalogHash=$h"
else
  echo "catalogHash="
fi
echo "__STATUS_END__"`;
}

function localStatusScript(catalogTarget) {
  const targetPs = expandHomeLocal(catalogTarget).replace(/'/g, "''");
  return `
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
function Get-CatalogHash($p) {
  if (Test-Path $p) { try { return (Get-FileHash -Algorithm SHA256 $p).Hash.Substring(0,12).ToLower() } catch { return '' } }
  return ''
}
Write-Output '__STATUS_BEGIN__'
Write-Output ('npmRoot=' + ((npm root -g 2>$null) | Select-Object -Last 1))
Write-Output ('node=' + (node -v 2>$null))
Write-Output ('codex=' + (Get-CmdVersion codex))
Write-Output ('claude=' + (Get-CmdVersion claude))
Write-Output ('latestCodex=' + (Get-NpmView '${TOOLS.codex.npmPkg}'))
Write-Output ('latestClaude=' + (Get-NpmView '${TOOLS.claude.npmPkg}'))
Write-Output ('home=' + $HOME)
$mcj = ''
$cfg = Join-Path $HOME '.codex\\config.toml'
if (Test-Path $cfg) {
  $hit = Select-String -Path $cfg -Pattern '^\\s*model_catalog_json\\s*=\\s*"([^"]*)"' | Select-Object -First 1
  if ($hit) { $mcj = $hit.Matches[0].Groups[1].Value }
}
Write-Output ('catalogJson=' + $mcj)
Write-Output ('catalogHash=' + (Get-CatalogHash '${targetPs}'))
Write-Output '__STATUS_END__'
`;
}

export async function checkHost(host, onData, catalogTarget = DEFAULT_CATALOG_TARGET) {
  const result =
    host.kind === "local"
      ? await runLocalPwsh(localStatusScript(catalogTarget), { onData, timeoutMs: 120_000 })
      : await runRemoteBash(host.id, remoteStatusScript(host, catalogTarget), { onData, timeoutMs: 120_000 });
  const status = parseStatusBlock(result.output);
  if (!status) throw new Error("未能解析状态输出，请检查主机连通性与 prelude 配置");
  return status;
}

/**
 * 推送合并后的 catalog 到目标主机：原子写入目标路径 + 删除 models_cache.json。
 * 本机直接用 fs；远程经 ssh stdin 传输 base64 内容（避开命令行长度上限），
 * cache 删除用 \rm 显式绕过 rm -i 类 alias 造成的交互阻塞。
 */
export async function pushCatalog(host, rendered, { targetPath, onData }) {
  if (host.kind === "local") {
    const target = expandHomeLocal(targetPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.AgentCliHub-tmp`;
    await fs.promises.writeFile(tmp, rendered, "utf8");
    await fs.promises.rename(tmp, target);
    onData(`已写入 ${target}\n`);
    const cache = path.join(path.dirname(target), "models_cache.json");
    await fs.promises.rm(cache, { force: true });
    onData(`已删除 ${cache}\n`);
    return;
  }
  const script = [
    "set -e",
    `t=${remotePathExpr(targetPath)}`,
    `mkdir -p "$(dirname "$t")"`,
    `tmp="$t.AgentCliHub-$$"`,
    `base64 -d > "$tmp"`,
    `mv -f "$tmp" "$t"`,
    `echo "已写入 $t"`,
    `command rm -f "$(dirname "$t")/models_cache.json"`,
    `echo "已删除 $(dirname "$t")/models_cache.json"`
  ].join("\n");
  const b64 = Buffer.from(rendered, "utf8").toString("base64");
  const result = await runRemoteCmd(host.id, script, { input: b64, onData, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error("远程写入 catalog 失败，详见日志");
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
export function parseRenamePaths(output) {
  if (!/rename/i.test(output)) return [];
  const paths = [];
  // 格式1：npm error path / dest 分行输出
  for (const re of [/npm (?:error|ERR!) path (.+)$/gim, /npm (?:error|ERR!) dest (.+)$/gim]) {
    for (const m of output.matchAll(re)) paths.push(m[1].trim());
  }
  // 格式2：单行带引号 "rename 'A' -> 'B'"（npm 11 ENOTEMPTY/EPERM 常见写法）
  for (const m of output.matchAll(/rename\s+'([^']+)'\s*->\s*'([^']+)'/gi)) {
    paths.push(m[1].trim(), m[2].trim());
  }
  // 格式3：单行无引号（仅绝对路径，避免误匹配散文文本）
  for (const m of output.matchAll(/rename\s+((?:[A-Za-z]:[\\/]|\/)[^\s'"]+)\s*->\s*((?:[A-Za-z]:[\\/]|\/)[^\s'"]+)/gi)) {
    paths.push(m[1].trim(), m[2].trim());
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
    const quoted = paths.map(sq).join(" ");
    // command rm：rm 处于参数位不被 alias 展开，同时绕过同名函数（比 \rm 更强），
    // 规避主机把 rm 包装成交互式确认脚本（需输入 YES）导致删除卡死
    await runRemoteBash(host.id, `command rm -rf -- ${quoted}`, {
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
