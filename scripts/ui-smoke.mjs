// UI 冒烟测试：截图仪表盘并做基本断言
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8722", { waitUntil: "networkidle" });
await page.waitForSelector(".host-table tbody tr", { timeout: 10000 });
const rows = await page.locator(".host-table tbody tr").count();
console.log("host rows:", rows);
await page.screenshot({ path: "data/ui-dashboard.png", fullPage: true });
await browser.close();
if (rows < 6) throw new Error("主机行数不足");
console.log("UI smoke OK");
