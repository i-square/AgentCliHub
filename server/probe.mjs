// 深度探测：枚举目标主机上 codex/claude 的全部安装实例、PATH 视图、官方自动更新现状。
// 只读：不写远程文件、不访问外网。远程 bash / 本机 pwsh 双实现，输出 __P__ 标记行，由本文件解析。
import os from "node:os";
import { runLocalPwsh, runRemoteBash } from "./exec.mjs";

const PROBE_TIMEOUT_MS = 120_000;

// ---------- 远程 bash 探测脚本 ----------
// 逐行拼接，避免 JS 模板插值吞掉 $；标记前缀 __P__
const BASH_PROBE = [
  "set -u",
  'M="__P__"',
  'echo "${M}home=$HOME"',
  'echo "${M}shell=${SHELL:-}"',
  'echo "${M}uname=$(uname -srm 2>/dev/null)"',
  'echo "${M}nvmDir=${NVM_DIR:-}"',
  'echo "${M}codexHomeReal=$(readlink -f "$HOME/.codex" 2>/dev/null || true)"',
  'echo "${M}claudeHomeReal=$(readlink -f "$HOME/.claude" 2>/dev/null || true)"',
  'echo "${M}localBinReal=$(readlink -f "$HOME/.local/bin" 2>/dev/null || true)"',
  // ---- 当前 ssh（非登录）shell 的 PATH 逐项 ----
  "i=0; old_ifs=$IFS; IFS=: ",
  "for d in $PATH; do",
  '  i=$((i+1)); [ -n "$d" ] || d="(empty)"',
  '  c="-"; l="-"',
  '  [ -x "$d/codex" ] && [ ! -d "$d/codex" ] && c=Y',
  '  [ -x "$d/claude" ] && [ ! -d "$d/claude" ] && l=Y',
  '  echo "${M}pathEntry=${i}|${d}|${c}|${l}"',
  "done; IFS=$old_ifs",
  'echo "${M}cmdCodex=$(command -v codex 2>/dev/null || true)"',
  'echo "${M}cmdClaude=$(command -v claude 2>/dev/null || true)"',
  // ---- 登录 / 交互 shell 视图（zsh 登录不读 .zshrc，两者都要）----
  'lshell=${SHELL:-/bin/bash}; [ -x "$lshell" ] || lshell=/bin/bash',
  '"$lshell" -lc \'echo "__L__PATH=$PATH"; echo "__L__CODEX=$(command -v codex 2>/dev/null)"; echo "__L__CLAUDE=$(command -v claude 2>/dev/null)"\' </dev/null 2>/dev/null | grep "^__L__" | sed "s/^__L__/${M}login/" || true',
  '"$lshell" -ic \'echo "__I__PATH=$PATH"; echo "__I__CODEX=$(command -v codex 2>/dev/null)"; echo "__I__CLAUDE=$(command -v claude 2>/dev/null)"\' </dev/null 2>/dev/null | grep "^__I__" | sed "s/^__I__/${M}interactive/" || true',
  // ---- 候选探测：path|realPath|version（--version 无结果时向上找 package.json 兜底）----
  "probe_one() {",
  '  p="$1"',
  '  [ -n "$p" ] && [ -x "$p" ] && [ ! -d "$p" ] || return 0',
  '  rp=$(readlink -f "$p" 2>/dev/null || echo "$p")',
  '  if command -v timeout >/dev/null 2>&1; then v=$(timeout 15 "$p" --version </dev/null 2>&1 | head -n1); else v=$("$p" --version </dev/null 2>&1 | head -n1); fi',
  '  case "$v" in',
  "    *[0-9].[0-9]*) ;;",
  "    *)",
  '      d="$rp"; depth=0',
  '      while [ "$d" != "/" ] && [ $depth -lt 6 ]; do',
  '        d=${d%/*}; depth=$((depth+1))',
  '        pj="$d/package.json"',
  '        [ -f "$pj" ] || continue',
  '        pn=$(sed -n \'s/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$pj" | head -n1)',
  '        case "$pn" in',
  "          @openai/codex|@anthropic-ai/claude-code)",
  '            pv=$(sed -n \'s/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$pj" | head -n1)',
  '            [ -n "$pv" ] && { v="pkg:$pn@$pv"; break; } ;;',
  "        esac",
  "      done ;;",
  "  esac",
  '  echo "${M}cand=${p}|${rp}|$(printf \'%s\' "$v" | tr \'|\' \'/\' | tr "\n" " ")"',
  "}",
  // 已知路径候选
  'for c in "$HOME/.local/bin/codex" "$HOME/.local/bin/claude" /usr/local/bin/codex /usr/local/bin/claude /usr/bin/codex /usr/bin/claude /snap/bin/codex /snap/bin/claude \\',
  '  /opt/homebrew/bin/codex /opt/homebrew/bin/claude \\',
  '  "$HOME/.npm-global/bin/codex" "$HOME/.npm-global/bin/claude" "$HOME/.volta/bin/codex" "$HOME/.volta/bin/claude" \\',
  '  "$HOME/.bun/bin/codex" "$HOME/.bun/bin/claude" "$HOME/.cargo/bin/codex" \\',
  '  "$HOME/.asdf/shims/codex" "$HOME/.asdf/shims/claude" \\',
  '  "$HOME/.local/share/mise/shims/codex" "$HOME/.local/share/mise/shims/claude" \\',
  '  "$HOME/.local/share/pnpm/codex" "$HOME/.local/share/pnpm/claude"; do',
  '  probe_one "$c"',
  "done",
  // nvm / fnm / mise glob（含 NVM_DIR 自定义位置）
  'for nvmdir in "$HOME/.nvm" "${NVM_DIR:-/nonexistent}"; do',
  '  [ -d "$nvmdir/versions/node" ] || continue',
  '  for c in "$nvmdir/versions/node"/*/bin/codex "$nvmdir/versions/node"/*/bin/claude; do probe_one "$c"; done',
  "done",
  'for c in "$HOME/.fnm/node-versions"/*/installation/bin/codex "$HOME/.fnm/node-versions"/*/installation/bin/claude \\',
  '  "$HOME/.local/share/fnm/node-versions"/*/installation/bin/codex "$HOME/.local/share/fnm/node-versions"/*/installation/bin/claude \\',
  '  "$HOME/.local/share/mise/installs/node"/*/bin/codex "$HOME/.local/share/mise/installs/node"/*/bin/claude; do',
  '  probe_one "$c"',
  "done",
  // ---- 官方包根：默认 ~/.codex + 从运行中进程 cmdline 反推的自定义 CODEX_HOME ----
  'roots="$HOME/.codex"',
  'extra=$(ps -eo args 2>/dev/null | grep -oE "/[^ ]*/packages/(standalone|app-server-daemon)/releases/" | sed -E "s#/packages/(standalone|app-server-daemon)/releases/\\$##" | sort -u || true)',
  'for r in $extra; do case " $roots " in *" $r "*) ;; *) roots="$roots $r" ;; esac; done',
  'for base in $roots; do',
  '  for sub in standalone app-server-daemon; do',
  '    d="$base/packages/$sub"',
  '    [ -d "$d" ] || continue',
  '    echo "${M}pkgRoot=${base}|${sub}|$(readlink -f "$d/current" 2>/dev/null || echo none)|$(ls "$d/releases" 2>/dev/null | tr "\n" ",")"',
  '    for r in "$d/releases"/*/bin/codex "$d/releases"/*/codex; do probe_one "$r"; done',
  "  done",
  "done",
  // claude 官方 versions 目录
  'cv="$HOME/.local/share/claude/versions"',
  'if [ -d "$cv" ]; then for r in "$cv"/*; do [ -f "$r" ] && probe_one "$r"; done; else echo "${M}claudeVersionsDir=(absent)"; fi',
  // npm 概况
  'echo "${M}npmRoot=$(npm root -g 2>/dev/null || true)"',
  'echo "${M}node=$(node -v 2>/dev/null || true)"',
  // ---- 官方自动更新现状（只读采集）----
  'cfg="$HOME/.codex/config.toml"',
  'echo "${M}codexCfgStartupCheck=$(grep -E "^[[:space:]]*check_for_update_on_startup" "$cfg" 2>/dev/null | head -n1 | tr -d " " || true)"',
  'echo "${M}codexCfgDaemonAutoStart=$(sed -n "/\\[features\\]/,/^\\[/p" "$cfg" 2>/dev/null | grep -E "daemon_auto_start" | head -n1 | tr -d " " || true)"',
  'ds="$HOME/.codex/app-server-daemon/settings.json"',
  'if [ -f "$ds" ]; then echo "${M}codexDaemonSettings=$(tr -d "\\n " < "$ds" | head -c 300)"; else echo "${M}codexDaemonSettings=(absent)"; fi',
  'cs="$HOME/.claude/settings.json"',
  'if [ -f "$cs" ]; then echo "${M}claudeSettings=$(grep -E "autoUpdatesChannel|DISABLE_AUTOUPDATER|DISABLE_UPDATES|minimumVersion" "$cs" 2>/dev/null | tr -d "\\n " | head -c 300 || true)"; else echo "${M}claudeSettings=(absent)"; fi',
  // 运行中的相关进程（截断防爆量）
  'echo "${M}procs=$(pgrep -af "codex|claude" 2>/dev/null | grep -v pgrep | head -n 8 | cut -c1-160 | tr "\\n" ";" || true)"',
  // rc 文件 PATH / nvm 命中统计
  'for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc" "$HOME/.zprofile"; do',
  '  [ -f "$rc" ] || continue',
  '  hits=$(grep -cE "\.local/bin|managed PATH" "$rc" 2>/dev/null | head -n1)',
  '  nvm=$(grep -cE "nvm\.sh|NVM_DIR" "$rc" 2>/dev/null | head -n1)',
  '  echo "${M}rcFile=${rc}|${hits}|${nvm}"',
  "done",
  'echo "${M}done=1"'
].join("\n");

