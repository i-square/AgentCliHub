// 主机清单：本机 + ~/.ssh/config 中的 SSH 主机（按配置排除）
import os from "node:os";
import { isIP } from "node:net";
import { parseSshConfig, globToRegExp } from "./sshConfig.mjs";
import { localHostName } from "./platform.mjs";
import { detectHostShell } from "./hostShell.mjs";

export function buildHostList(config) {
  const excludes = (config.excludePatterns ?? []).map(globToRegExp);
  const sshHosts = parseSshConfig()
    .filter((h) => !excludes.some((re) => re.test(h.alias)))
    .map((h) => ({
      id: h.alias,
      kind: "ssh",
      name: h.alias,
      hostName: h.hostName ?? "",
      user: h.user ?? "",
      port: h.port ?? null
    }));

  const hosts = [
    { id: "local", kind: "local", name: localHostName(), hostName: "", user: "", port: null },
    ...sshHosts
  ];

  return hosts.map((h) => {
    const o = config.hostOverrides?.[h.id] ?? {};
    const blocked = o.enabled === false;
    return {
      ...h,
      // enabled 是最终可操作性；blocked 只表示用户显式屏蔽，重复禁用另存 duplicateOfLocal。
      blocked,
      enabled: !blocked,
      duplicateOfLocal: false,
      prelude: o.prelude ?? "",
      note: o.note ?? "",
      installDir: o.installDir ?? "",
      preferRelay: o.preferRelay ?? false,
      shell: o.shell ?? ""
    };
  });
}

export function getHost(config, id) {
  return buildHostList(config).find((h) => h.id === id) ?? null;
}

function normalizeIp(value) {
  const ip = String(value ?? "").trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  return isIP(mapped) ? mapped : "";
}

function localIpAddresses() {
  const result = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const ip = normalizeIp(entry.address);
      if (ip) result.add(ip);
    }
  }
  return result;
}

/** 纯规则：同 IP + 同 shell family 的 SSH 条目让位给 local；用户屏蔽状态独立保留。 */
export function applyLocalDuplicateRules(hosts, localAddresses, shellFamilies) {
  const local = hosts.find((h) => h.kind === "local");
  if (!local || !shellFamilies.local) return hosts;
  return hosts.map((h) => {
    if (h.kind !== "ssh") return h;
    const duplicate = localAddresses.has(normalizeIp(h.hostName)) && shellFamilies[h.id] === shellFamilies.local;
    return duplicate ? { ...h, enabled: false, duplicateOfLocal: true } : h;
  });
}

/**
 * 计算最终主机状态。只为地址命中本机 IP 的 SSH 候选补做 shell 探测，避免连接所有主机。
 * 使用最新检测或手动 shell 覆盖而非旧 probe 快照；探测失败保持可用，避免误禁用。
 */
export async function buildEffectiveHostList(config) {
  const hosts = buildHostList(config);
  const addresses = localIpAddresses();
  const local = hosts.find((h) => h.kind === "local");
  const shellFamilies = { local: local ? (await detectHostShell(local)).family : "" };
  const candidates = hosts.filter((h) => h.kind === "ssh" && addresses.has(normalizeIp(h.hostName)));
  await Promise.all(candidates.map(async (h) => {
    try {
      shellFamilies[h.id] = (await detectHostShell(h)).family;
    } catch {
      shellFamilies[h.id] = "";
    }
  }));
  return applyLocalDuplicateRules(hosts, addresses, shellFamilies);
}
