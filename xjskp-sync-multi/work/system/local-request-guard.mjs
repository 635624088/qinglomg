import crypto from "node:crypto";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const LOCAL_SESSION_HEADER = "x-xjskp-session-token";

export function createLocalRequestGuard(options = {}) {
  const token = String(options.token || crypto.randomBytes(32).toString("base64url"));
  const maxBodyBytes = Number(options.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES;
  let allowedHosts = normalizeAllowedHosts(options.allowedHosts);

  function assertLocalHost(req, port) {
    const host = String(req.headers.host || "").toLowerCase();
    // 反向代理（Cloudflare/nginx）场景：源站 Host 可能是私网/CGN IP，
    // X-Forwarded-Host 携带原始域名。若转发域名命中白名单则放行。
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").toLowerCase();
    const hostAllowed = isAllowedHost(host, port, allowedHosts);
    const forwardedAllowed = forwardedHost
      && isWhitelistedHost(forwardedHost, allowedHosts);
    if (!hostAllowed && !forwardedAllowed) {
      throw httpError(403, "LOCAL_REQUEST_FORBIDDEN", "Only the local console origin is allowed");
    }
    return { host, whitelisted: isWhitelistedHost(host, allowedHosts) || Boolean(forwardedAllowed) };
  }

  // 判断 host 是否命中白名单（区别于私网段校验）。白名单命中时允许
  // 反向代理/Cloudflare 场景的 https Origin 与域名 Host。
  function assertMutation(req, port) {
    const { host, whitelisted } = assertLocalHost(req, port);
    const origin = String(req.headers.origin || "");
    if (origin) {
      const originHostname = originHostnameOf(origin);
      const effectiveHostname = hostnameOf(host);
      const forwardedHostname = hostnameOf(String(req.headers["x-forwarded-host"] || ""));
      const hostnameMatched = originHostname === effectiveHostname
        || (forwardedHostname && originHostname === forwardedHostname);
      const originAllowed = whitelisted
        ? hostnameMatched
        : origin === `http://${host}`;
      if (!originAllowed) {
        throw httpError(403, "LOCAL_REQUEST_FORBIDDEN", "Cross-site requests are not allowed");
      }
    }
    const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw httpError(403, "LOCAL_REQUEST_FORBIDDEN", "Cross-site requests are not allowed");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
      throw httpError(415, "JSON_CONTENT_TYPE_REQUIRED", "Write requests must use application/json");
    }
    const provided = String(req.headers[LOCAL_SESSION_HEADER] || "");
    const expectedBuffer = Buffer.from(token);
    const providedBuffer = Buffer.from(provided);
    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      throw httpError(403, "LOCAL_SESSION_TOKEN_INVALID", "Local session token is missing or invalid");
    }
  }

  function setAllowedHosts(hosts) {
    allowedHosts = normalizeAllowedHosts(hosts);
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) {
        throw httpError(413, "REQUEST_BODY_TOO_LARGE", "Request body exceeds 256 KiB");
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw httpError(400, "INVALID_JSON_BODY", "Request body is not valid JSON");
    }
  }

  return { token, assertLocalHost, assertMutation, setAllowedHosts, readJsonBody };
}

function normalizeAllowedHosts(allowedHosts) {
  if (!Array.isArray(allowedHosts)) return [];
  const entries = [];
  for (const raw of allowedHosts) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value) continue;
    const colon = value.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
      entries.push({ name: value.slice(0, colon), port: Number(value.slice(colon + 1)) });
    } else {
      entries.push({ name: value, port: null });
    }
  }
  return entries;
}

function splitHostName(host) {
  const colon = host.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    return { name: host.slice(0, colon), port: Number(host.slice(colon + 1)) };
  }
  return { name: host, port: null };
}

// 提取 host（可能含端口）的 hostname 部分，统一小写。
function hostnameOf(host) {
  return splitHostName(String(host || "").toLowerCase()).name;
}

// 从 Origin（如 https://console.example.com）提取 hostname。
function originHostnameOf(origin) {
  const text = String(origin || "");
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    // 非 URL 形式 Origin 无法解析，按不匹配处理（保守拒绝）。
    return "";
  }
}

// 判断 host 是否命中白名单条目（不区分端口匹配）。
function isWhitelistedHost(host, allowedHosts = []) {
  const parsed = splitHostName(String(host || "").toLowerCase());
  return allowedHosts.some((entry) => (
    parsed.name === entry.name
    && (entry.port === null || parsed.port === entry.port)
  ));
}

function isAllowedHost(host, port, allowedHosts = []) {
  if (host === `localhost:${port}`) return true;
  const parsed = splitHostName(host);
  for (const entry of allowedHosts) {
    if (parsed.name === entry.name && (entry.port === null || parsed.port === entry.port)) {
      return true;
    }
  }
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/);
  if (!match) return false;
  const [a, b, c, d] = [match[1], match[2], match[3], match[4]].map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (Number(match[5]) !== port) return false;
  if (a === 127) return true; // 回环
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