// ---------- 本机 Windows pwsh 探测 ----------
const PS_PROBE = String.raw`
$M='__P__'
Write-Output ($M+'home='+$HOME)
Write-Output ($M+'shell=pwsh')
Write-Output ($M+'uname=Windows ' + [System.Environment]::OSVersion.Version.ToString())
Write-Output ($M+'codexHomeReal=' + $(if(Test-Path "$HOME\.codex"){ (Resolve-Path "$HOME\.codex").Path } else { '' }))
$i=0
foreach($d in ($env:Path -split ';')){
  $i++; if(-not $d){continue}
  $c = (Test-Path (Join-Path $d 'codex.exe')) -or (Test-Path (Join-Path $d 'codex.cmd')) -or (Test-Path (Join-Path $d 'codex'))
  $l = (Test-Path (Join-Path $d 'claude.exe')) -or (Test-Path (Join-Path $d 'claude.cmd')) -or (Test-Path (Join-Path $d 'claude'))
  Write-Output ($M+'pathEntry='+$i+'|'+$d+'|'+($(if($c){'Y'}else{'-'}))+'|'+($(if($l){'Y'}else{'-'})))
}
foreach($n in 'codex','claude'){
  $hit = Get-Command $n -ErrorAction SilentlyContinue
  Write-Output ($M+'cmd'+$(if($n -eq 'codex'){'Codex'}else{'Claude'})+'='+$(if($hit){$hit.Source}else{''}))
}
$j=0; foreach($d in ([Environment]::GetEnvironmentVariable('Path','User') -split ';')){ $j++; if($d){ $c=(Test-Path (Join-Path $d 'codex.exe')) -or (Test-Path (Join-Path $d 'codex.cmd')); $l=(Test-Path (Join-Path $d 'claude.exe')) -or (Test-Path (Join-Path $d 'claude.cmd')); Write-Output ($M+'regUserPath='+$j+'|'+$d+'|'+($(if($c){'Y'}else{'-'}))+'|'+($(if($l){'Y'}else{'-'}))) } }
$j=0; foreach($d in ([Environment]::GetEnvironmentVariable('Path','Machine') -split ';')){ $j++; if($d){ $c=(Test-Path (Join-Path $d 'codex.exe')) -or (Test-Path (Join-Path $d 'codex.cmd')); $l=(Test-Path (Join-Path $d 'claude.exe')) -or (Test-Path (Join-Path $d 'claude.cmd')); Write-Output ($M+'regMachPath='+$j+'|'+$d+'|'+($(if($c){'Y'}else{'-'}))+'|'+($(if($l){'Y'}else{'-'}))) } }
function Probe($p){
  if(-not $p -or -not (Test-Path $p)){ return }
  $it = Get-Item $p -ErrorAction SilentlyContinue
  if(-not $it -or $it.PSIsContainer){ return }
  $rp = $p
  if($it.LinkTarget){ $rp = $it.LinkTarget }
  $v=''
  try{ $v = (& $p --version 2>$null | Select-Object -First 1) }catch{}
  if(-not ($v -match '\d+\.\d+')){
    $dir = Split-Path $rp -Parent
    for($k=0; $k -lt 6 -and $dir; $k++){
      $pj = Join-Path $dir 'package.json'
      if(Test-Path $pj){
        try{ $j = Get-Content $pj -Raw | ConvertFrom-Json
          if($j.name -eq '@openai/codex' -or $j.name -eq '@anthropic-ai/claude-code'){ $v = 'pkg:' + $j.name + '@' + $j.version; break }
        }catch{}
      }
      $dir = Split-Path $dir -Parent
    }
  }
  Write-Output ($M+'cand='+$p+'|'+$rp+'|'+($v -replace '\|','/' -replace [char]10,' '))
}
$sr = Join-Path $HOME '.codex\packages'
foreach($sub in 'standalone','app-server-daemon'){
  $d = Join-Path $sr $sub
  if(Test-Path $d){
    $cur = Join-Path $d 'current'; $tgt=''
    if(Test-Path $cur){ try{ $tgt = (Get-Item $cur).LinkTarget }catch{} }
    $rels = ((Get-ChildItem (Join-Path $d 'releases') -Directory -ErrorAction SilentlyContinue | ForEach-Object {$_.Name}) -join ',')
    Write-Output ($M+'pkgRoot='+$HOME+'\.codex|'+$sub+'|'+$tgt+'|'+$rels)
    foreach($r in (Get-ChildItem (Join-Path $d 'releases') -Directory -ErrorAction SilentlyContinue)){
      Probe (Join-Path $r.FullName 'bin\codex.exe'); Probe (Join-Path $r.FullName 'codex.exe')
    }
  }
}
Probe "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe"
Probe "$HOME\.local\bin\codex.exe"; Probe "$HOME\.local\bin\claude.exe"; Probe "$HOME\.local\bin\codex"; Probe "$HOME\.local\bin\claude"
$desk = "$env:LOCALAPPDATA\OpenAI\Codex\bin"
if(Test-Path $desk){ foreach($dd in (Get-ChildItem $desk -Directory -ErrorAction SilentlyContinue)){ Probe (Join-Path $dd.FullName 'codex.exe') } }
$cvd = "$HOME\.local\share\claude\versions"
if(Test-Path $cvd){ foreach($f in (Get-ChildItem $cvd -File -ErrorAction SilentlyContinue)){ Probe $f.FullName } } else { Write-Output ($M+'claudeVersionsDir=(absent)') }
$npmg = (npm root -g 2>$null | Select-Object -Last 1)
Write-Output ($M+'npmRoot='+$npmg)
Write-Output ($M+'node='+((node -v 2>$null)))
if($npmg){ Probe (Join-Path $npmg '@openai\codex\bin\codex.js'); Probe (Join-Path $npmg '@anthropic-ai\claude-code\bin\claude.exe') }
$cfg = Join-Path $HOME '.codex\config.toml'
if(Test-Path $cfg){
  $sc = Select-String -Path $cfg -Pattern 'check_for_update_on_startup' | Select-Object -First 1
  Write-Output ($M+'codexCfgStartupCheck='+$(if($sc){$sc.Line.Trim()}else{''}))
  $ds2 = Select-String -Path $cfg -Pattern 'daemon_auto_start' | Select-Object -First 1
  Write-Output ($M+'codexCfgDaemonAutoStart='+$(if($ds2){$ds2.Line.Trim()}else{''}))
}
$ds = Join-Path $HOME '.codex\app-server-daemon\settings.json'
if(Test-Path $ds){ Write-Output ($M+'codexDaemonSettings='+((Get-Content $ds -Raw) -replace '\s','').Substring(0, [Math]::Min(300, ((Get-Content $ds -Raw) -replace '\s','').Length))) } else { Write-Output ($M+'codexDaemonSettings=(absent)') }
$cs = Join-Path $HOME '.claude\settings.json'
if(Test-Path $cs){ $hits = (Get-Content $cs -Raw) | Select-String -Pattern '"autoUpdatesChannel"\s*:\s*"[^"]*"|"DISABLE_AUTOUPDATER"\s*:\s*"[^"]*"|"DISABLE_UPDATES"\s*:\s*"[^"]*"|"minimumVersion"\s*:\s*"[^"]*"' -AllMatches; Write-Output ($M+'claudeSettings='+($hits.Matches.Value -join ';')) } else { Write-Output ($M+'claudeSettings=(absent)') }
Write-Output ($M+'done=1')
`;

