// 模型目录页 UI 冒烟：切到目录页，打开 kimi 文件，验证编辑器与推送表格
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://127.0.0.1:8722", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "模型目录", exact: true }).click();
await page.waitForSelector(".catalog-files .file-table tr", { timeout: 15000 });
console.log("file rows:", await page.locator(".catalog-files .file-table tbody tr").count());

// 打开 kimi 文件，等 CodeMirror 挂载
await page.getByRole("button", { name: "models.kimi.json", exact: true }).click();
await page.waitForSelector(".catalog-editor .cm-editor", { timeout: 10000 });
console.log("editor mounted:", await page.locator(".cm-editor .cm-line").count(), "lines");

// 合并预览与推送表
console.log("merged:", await page.locator(".merged-line").innerText());
console.log("push rows:", await page.locator(".push-table tbody tr").count());
const badges = await page.locator(".push-table .badge").allInnerTexts();
console.log("badges:", badges.join(", "));

await page.screenshot({ path: "data/ui-catalogs.png", fullPage: true });
await browser.close();
if (errors.length) throw new Error("页面报错: " + errors.join(" | "));
console.log("catalog UI smoke OK");
