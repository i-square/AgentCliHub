import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { runProcess } from "./exec.mjs";

test("执行层流式 stdin 保留所有字节并分离 stderr", async () => {
  const source = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const script = "const chunks=[]; process.stdin.on('data',x=>chunks.push(x)); process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(chunks).toString('base64'));process.stderr.write('diagnostic')})";
  const r = await runProcess(process.execPath, ["-e", script], { input: Readable.from([source.subarray(0, 13), source.subarray(13)]) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, source.toString("base64"));
  assert.equal(r.stderr, "diagnostic");
});

test("无输入时关闭 stdin，不阻塞等 EOF 的命令", async () => {
  const r = await runProcess(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('done'))"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "done\n");
});

test("启动失败、超时和取消返回失败并释放输入流", async () => {
  const missing = await runProcess("agentclihub-command-does-not-exist", []);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /spawn error/);
  const timeout = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 40 });
  assert.notEqual(timeout.code, 0);
  assert.match(timeout.stderr, /timeout/);
  const controller = new AbortController();
  const source = new Readable({ read() {} });
  const running = runProcess(process.execPath, ["-e", "process.stdin.resume()"], { input: source, signal: controller.signal });
  controller.abort();
  const cancelled = await running;
  assert.notEqual(cancelled.code, 0);
  assert.equal(source.destroyed, true);
});
