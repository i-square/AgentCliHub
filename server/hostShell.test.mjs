import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShellOverride, parseWindowsShellProbe, runHostBash } from "./hostShell.mjs";
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
