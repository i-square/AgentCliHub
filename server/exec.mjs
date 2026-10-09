// 统一的命令执行层：本机走 pwsh，远程走 ssh + base64 传输脚本（规避多层引号转义问题）
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{onData?: (chunk: string) => void, timeoutMs?: number, input?: string | Buffer}} opts
 *   input：写入子进程 stdin 后关闭（用于经 ssh 向远程传输文件内容，避免命令行长度上限）
 * @returns {Promise<{code: number, output: string}>}
 */
function run(cmd, args, { onData, timeoutMs = DEFAULT_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      onData?.(`\n[timeout] 命令超过 ${Math.round(timeoutMs / 1000)}s，已终止\n`);
    }, timeoutMs);

    const handle = (chunk) => {
      const text = chunk.toString();
      output += text;
      onData?.(text);
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (err) => {
      clearTimeout(timer);
      onData?.(`\n[spawn error] ${err.message}\n`);
      resolve({ code: -1, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {}); // 远程提前退出时忽略 EPIPE
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** 本机 Windows：通过 pwsh -EncodedCommand 执行（UTF-16LE base64） */
export function runLocalPwsh(script, opts = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], opts);
}

/** 远程 Linux：脚本 base64 后经 ssh 传输，由 bash 执行 */
export function runRemoteBash(alias, script, opts = {}) {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const remoteCmd = `echo ${b64} | base64 -d | bash`;
  return run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, remoteCmd],
    opts
  );
}

/** 远程执行原生命令（stdin 可携带 payload，如 base64 编码的文件内容） */
export function runRemoteCmd(alias, cmd, opts = {}) {
  return run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, cmd],
    opts
  );
}
