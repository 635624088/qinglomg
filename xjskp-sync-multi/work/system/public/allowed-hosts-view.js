export function parseAllowedHostsInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const seen = new Set();
  const hosts = [];
  for (const raw of text.split(/[,，\n]/)) {
    const host = String(raw ?? "").trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

export function formatAllowedHostsInput(hosts) {
  if (!Array.isArray(hosts)) return "";
  return hosts.map((host) => String(host ?? "").trim()).filter(Boolean).join(", ");
}
