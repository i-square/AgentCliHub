import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./exec.mjs";
import { buildWindowsInstallScript, buildBashInstallScript, editClaudeSettings, editCodexConfigToml, installTool, preflight } from "./install.mjs";
import { bashPathExpr } from "./hostFiles.mjs";

test("Windows 安装脚本按目标机展开目录，传输后先校验再解包", () => {
  const artifact = { sha256: "a".repeat(64), target: "x86_64-pc-windows-msvc" };
  for (const tool of ["codex", "claude"]) {
    const script = buildWindowsInstallScript(tool, "1.2.3", artifact, "~/.local/bin", "~/.cache/pkg");
    assert.match(script, /Join-Path \$HOME '\.local\/bin'/);
    assert.match(script, /Get-FileHash -LiteralPath \$pkg/);
    assert.ok(script.indexOf("Get-FileHash") < script.indexOf(tool === "codex" ? "tar -xzf" : "Copy-Item -LiteralPath $pkg"));
    assert.doesNotMatch(script, /OpenStandardInput|FromBase64String/);
    assert.match(script, /__INSTALL_OK__/);
    if (tool === "codex") assert.match(script, /\$LASTEXITCODE -ne 0/);
  }
});

test("Bash 安装脚本语法与带空格/引号的路径可用", { skip: process.platform === "win32" }, async () => {
  for (const tool of ["codex", "claude"]) {
    const artifact = { sha256: "a".repeat(64), target: "x86_64-unknown-linux-musl" };
    const script = buildBashInstallScript(tool, "1.2.3", artifact, bashPathExpr("~/my tools/'literal"), 'cp "/tmp/package" "$PKG"', bashPathExpr("~/.cache/pkg"));
    const r = await runProcess("bash", ["-n"], { input: script });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(script.indexOf("sha256sum") < script.indexOf(tool === "codex" ? "tar -xzf" : "chmod 755"));
  }
});

test("自动更新编辑保留既有设置，坏 JSON 不覆盖", () => {
  const settings = JSON.parse(editClaudeSettings('{"env":{"KEY":"secret"},"custom":1}', { disableAutoUpdater: true, channel: "stable" }));
  assert.equal(settings.env.KEY, "secret");
  assert.equal(settings.custom, 1);
  assert.equal(settings.env.DISABLE_AUTOUPDATER, "1");
  assert.throws(() => editClaudeSettings("{broken", { disableAutoUpdater: true }));
  const toml = editCodexConfigToml('model = "custom"\n', { startupCheck: false, daemonAutoStart: false });
  assert.match(toml, /model = "custom"/);
  assert.match(toml, /check_for_update_on_startup = false/);
});

test("不支持的平台在读取版本缓存或下载前拒绝安装", async () => {
  // 明确的未知连接方式不得回落到 local/SSH 的任何执行器。
  await assert.rejects(() => installTool({ id: "unknown", kind: "invalid" }, "codex", { config: {} }, () => {}), /未知连接方式/);
});

test("安装预检按目标平台处理大小写、主目录与 PATH 分隔符", () => {
  const host = { id: "target", kind: "ssh" };
  const probe = {
    done: true,
    meta: { shell: "bash", home: "/home/user" },
    candidates: [],
    pathEntries: [{ index: 1, dir: "/home/user/Bin" }],
    contexts: {}
  };
  const state = { hosts: { target: { probe } } };
  assert.equal(preflight(host, "codex", "~/bin", state).status, "not-on-path");
  assert.equal(preflight(host, "codex", "~/Bin", state).status, "ok");
  probe.meta = { shell: "powershell", home: "C:\\Users\\user" };
  probe.pathEntries = [];
  probe.contexts = { login: { path: "C:\\Windows;C:\\Users\\user\\Bin", codex: "C:\\Users\\user\\Bin\\codex.exe" } };
  const result = preflight(host, "codex", "~\\bin", state);
  assert.equal(result.status, "ok");
  assert.equal(result.position, 2);
});
