import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./exec.mjs";
import { createHostShell } from "./hostShell.mjs";
import { createHostFiles, parseReadResult, windowsPathExpr } from "./hostFiles.mjs";

const shell = createHostShell({ ssh: (_id, command, opts) => runProcess("sh", ["-c", command], opts) });
const files = createHostFiles(shell);
const noWindows = { skip: process.platform === "win32" };

test("读取协议只接受 stdout；保持 CRLF/Unicode/空文件，拒绝截断与伪标记", () => {
  const nonce = "ab12";
  const marker = `__ACH_FILE_${nonce}__`;
  for (const content of ["", "中文\r\n尾行", "__ACH_NOFILE_7f3d__\n__CCS_MISSING__\n"]) {
    const stdout = `${marker}BEGIN\r\n${Buffer.from(content).toString("base64")}\r\n${marker}END\r\n`;
    assert.deepEqual(parseReadResult({ code: 0, stdout, stderr: "污染", output: "污染" }, nonce), { state: "ok", content });
  }
  assert.equal(parseReadResult({ code: 1, stdout: `${marker}MISSING` }, nonce).state, "error");
  assert.equal(parseReadResult({ code: 0, stdout: `${marker}BEGIN\nYW\n${marker}END` }, nonce).state, "error");
  assert.equal(parseReadResult({ code: 0, stdout: "banner" }, nonce).state, "error");
  assert.equal(parseReadResult({ code: 0, stdout: "__ACH_FILE_other__MISSING" }, nonce).state, "error");
});

for (const kind of ["local", "ssh"]) {
  test(`${kind}/Linux：真实读写、备份、权限与二进制流传输`, noWindows, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-files-"));
    const host = { id: "loopback", kind, shell: "bash" };
    const target = path.join(dir, "目录 ' $() `literal`", "settings.json");
    try {
      assert.deepEqual(await files.readText(host, target), { state: "missing" });
      assert.equal((await files.readText(host, dir)).state, "error", "目录不能误判为缺失");
      const original = '{"secret":"保留","lines":"__ACH_NOFILE_7f3d__"}\r\n';
      await files.writeTextAtomic(host, target, original);
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
      await fs.chmod(target, 0o640);
      await fs.writeFile(`${target}.agentclihub.bak`, "old", { mode: 0o644 });
      await files.writeTextAtomic(host, target, "下一版\r\n");
      assert.deepEqual(await files.readText(host, target), { state: "ok", content: "下一版\r\n" });
      assert.equal(await fs.readFile(`${target}.agentclihub.bak`, "utf8"), original);
      assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
      assert.equal((await fs.stat(`${target}.agentclihub.bak`)).mode & 0o777, 0o600);
      assert.equal(await files.exists(host, path.dirname(target), { directory: true }), true);
      assert.equal(await files.exists(host, target, { directory: true }), false);

      const bytes = Buffer.from(Array.from({ length: 1024 * 1024 + 17 }, (_, i) => i % 256));
      const source = path.join(dir, "package.bin");
      const dest = path.join(dir, "nested", "package.bin");
      await fs.writeFile(source, bytes);
      await files.putFile(host, source, dest);
      assert.deepEqual(await fs.readFile(dest), bytes);
      await files.removeFile(host, dest);
      assert.equal(await files.exists(host, dest), false);
      assert.deepEqual((await fs.readdir(path.dirname(target))).filter((name) => name.includes("agentclihub-") && !name.endsWith(".bak")), []);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test("SSH 传输截断保留原文件，备份失败不替换目标", noWindows, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-failure-"));
  const host = { id: "loopback", kind: "ssh", shell: "bash" };
  const target = path.join(dir, "settings.json");
  try {
    await fs.writeFile(target, "original");
    const truncated = createHostFiles({ ...shell, runHostBash: (h, script, opts) => shell.runHostBash(h, script, { ...opts, input: opts.input ? Buffer.from("x") : undefined }) });
    await assert.rejects(() => truncated.writeTextAtomic(host, target, "complete-content"), /写入.*失败/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
    await fs.mkdir(`${target}.agentclihub.bak`);
    // mv 到目录可能被当成移动文件到目录，写入必须在此场景拒绝备份。
    await assert.rejects(() => files.writeTextAtomic(host, target, "new"), /写入.*失败/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("SSH Bash 无权访问父目录时返回读取错误，不当作缺失文件", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-permissions-"));
  const target = path.join(dir, "settings.json");
  try {
    await fs.writeFile(target, '{"keep":true}');
    await fs.chmod(dir, 0o000);
    assert.equal((await files.readText({ id: "loopback", kind: "ssh", shell: "bash" }, target)).state, "error");
  } finally {
    await fs.chmod(dir, 0o700);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Windows SSH 文件契约：目标机 HOME、二进制 stdin、原子替换和大小校验", async () => {
  const calls = [];
  const api = createHostFiles({
    resolveRuntime: async () => ({ family: "windows" }),
    runHostBash: async () => { throw new Error("不应执行 Bash"); },
    runHostPwsh: async (_host, script, opts) => {
      let payload = opts.input;
      if (payload?.pipe) {
        const chunks = [];
        for await (const chunk of payload) chunks.push(chunk);
        payload = Buffer.concat(chunks);
      }
      calls.push({ script, payload });
      const marker = /__ACH_FILE_[0-9a-f]+__/.exec(script)?.[0];
      const stdout = marker ? `${marker}BEGIN\r\n${Buffer.from("中文\r\n").toString("base64")}\r\n${marker}END\r\n` : "";
      return { code: 0, stdout, stderr: "", output: stdout };
    }
  });
  const host = { id: "windows", kind: "ssh" };
  const target = "~/.claude/引号 ' [x].json";
  assert.deepEqual(await api.readText(host, target), { state: "ok", content: "中文\r\n" });
  await api.writeTextAtomic(host, target, "文本\r\n");
  const { script, payload } = calls.at(-1);
  assert.ok(script.includes(windowsPathExpr(target)));
  assert.match(script, /OpenStandardInput\(\)\.CopyTo/);
  assert.match(script, /\[IO.File\]::Replace/);
  assert.match(script, /\.Length -ne 8/);
  assert.equal(payload.toString("utf8"), "文本\r\n");
  assert.doesNotMatch(script, /base64 -d|\$HOME\//);
  assert.equal(windowsPathExpr("~\\dir ' x"), "(Join-Path $HOME 'dir '' x')");

  await api.writeTextAtomic(host, target, "无备份\r\n", { backupSuffix: "" });
  const noBackupScript = calls.at(-1).script;
  assert.match(noBackupScript, /\$backup = \[NullString\]::Value/);
  assert.doesNotMatch(noBackupScript, /\$backup = \$null/);
});