// ---------- 结果解析 ----------

/** 从版本串中提取 semver（支持 codex-cli 0.160.1 / pkg:@openai/codex@0.162.1 / 2.1.299 (Claude Code)） */
function extractVersion(raw) {
  const m = /(\d+\.\d+\.\d+(?:-(?:alpha|beta)[\d.]*)?)/.exec(raw ?? "");
  return m ? m[1] : "";
}

/** 按 realPath 归类安装方式；Windows 桌面版私带 CLI 单独标记（永不管理） */
function classify(tool, realPath) {
  const p = (realPath ?? "").replace(/\\/g, "/").toLowerCase();
  if (tool === "codex") {
    if (p.includes("/packages/standalone/releases/")) return "standalone-official";
    if (p.includes("/packages/app-server-daemon/releases/")) return "standalone-daemon";
    if (p.includes("node_modules/@openai/codex")) return "npm-global";
    if (/appdata\/local\/openai\/codex\/bin\/[0-9a-f]+\/codex\.exe$/.test(p)) return "desktop-bundled";
    if (p.includes("/.codex/")) return "standalone-official";
  } else {
    if (p.includes("/.local/share/claude/versions/")) return "standalone-official";
    if (p.includes("node_modules/@anthropic-ai/claude-code")) return "npm-global";
    if (p.includes("/.claude/local/")) return "npm-local";
  }
  return "unknown";
}

