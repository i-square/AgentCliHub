// M1/M2 冒烟：版本缓存条、探测徽标、安装弹窗与 PATH 预检（需服务运行在 8899）
import { chromium } from "playwright";

const base = process.env.SMOKE_BASE ?? "http://127.0.0.1:8899";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".host-table tbody tr", { timeout: 10000 });

// 版本缓存条
const bar = await page.locator(".version-bar").textContent();
console.log("version-bar:", bar?.replace(/\s+/g, " ").trim());
if (!bar?.includes("codex") || !bar?.includes("claude")) throw new Error("版本缓存条缺内容");

// 本机行应有探测徽标（此前已探测过 local）
const localRow = page.locator(".host-table tbody tr", { hasText: "local" });
const badges = await localRow.locator(".badge").allTextContents();
console.log("local badges:", badges);

// 打开安装弹窗并跑预检
await localRow.locator("button.link", { hasText: "安装/切换" }).first().click();
await page.waitForSelector(".modal", { timeout: 5000 });
const title = await page.locator(".modal-head h3").textContent();
console.log("modal:", title);
await page.locator("button", { hasText: "PATH 预检" }).click();
await page.waitForSelector(".modal .badge", { timeout: 10000 });
const pf = await page.locator(".modal .badge").first().textContent();
console.log("preflight badge:", pf);
await page.screenshot({ path: "data/ui-smoke-standalone.png" });
await page.locator(".modal-head button").click();

console.log("page errors:", errors.length ? errors : "无");
if (errors.length) throw new Error("页面运行时错误");
console.log("UI smoke OK");
await browser.close();
