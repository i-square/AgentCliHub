// 传输层：只负责进程、SSH、标准流、超时和取消，不解释目标 shell 或业务脚本。
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{onData?: (chunk: string) => void, timeoutMs?: number, input?: string | Buffer | import('node:stream').Readable, signal?: AbortSignal}} opts
 *   input：流式传输时由 pipe 处理背压；未提供输入时也关闭 stdin，避免交互命令挂起。
 * @returns {Promise<{code: number, output: string, stdout: string, stderr: string}>}
 */
export function runProcess(cmd, args, { onData, timeoutMs = DEFAULT_TIMEOUT_MS, input, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      input?.destroy?.();
      resolve({ code: -1, output: "[cancelled]\n", stdout: "", stderr: "[cancelled]\n" });
      return;
    }
    const child = spawn(cmd, args, { windowsHide: true });
    let output = "";
    let stdout = "";
    let stderr = "";
    let failed = false;

    const handle = (chunk, stream) => {
      const text = chunk.toString();
      output += text;
      if (stream === "stdout") stdout += text;
      else stderr += text;
      onData?.(text);
    };
    const stop = (message) => {
      failed = true;
      handle(message, "stderr");
      input?.destroy?.();
      child.kill("SIGKILL");
    };
    const abort = () => stop("\n[cancelled] 命令已取消\n");
    const timer = setTimeout(() => stop(`\n[timeout] 命令超过 ${Math.round(timeoutMs / 1000)}s，已终止\n`), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    // setEncoding 保留跨 chunk 的 UTF-8 字符，配置和日志中的中文不会被截断。
    child.stdout.setEncoding("utf8").on("data", (chunk) => handle(chunk, "stdout"));
    child.stderr.setEncoding("utf8").on("data", (chunk) => handle(chunk, "stderr"));
    child.on("error", (err) => {
      failed = true;
      handle(`\n[spawn error] ${err.message}\n`, "stderr");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      input?.destroy?.();
      resolve({ code: failed ? -1 : code ?? -1, output, stdout, stderr });
    });
    child.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") stop(`\n[stdin error] ${err.message}\n`);
    });
    if (input?.pipe) {
      input.once("error", (err) => stop(`\n[input error] ${err.message}\n`));
      input.pipe(child.stdin);
    } else {
      child.stdin.end(input);
    }
  });
}

/** 远程执行原生命令（stdin 可携带 payload，如 base64 编码的文件内容） */
export function runSsh(alias, cmd, opts = {}) {
  return runProcess(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "--", alias, cmd],
    opts
  );
}