/** realPath 落在共享挂载的启发式判定（/mnt、/media、/net、/nfs 开头） */
function onSharedMount(realPath) {
  return /^\/(mnt|media|net|nfs)\//.test((realPath ?? "").replace(/\\/g, "/"));
}

function parseProbeOutput(host, output) {
  const r = {
    probedAt: new Date().toISOString(),
    meta: {},
    pathEntries: [],
    regUserPath: [],
    regMachPath: [],
    contexts: {},
    candidates: [],
    pkgRoots: [],
    autoUpdate: {},
    rcFiles: [],
    procs: "",
    done: false
  };
  const seenCand = new Set();
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("__P__")) continue;
    const body = t.slice(5);
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const k = body.slice(0, eq);
    const v = body.slice(eq + 1);

    const arrKey = { pathEntry: "pathEntries", regUserPath: "regUserPath", regMachPath: "regMachPath" }[k];
    if (arrKey) {
      const [index, dir, c, l] = v.split("|");
      r[arrKey].push({ index: Number(index), dir, codex: c === "Y", claude: l === "Y" });
    } else if (k === "cand") {
      const [p, rp, ver] = v.split("|");
      if (!p || seenCand.has(p)) continue;
      seenCand.add(p);
      const tool = /codex/i.test(p) ? "codex" : "claude";
      r.candidates.push({
        path: p,
        realPath: rp,
        versionRaw: ver ?? "",
        version: extractVersion(ver),
        tool,
        method: classify(tool, rp),
        shared: onSharedMount(rp)
      });
    } else if (k === "pkgRoot") {
      const [base, sub, current, releases] = v.split("|");
      r.pkgRoots.push({ base, sub, current, releases: (releases ?? "").split(",").filter(Boolean) });
    } else if (k === "rcFile") {
      const [file, localBinHits, nvmHits] = v.split("|");
      r.rcFiles.push({ file, localBinHits: Number(localBinHits), nvmHits: Number(nvmHits) });
    } else if (k === "cmdCodex" || k === "cmdClaude") {
      (r.contexts.shell ??= {})[k === "cmdCodex" ? "codex" : "claude"] = v;
    } else if (k.startsWith("login")) {
      const sub = k.replace(/^login/, "").toLowerCase(); // path/codex/claude
      (r.contexts.login ??= {})[sub] = v;
    } else if (k.startsWith("interactive")) {
      const sub = k.replace(/^interactive/, "").toLowerCase();
      (r.contexts.interactive ??= {})[sub] = v;
    } else if (k === "procs") {
      r.procs = v;
    } else if (k === "done") {
      r.done = true;
    } else if (["codexCfgStartupCheck", "codexCfgDaemonAutoStart", "codexDaemonSettings", "claudeSettings"].includes(k)) {
      r.autoUpdate[k] = v;
    } else {
      r.meta[k] = v;
    }
  }
  // 入口副本归类：installDir 下的复制件 realPath 即自身，无法靠链接识别；
  // 若与同机 standalone 本体同版本，则归为 standalone-entry（入口副本）
  for (const c of r.candidates) {
    if (c.method !== "unknown" || !c.version) continue;
    const twin = r.candidates.find((o) => o.tool === c.tool && o.method === "standalone-official" && o.version === c.version);
    if (twin) c.method = "standalone-entry";
  }
  // 标记当前 shell 生效实例：精确路径 → 去扩展名 → npm shim 归属 npm-global 候选
  const norm = (x) => (x ?? "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  for (const tool of ["codex", "claude"]) {
    const resolved = r.contexts.shell?.[tool] ?? "";
    if (!resolved) continue;
    const nr = norm(resolved);
    const nrNoExt = nr.replace(/\.(ps1|cmd|exe|js)$/, "");
    let hit = r.candidates.find(
      (c) => c.tool === tool && (norm(c.path) === nr || norm(c.path).replace(/\.(ps1|cmd|exe|js)$/, "") === nrNoExt || norm(c.realPath) === nr)
    );
    if (!hit && /\/npm(\/|$)/.test(nr)) hit = r.candidates.find((c) => c.tool === tool && c.method === "npm-global");
    if (hit) hit.activeInShell = true;
  }
  return r;
}

/**
 * 深度探测一台主机。
 * @param {object} host 主机对象（kind: local | ssh）
 * @param {(chunk: string) => void} onData 日志回调
 * @returns {Promise<object>} 结构化探测结果
 */
export async function probeHost(host, onData = () => {}) {
  onData(host.kind === "local" ? "[probe] 本机 Windows 探测…\n" : `[probe] SSH 远程探测 ${host.id}…\n`);
  const result =
    host.kind === "local"
      ? await runLocalPwsh(PS_PROBE, { onData: () => {}, timeoutMs: PROBE_TIMEOUT_MS })
      : await runRemoteBash(host.id, BASH_PROBE, { onData: () => {}, timeoutMs: PROBE_TIMEOUT_MS });
  const parsed = parseProbeOutput(host, result.output);
  if (!parsed.done) {
    onData(`[probe] 警告：探测未完整结束（exit=${result.code}），结果可能不全\n`);
  }
  onData(`[probe] 发现 ${parsed.candidates.length} 个安装候选，PATH 条目 ${parsed.pathEntries.length} 个\n`);
  return parsed;
}
