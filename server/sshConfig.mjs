// 解析 ~/.ssh/config，得到可用于 ssh <alias> 的主机列表
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @returns {Array<{alias: string, hostName?: string, user?: string, port?: number}>}
 */
export function parseSshConfig(file = path.join(os.homedir(), ".ssh", "config")) {
  if (!fs.existsSync(file)) return [];
  const hosts = [];
  let current = null;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "host") {
      current = null;
      for (const pattern of value.split(/\s+/)) {
        // 跳过通配符 / 否定模式，只保留具体别名
        if (/[*?!]/.test(pattern)) continue;
        current = { alias: pattern };
        hosts.push(current);
      }
    } else if (current) {
      if (key === "hostname") current.hostName = value;
      else if (key === "user") current.user = value;
      else if (key === "port") current.port = Number(value);
    }
  }
  return hosts;
}

/** 将通配模式（仅支持 * 后缀/前缀）转为 RegExp */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}
