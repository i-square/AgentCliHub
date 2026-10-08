// 主机清单：本机 + ~/.ssh/config 中的 SSH 主机（按配置排除）
import { parseSshConfig, globToRegExp } from "./sshConfig.mjs";

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
    { id: "local", kind: "local", name: "local (本机 Windows)", hostName: "", user: "", port: null },
    ...sshHosts
  ];

  return hosts.map((h) => {
    const o = config.hostOverrides?.[h.id] ?? {};
    return {
      ...h,
      enabled: o.enabled ?? true,
      prelude: o.prelude ?? "",
      note: o.note ?? ""
    };
  });
}

export function getHost(config, id) {
  return buildHostList(config).find((h) => h.id === id) ?? null;
}
