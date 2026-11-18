// 目标文件操作：业务层传原始路径，路径展开、标准流协议和原子替换集中在这里。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { resolveRuntime, runHostBash, runHostPwsh } from "./hostShell.mjs";

export const bashQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const pwshQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function bashPathExpr(value) {
  const p = String(value ?? "").trim();
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${bashQuote(p.slice(2))}`;
  return bashQuote(p);
}

export function windowsPathExpr(value) {
  const p = String(value ?? "").trim();
  if (p === "~") return "$HOME";
  if (p.startsWith("~/") || p.startsWith("~\\")) return `(Join-Path $HOME ${pwshQuote(p.slice(2))})`;
  return pwshQuote(p);
}

export function expandHomeLocal(value) {
  const p = String(value ?? "").trim();
  return p === "~" ? os.homedir()
    : p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** 文件内容使用 base64，完整保留换行和 Unicode，且不会与协议标记碰撞。 */
export function parseReadResult(result, nonce) {
  const fail = (reason) => ({ state: "error", reason });
  if (result.code !== 0) return fail(`读取失败（exit=${result.code}）：${result.stderr?.trim().slice(-160) ?? ""}`);
  const output = result.stdout;
  const marker = `__ACH_FILE_${nonce}__`;
  if (output?.split(/\r?\n/).includes(`${marker}MISSING`)) return { state: "missing" };
  const match = new RegExp(`^${marker}BEGIN\\r?\\n([A-Za-z0-9+/=\\r\\n]*)^${marker}END\\r?$`, "m").exec(output ?? "");
  if (!match) return fail("读取输出不完整，未取得文件内容");
  const encoded = match[1].replace(/[\r\n]/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return fail("文件内容编码不完整");
  return { state: "ok", content: bytes.toString("utf8") };
}

/** 参数替换只用于契约测试；无需在业务模块传递执行器。 */
export function createHostFiles({ resolveRuntime: runtime = resolveRuntime, runHostBash: bash = runHostBash, runHostPwsh: pwsh = runHostPwsh } = {}) {
  async function readText(host, targetPath) {
    if (host.kind === "local") {
      try {
        return { state: "ok", content: await fs.promises.readFile(expandHomeLocal(targetPath), "utf8") };
      } catch (error) {
        return error.code === "ENOENT" ? { state: "missing" } : { state: "error", reason: error.message };
      }
    }
    const { family } = await runtime(host);
    const nonce = crypto.randomBytes(8).toString("hex");
    const marker = `__ACH_FILE_${nonce}__`;
    const script = family === "windows" ? `
$ErrorActionPreference = 'Stop'
$p = ${windowsPathExpr(targetPath)}
try { $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { Write-Output '${marker}MISSING'; exit 0 }
if ($item.PSIsContainer) { throw '目标是目录，无法读取文本' }
$content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($item.FullName))
Write-Output '${marker}BEGIN'
Write-Output $content
Write-Output '${marker}END'` : `set -e
p=${bashPathExpr(targetPath)}
if [ ! -e "$p" ] && [ ! -L "$p" ]; then
  parent=$(dirname "$p")
  while [ ! -e "$parent" ] && [ ! -L "$parent" ]; do
    next=$(dirname "$parent")
    [ "$next" != "$parent" ] || exit 3
    parent=$next
  done
  [ -d "$parent" ] && [ -x "$parent" ] || exit 3
  printf '%s\\n' '${marker}MISSING'
  exit 0
fi
[ -f "$p" ] || exit 3
printf '%s\\n' '${marker}BEGIN'
base64 < "$p"
printf '\\n%s\\n' '${marker}END'`;
    const result = await (family === "windows" ? pwsh : bash)(host, script, { timeoutMs: 30_000 });
    return parseReadResult(result, nonce);
  }

  async function writePayload(host, targetPath, input, size, { backupSuffix = "", onData = () => {}, timeoutMs = 15 * 60_000 } = {}) {
    if (host.kind === "local") {
      const target = expandHomeLocal(targetPath);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.agentclihub-${crypto.randomUUID()}`;
      const backupTmp = `${tmp}.bak`;
      try {
        let mode = 0o600;
        let present = false;
        try {
          const st = await fs.promises.stat(target);
          if (!st.isFile()) throw new Error(`目标不是普通文件: ${target}`);
          mode = st.mode & 0o777;
          present = true;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (typeof input === "function") input = input();
        if (input?.pipe) await pipeline(input, fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
        else await fs.promises.writeFile(tmp, input, { flag: "wx", mode: 0o600 });
        if ((await fs.promises.stat(tmp)).size !== size) throw new Error("文件传输不完整，未替换目标文件");
        await fs.promises.chmod(tmp, mode);
        if (present && backupSuffix) {
          // 先创建私有临时备份，再替换旧备份，避免沿用旧备份的宽权限或符号链接。
          await fs.promises.writeFile(backupTmp, "", { flag: "wx", mode: 0o600 });
          await fs.promises.copyFile(target, backupTmp);
          await fs.promises.chmod(backupTmp, 0o600);
          await fs.promises.rename(backupTmp, `${target}${backupSuffix}`);
        }
        await fs.promises.rename(tmp, target);
      } finally {
        input?.destroy?.();
        await fs.promises.rm(tmp, { force: true });
        await fs.promises.rm(backupTmp, { force: true });
      }
    } else {
      const { family } = await runtime(host);
      const script = family === "windows" ? `
$ErrorActionPreference = 'Stop'
$t = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(${windowsPathExpr(targetPath)})
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($t)) | Out-Null
$tmp = $t + '.agentclihub-' + [Guid]::NewGuid().ToString('N')
try {
  $stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { [Console]::OpenStandardInput().CopyTo($stream) } finally { $stream.Dispose() }
  if ((Get-Item -LiteralPath $tmp).Length -ne ${size}) { throw '文件传输不完整，未替换目标文件' }
  if ([IO.File]::Exists($t)) {
    # PowerShell 会把 $null 转为空字符串；无备份替换必须传真正的 null。
    $backup = ${backupSuffix ? `$t + ${pwshQuote(backupSuffix)}` : "[NullString]::Value"}
    [IO.File]::Replace($tmp, $t, $backup)
  } else { [IO.File]::Move($tmp, $t) }
} finally {
  if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
}` : `set -e
umask 077
t=${bashPathExpr(targetPath)}
mkdir -p "$(dirname "$t")"
tmp=$(mktemp "$t.agentclihub-XXXXXX")
backup_tmp=''
trap 'command rm -f -- "$tmp"; [ -z "$backup_tmp" ] || command rm -f -- "$backup_tmp"' EXIT
cat > "$tmp"
[ "$(wc -c < "$tmp")" -eq ${size} ] || { echo '文件传输不完整' >&2; exit 3; }
if [ -e "$t" ] || [ -L "$t" ]; then
  [ -f "$t" ] || { echo '目标不是普通文件' >&2; exit 3; }
  chmod --reference="$t" "$tmp" 2>/dev/null || chmod "$(stat -c %a "$t" 2>/dev/null || stat -f %Lp "$t")" "$tmp"
  ${backupSuffix ? `[ ! -d "$t"${bashQuote(backupSuffix)} ] || { echo '备份路径是目录' >&2; exit 3; }
  backup_tmp=$(mktemp "$t.agentclihub-backup-XXXXXX")
  command cp "$t" "$backup_tmp"
  chmod 600 "$backup_tmp"
  mv -f "$backup_tmp" "$t"${bashQuote(backupSuffix)}` : ""}
fi
mv -f "$tmp" "$t"`;
      let result;
      if (typeof input === "function") input = input();
      try { result = await (family === "windows" ? pwsh : bash)(host, script, { input, timeoutMs }); }
      finally { input?.destroy?.(); }
      if (result.code !== 0) throw new Error(`写入 ${targetPath} 失败（exit=${result.code}）：${result.stderr.trim().slice(-200)}`);
    }
    onData(`已写入 ${targetPath}${backupSuffix ? `（已有文件备份为 ${backupSuffix}）` : ""}\n`);
  }

  async function writeTextAtomic(host, targetPath, content, opts = {}) {
    const bytes = Buffer.from(content, "utf8");
    await writePayload(host, targetPath, bytes, bytes.length, { backupSuffix: ".agentclihub.bak", timeoutMs: 60_000, ...opts });
  }

  async function putFile(host, localFile, targetPath, opts = {}) {
    const { size } = await fs.promises.stat(localFile);
    // 不整包 readFile：本机与 SSH 都以流传输，内存不随安装包大小增长。
    const openInput = () => {
      const stream = fs.createReadStream(localFile, { highWaterMark: 1024 * 1024 });
      let sent = 0;
      let lastEmit = 0;
      stream.on("data", (chunk) => {
        sent += chunk.length;
        const now = Date.now();
        if (opts.onData && now - lastEmit >= 3000) {
          lastEmit = now;
          opts.onData(`文件传输中… ${Math.round(sent / size * 100)}%\n`);
        }
      });
      return stream;
    };
    await writePayload(host, targetPath, openInput, size, opts);
  }

  async function exists(host, targetPath, { directory = false } = {}) {
    if (host.kind === "local") {
      try {
        const st = await fs.promises.stat(expandHomeLocal(targetPath));
        return directory ? st.isDirectory() : true;
      } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    const { family } = await runtime(host);
    const script = family === "windows"
      ? `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${windowsPathExpr(targetPath)}${directory ? " -PathType Container" : ""}) { Write-Output '__ACH_EXISTS__yes' } else { Write-Output '__ACH_EXISTS__no' }`
      : `if [ ${directory ? "-d" : "-e"} ${bashPathExpr(targetPath)} ]; then echo __ACH_EXISTS__yes; else echo __ACH_EXISTS__no; fi`;
    const result = await (family === "windows" ? pwsh : bash)(host, script, { timeoutMs: 30_000 });
    const match = /^__ACH_EXISTS__(yes|no)\r?$/m.exec(result.stdout);
    if (result.code !== 0 || !match) throw new Error(`无法检查目标路径: ${targetPath}`);
    return match[1] === "yes";
  }

  async function removeFile(host, targetPath) {
    if (host.kind === "local") return fs.promises.rm(expandHomeLocal(targetPath), { force: true });
    const { family } = await runtime(host);
    const script = family === "windows"
      ? `$ErrorActionPreference = 'Stop'; [IO.File]::Delete($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(${windowsPathExpr(targetPath)}))`
      : `command rm -f -- ${bashPathExpr(targetPath)}`;
    const result = await (family === "windows" ? pwsh : bash)(host, script, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`删除文件 ${targetPath} 失败（exit=${result.code}）`);
  }

  return { readText, writeTextAtomic, putFile, exists, removeFile };
}

export const { readText, writeTextAtomic, putFile, exists, removeFile } = createHostFiles();
