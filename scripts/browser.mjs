import { chromium } from "playwright";

// Windows/Linux 沿用系统浏览器，其他平台使用 Playwright Chromium。
export function launchSmokeBrowser() {
  const channel = process.platform === "win32" ? "msedge" : process.platform === "linux" ? "chrome" : undefined;
  return chromium.launch(channel ? { channel } : {});
}
