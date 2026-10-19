// 合并逻辑回归测试：确保合并时不丢失 settings 中的其他字段，且 catalog 内外条目按预期处理
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  mergeModelPicker,
  parseSettingsText,
  readTextIfExists,
  parseRemoteSettingsRead,
  buildRemoteSettingsReadScript,
  buildRemoteSettingsWriteScript
} from "./tools.mjs";

// ── mergeModelPicker ─────────────────────────────────────────────────────────
const catalogSlugs = new Set(["glm-5.3", "k3", "kimi-for-coding", "deepseek-v4-pro"]);

console.log("测试 1：空 settings 写入新 options");
{
  const r = mergeModelPicker({}, [{ model: "k3[1m]", label: "Kimi K3" }], catalogSlugs);
  assert.deepStrictEqual(r.settings.modelPicker.options, [{ model: "k3[1m]", label: "Kimi K3" }]);
  assert.strictEqual(r.kept, 0, "无手工条目");
  assert.ok(!("env" in r.settings), "不引入其他字段");
}

console.log("测试 2：保留 settings 其他字段");
{
  const cur = { env: { A: "1" }, outputStyle: "pro", modelPicker: { options: [] } };
  const r = mergeModelPicker(cur, [{ model: "k3[1m]", label: "K3" }], catalogSlugs);
  assert.strictEqual(r.settings.env.A, "1");
  assert.strictEqual(r.settings.outputStyle, "pro");
  assert.strictEqual(r.kept, 0);
}

console.log("测试 3：手工条目（catalog 外）保留且排在后面");
{
  const cur = {
    modelPicker: {
      options: [
        { model: "glm-5.3[1m]", label: "旧 GLM" },
        { model: "my-custom", label: "手工" },
        { model: "k3[1m]", label: "旧 K3" }
      ]
    }
  };
  const newOpts = [{ model: "deepseek-v4-pro[1m]", label: "DeepSeek" }];
  const r = mergeModelPicker(cur, newOpts, catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["deepseek-v4-pro[1m]", "my-custom"]
  );
  assert.strictEqual(r.kept, 1, "my-custom 是手工条目");
}

console.log("测试 4：多个手工条目按原顺序保留");
{
  const cur = {
    modelPicker: {
      options: [
        { model: "glm-5.3[1m]", label: "旧" },
        { model: "extra-1", label: "手工1" },
        { model: "k3[1m]", label: "旧2" },
        { model: "extra-2", label: "手工2" }
      ]
    }
  };
  const r = mergeModelPicker(cur, [{ model: "kimi-for-coding[1m]", label: "Kimi" }], catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["kimi-for-coding[1m]", "extra-1", "extra-2"]
  );
  assert.strictEqual(r.kept, 2);
}

console.log("测试 5：去掉 [1m] 后缀再匹配 catalog slug");
{
  const cur = { modelPicker: { options: [{ model: "k3[1m]", label: "旧" }, { model: "orphan", label: "孤儿" }] } };
  const r = mergeModelPicker(cur, [{ model: "k3", label: "新K3不带后缀" }], catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["k3", "orphan"]
  );
  assert.strictEqual(r.kept, 1);
}

// ── parseSettingsText ────────────────────────────────────────────────────────
console.log("测试 6：空文本 → {}");
assert.deepStrictEqual(parseSettingsText("", "test"), {});
assert.deepStrictEqual(parseSettingsText("  \n ", "test"), {});

console.log("测试 7：非法 JSON 抛错");
assert.throws(() => parseSettingsText("{broken", "test.json"), /不是合法的 JSON 对象/);
assert.throws(() => parseSettingsText("[]", "test.json"), /不是合法的 JSON 对象/);
assert.throws(() => parseSettingsText("null", "test.json"), /不是合法的 JSON 对象/);

console.log("测试 8：合法 JSON 对象通过");
assert.deepStrictEqual(parseSettingsText('{"a":1}', "test"), { a: 1 });

