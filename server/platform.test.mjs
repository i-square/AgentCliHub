import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLocalPlatform,
  platformLabel,
  localHostName,
  codexTarget,
  claudePlatform,
  assertWindowsLocal
} from "./platform.mjs";

test("本机平台自动识别并规范化 x64/arm64", () => {
  assert.deepEqual(detectLocalPlatform({ platform: "win32", arch: "x64" }), {
    sysname: "windows", machine: "x64", libc: ""
  });
  assert.deepEqual(detectLocalPlatform({ platform: "linux", arch: "aarch64", libc: "glibc" }), {
    sysname: "linux", machine: "arm64", libc: "glibc"
  });
  assert.strictEqual(platformLabel(detectLocalPlatform({ platform: "linux", arch: "x86_64", libc: "glibc" })), "Linux/x64");
  assert.strictEqual(localHostName(detectLocalPlatform({ platform: "win32", arch: "arm64" })), "local (本机 Windows/arm64)");
});

test("Codex 本机与 uname 架构名称映射到相同资产", () => {
  assert.strictEqual(codexTarget("windows", "x64"), "x86_64-pc-windows-msvc");
  assert.strictEqual(codexTarget("windows", "arm64"), "aarch64-pc-windows-msvc");
  assert.strictEqual(codexTarget("Linux", "x64"), "x86_64-unknown-linux-musl");
  assert.strictEqual(codexTarget("Linux", "x86_64"), "x86_64-unknown-linux-musl");
  assert.strictEqual(codexTarget("Linux", "arm64"), "aarch64-unknown-linux-musl");
  assert.strictEqual(codexTarget("Linux", "aarch64"), "aarch64-unknown-linux-musl");
});

test("Claude 资产区分 OS、架构和 Linux libc", () => {
  assert.strictEqual(claudePlatform("windows", "x64"), "win32-x64");
  assert.strictEqual(claudePlatform("windows", "arm64"), "win32-arm64");
  assert.strictEqual(claudePlatform("Linux", "x64", "glibc"), "linux-x64");
  assert.strictEqual(claudePlatform("Linux", "arm64", "glibc"), "linux-arm64");
  assert.strictEqual(claudePlatform("Linux", "x86_64", "musl"), "linux-x64-musl");
  assert.throws(() => claudePlatform("Linux", "ia32", "glibc"), /不支持的平台/);
});

test("非 Windows 本机不会误入 Windows 专用链路", () => {
  assert.doesNotThrow(() => assertWindowsLocal("状态检查", { sysname: "windows", machine: "x64" }));
  assert.throws(
    () => assertWindowsLocal("状态检查", { sysname: "linux", machine: "arm64" }),
    /Linux\/arm64.*状态检查.*不会再误走 Windows/
  );
});
