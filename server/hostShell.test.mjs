import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShellOverride, parseWindowsShellProbe, runHostBash, createHostShell } from "./hostShell.mjs";
import { runProcess } from "./exec.mjs";
import { capabilitiesFor } from "./capabilities.mjs";
import { RELATED_PROCESS_PATTERN } from "./probe.mjs";

test("shell 手动覆盖只接受明确支持的值", () => {
  assert.deepEqual(normalizeShellOverride("pwsh"), { family: "windows", executable: "pwsh", source: "override" });
  assert.deepEqual(normalizeShellOverride("PowerShell"), { family: "windows", executable: "powershell", source: "override" });
  assert.deepEqual(normalizeShellOverride("bash"), { family: "bash", executable: "bash", source: "override" });
  assert.strictEqual(normalizeShellOverride(""), null);
  assert.throws(() => normalizeShellOverride("zsh"), /仅支持 pwsh、powershell、bash/);
});

test("PowerShell 探测只从完整标记识别，并区分 Core/Desktop", () => {
  assert.deepEqual(parseWindowsShellProbe("banner\r\n__ACH_WINDOWS_POWERSHELL__\r\nCore\r\n"), {
    family: "windows", executable: "pwsh", source: "detected"
  });
  assert.deepEqual(parseWindowsShellProbe("__ACH_WINDOWS_POWERSHELL__\nDesktop\n"), {
    family: "windows", executable: "powershell", source: "detected"
  });
  assert.strictEqual(parseWindowsShellProbe("Write-Output: command not found"), null);
  assert.strictEqual(parseWindowsShellProbe("__ACH_WINDOWS_POWERSHELL__"), null, "缺少版本标记时不猜测默认解释器");
});

test("本机 Bash 执行并保留独立 stdin/stdout/stderr", { skip: process.platform === "win32" }, async () => {
  const result = await runHostBash(
    { id: "local", kind: "local" },
    'IFS= read -r value; printf "stdout=%s\\n" "$value"; printf "stderr=ok\\n" >&2',
    { input: "payload\n" }
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout, "stdout=payload\n");
  assert.strictEqual(result.stderr, "stderr=ok\n");
});

test("相关进程匹配排除名称相似的网关进程", () => {
  const pattern = new RegExp(RELATED_PROCESS_PATTERN);
  assert.ok(pattern.test("codex app-server proxy"));
  assert.ok(pattern.test("/home/yfu/.local/bin/claude --version"));
  assert.ok(pattern.test("/home/yfu/.codex/packages/standalone/current/bin/codex"));
  assert.ok(pattern.test("/home/yfu/.vscode-server/extensions/openai.chatgpt/bin/codex app-server"));
  assert.strictEqual(pattern.test("postgres: postgres claude_code_hub 172.24.0.2(45092) idle"), false);
  assert.strictEqual(pattern.test("node /opt/claude_code_hub/server.js"), false);
});

const result = (stdout, code = 0) => ({ code, stdout, stderr: "diagnostic", output: stdout + "diagnostic" });

for (const transport of ["local", "ssh"]) {
  for (const family of ["windows", "bash"]) {
    test(`${transport}/${family}：运行时、执行器、输入及能力契约`, async () => {
      const calls = [];
      const platform = family === "windows"
        ? { sysname: "windows", machine: "arm64", libc: "" }
        : { sysname: "linux", machine: "x64", libc: "musl" };
      const invoke = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return Promise.resolve(result(family === "windows" ? "__ACH_PLATFORM__=windows|ARM64|\r\n" : "__ACH_PLATFORM__=Linux|x86_64|musl\n"));
      };
      const shell = createHostShell({ localPlatform: () => platform, run: invoke, ssh: (id, command, opts) => invoke(id, command, opts) });
      const host = { id: "target", kind: transport, shell: family === "windows" ? "powershell" : "bash" };
      const runtime = await shell.resolveRuntime(host);
      assert.equal(runtime.transport, transport);
      assert.equal(runtime.family, family);
      assert.deepEqual(runtime.platform, platform);
      assert.deepEqual(capabilitiesFor(runtime), capabilitiesFor({ ...runtime, transport: transport === "ssh" ? "local" : "ssh" }));
      const payload = Buffer.from([0, 1, 13, 10, 255]);
      const script = family === "windows" ? "[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())" : "cat";
      await (family === "windows" ? shell.runHostPwsh : shell.runHostBash)(host, script, { input: payload });
      const last = calls.at(-1);
      assert.equal(last.opts.input, payload);
      if (family === "windows") {
        const encoded = Array.isArray(last.args) ? last.args.at(-1) : last.args.split(" ").at(-1);
        const decoded = Buffer.from(encoded, "base64").toString("utf16le");
        assert.ok(decoded.endsWith(script));
        if (transport === "ssh") assert.match(last.args, /^powershell -NoProfile/);
        else assert.equal(last.cmd, "pwsh");
      } else if (transport === "ssh") {
        assert.match(last.args, /^bash -c /);
        assert.doesNotMatch(last.args, /\|\s*bash/);
      } else assert.deepEqual(last.args, ["-c", script]);
      const before = calls.length;
      await assert.rejects(() => (family === "windows" ? shell.runHostBash : shell.runHostPwsh)(host, "wrong"), /不是/);
      assert.equal(calls.length, before, "环境不匹配时不发送业务脚本");
    });
  }
}

test("SSH Bash 命令经过默认 shell 后仍保留 stdin、引号与 Unicode", { skip: process.platform === "win32" }, async () => {
  const shell = createHostShell({ ssh: (_id, command, opts) => runProcess("sh", ["-c", command], opts) });
  const data = "中文 ' \" $() `literal`\r\n第二行\n";
  const r = await shell.runHostBash({ id: "loopback", kind: "ssh", shell: "bash" }, "cat; printf '诊断\\n' >&2", { input: data });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, data);
  assert.equal(r.stderr, "诊断\n");
});

test("平台探测拒绝 stderr 伪标记，失败不缓存；shell 覆盖变更使缓存失效", async () => {
  let fail = true;
  let calls = 0;
  const shell = createHostShell({ ssh: async (_id, command) => {
    calls++;
    if (fail) return { code: 1, stdout: "", stderr: "__ACH_PLATFORM__=Linux|x86_64|glibc", output: "" };
    return result(command.startsWith("bash") ? "__ACH_PLATFORM__=Linux|x86_64|glibc\n" : "__ACH_PLATFORM__=windows|AMD64|\n");
  } });
  const host = { id: "target", kind: "ssh", shell: "bash" };
  await assert.rejects(() => shell.resolveRuntime(host), /无法识别/);
  assert.equal(shell.getKnownRuntime(host), undefined);
  fail = false;
  assert.equal((await shell.resolveRuntime(host)).platform.sysname, "linux");
  await shell.resolveRuntime(host);
  assert.equal(calls, 2);
  assert.equal((await shell.resolveRuntime({ ...host, shell: "pwsh" })).platform.sysname, "windows");
  assert.equal(calls, 3);
});

test("macOS 的 Bash 不等于支持 GNU 安装/清理，npm 仍受支持", () => {
  const caps = capabilitiesFor({ family: "bash", platform: { sysname: "darwin", machine: "arm64" } });
  assert.equal(caps.standaloneInstall.supported, false);
  assert.equal(caps.cleanup.supported, false);
  assert.equal(caps.npmUpdate.supported, true);
  assert.equal(caps.check.supported, true);
});