// ── readTextIfExists ─────────────────────────────────────────────────────────
console.log("测试 9：本机读取 ENOENT → {exists:false}");
{
  const r = await readTextIfExists("/nonexistent-path-" + Date.now() + ".json");
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.raw, "");
}

console.log("测试 10：本机读取失败（非 ENOENT）→ 抛错而非当作不存在");
{
  // 读取目录得到 EISDIR，与「文件不存在」必须区分开，否则会用空配置覆盖原文件
  await assert.rejects(() => readTextIfExists(os.tmpdir()), /读取 .* 失败.*已中止/);
}

// ── parseRemoteSettingsRead（带随机 nonce 的标记协议）────────────────────────
const N = "abc123";
const wrap = (body) => `__CCS_${N}_BEGIN__\n${body}\n__CCS_${N}_END__\n`;

console.log("测试 11：远程读取退出码非 0 → 抛错");
assert.throws(() => parseRemoteSettingsRead({ code: 1, output: "error" }, "host1", N), /读取 host1 失败.*退出码 1/);

console.log("测试 12：缺少完整标记 → 抛错而非当作不存在");
assert.throws(() => parseRemoteSettingsRead({ code: 0, output: "some partial output" }, "host2", N), /读取 host2 失败.*输出不完整/);

console.log("测试 13：本次 nonce 的 MISSING 标记 → {exists:false}");
{
  const r = parseRemoteSettingsRead({ code: 0, output: `banner\n__CCS_${N}_MISSING__\n` }, "host3", N);
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.raw, "");
}

console.log("测试 14：完整标记包裹 JSON → {exists:true, raw:...}");
{
  const r = parseRemoteSettingsRead({ code: 0, output: wrap('{"x":1}') }, "host4", N);
  assert.strictEqual(r.exists, true);
  assert.deepStrictEqual(parseSettingsText(r.raw, "host4"), { x: 1 });
}

console.log("测试 15：配置内容含旧版固定标记字符串 → 仍识别为已存在，内容完整");
{
  const content = JSON.stringify({ note: "__CCS_MISSING__", legacy: "__CCS_BEGIN__\n__CCS_END__", keep: 1 }, null, 2);
  const r = parseRemoteSettingsRead({ code: 0, output: wrap(content) }, "host5", N);
  assert.strictEqual(r.exists, true);
  assert.deepStrictEqual(parseSettingsText(r.raw, "host5"), JSON.parse(content));
}

console.log("测试 16：其他 nonce 的标记不被接受（防伪造/串扰）");
assert.throws(
  () => parseRemoteSettingsRead({ code: 0, output: "__CCS_ffff_MISSING__\n" }, "host6", N),
  /输出不完整/
);

// ── 用 bash 真实执行读写脚本（无 bash 或沙箱 HOME 不生效时跳过）──────────────
function makeSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccs-test-"));
  const probe = spawnSync("bash", ["-c", 'mkdir -p "$HOME/.claude" && echo ok'], {
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
  if (probe.status !== 0 || !fs.existsSync(path.join(home, ".claude"))) {
    fs.rmSync(home, { recursive: true, force: true });
    return null;
  }
  return home;
}
const home = makeSandbox();
if (!home) {
  console.log("跳过 bash 脚本实测：未找到可用的 bash 或 HOME 沙箱不生效");
} else {
  const sh = (script, input) =>
    spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home }, input, encoding: "utf8" });
  const file = path.join(home, ".claude", "settings.json");
  const readRemote = () => {
    const r = sh(buildRemoteSettingsReadScript(N));
    return parseRemoteSettingsRead({ code: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") }, "sandbox", N);
  };
  const posix = process.platform !== "win32"; // Windows 上 chmod 不反映真实权限位
  const modeOf = (f) => fs.statSync(f).mode & 0o777;

  try {
    console.log("测试 17：[bash] 文件不存在 → exists:false");
    assert.strictEqual(readRemote().exists, false);

    console.log("测试 18：[bash] 内容含固定标记字符串的已有配置 → 读到完整内容，不被误判为不存在");
    const original = { note: "__CCS_MISSING__", env: { KEY: "secret" }, modelPicker: { options: [{ model: "my-custom" }] } };
    fs.writeFileSync(file, JSON.stringify(original, null, 2));
    const got = readRemote();
    assert.strictEqual(got.exists, true);
    assert.deepStrictEqual(JSON.parse(got.raw), original);

    console.log("测试 19：[bash] 读取失败（路径是目录）→ 非 0 退出，不当作不存在");
    fs.rmSync(file);
    fs.mkdirSync(file);
    {
      const r = sh(buildRemoteSettingsReadScript(N));
      assert.notStrictEqual(r.status, 0);
      assert.throws(
        () => parseRemoteSettingsRead({ code: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") }, "sandbox", N),
        /读取 sandbox 失败/
      );
    }
    fs.rmSync(file, { recursive: true });

    console.log("测试 20：[bash] 写入：内容正确、已有文件备份为 .bak");
    fs.writeFileSync(file, JSON.stringify(original));
    if (posix) fs.chmodSync(file, 0o640);
    const next = { ...original, modelPicker: { options: [{ model: "k3[1m]" }] } };
    const w = sh(buildRemoteSettingsWriteScript(), Buffer.from(JSON.stringify(next, null, 2) + "\n").toString("base64"));
    assert.strictEqual(w.status, 0, w.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), original);

    if (posix) {
      console.log("测试 21：[bash] 权限：已有文件继承原 mode(0640)，.bak 为 0600");
      assert.strictEqual(modeOf(file), 0o640);
      assert.strictEqual(modeOf(`${file}.bak`), 0o600);

      console.log("测试 22：[bash] 权限：预先存在的宽权限 .bak 不会被沿用");
      fs.chmodSync(`${file}.bak`, 0o644);
      const w2 = sh(buildRemoteSettingsWriteScript(), Buffer.from("{}\n").toString("base64"));
      assert.strictEqual(w2.status, 0, w2.stderr);
      assert.strictEqual(modeOf(`${file}.bak`), 0o600);

      console.log("测试 23：[bash] 权限：新建文件为 0600");
      fs.rmSync(file);
      fs.rmSync(`${file}.bak`, { force: true });
      const w3 = sh(buildRemoteSettingsWriteScript(), Buffer.from("{}\n").toString("base64"));
      assert.strictEqual(w3.status, 0, w3.stderr);
      assert.strictEqual(modeOf(file), 0o600);
    } else {
      console.log("跳过测试 21-23：Windows 上无法验证 POSIX 权限位（需在 Linux/WSL 上运行）");
    }

    console.log("测试 24：[bash] 写入失败（stdin 非法 base64）→ 非 0 退出，原文件不变，不残留临时文件");
    fs.writeFileSync(file, JSON.stringify(original));
    const bad = sh(buildRemoteSettingsWriteScript(), "!!!not-base64!!!");
    assert.notStrictEqual(bad.status, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("AgentCliHub-")), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("测试 25：ssh stderr 诊断不会混入 Claude settings 内容");
{
  const clean = wrap('{"keep":1}');
  const diagnostic = "client_global_hostkeys_prove_confirm: server gave bad signature for RSA key 0: incorrect signature";
  const combined = clean.replace('{"keep":1}', `{"keep":1}\n${diagnostic}`);
  const r = parseRemoteSettingsRead({ code: 0, stdout: clean, stderr: diagnostic, output: combined }, "host7", N);
  assert.strictEqual(r.exists, true);
  assert.deepStrictEqual(parseSettingsText(r.raw, "host7"), { keep: 1 });
}

console.log("✅ 全部测试通过");
