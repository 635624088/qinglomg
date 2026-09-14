// 接口限频守卫：对齐官方客户端 IFACELIMIT 语义。
//
// 官方客户端（410.0.21 game.js）对配置了 ifaceLimit 的接口使用滑动窗口限频：
//   packRequest: 窗口 time 毫秒内最多 limit 次请求，超限直接拒绝（默认 errCode 263）。
// 本模块在自动化侧维护同语义的 per-iface 滑动窗口，并在收到服务端限频错误时
// 触发自适应退避，减少对限频接口的无效重试。

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 1_000;
export const DEFAULT_RATE_LIMIT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_RATE_LIMIT_MIN_BACKOFF_MS = 300;
// 默认 0 = 不限制窗口内请求次数（正常运行零开销），
// 只在收到服务端限频错误后启用退避。
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 0;

// 服务端限频错误特征。默认 errCode 263；业务文案作为补充识别。
const RATE_LIMIT_CODE_HINTS = new Set([263]);
const RATE_LIMIT_TEXT_HINTS = [
  "操作频繁",
  "操作过于频繁",
  "请求过于频繁",
  "请稍后再试",
  "访问频繁",
  "请求太快",
  "too many requests",
  "rate limit",
  "frequent",
];

function extractErrorPayload(err) {
  if (!err) return null;
  const payload = err?.errMsg
    || err?.payload
    || err?.body
    || (typeof err?.message === "string" ? parseJsonFromMessage(err.message) : null);
  return payload && typeof payload === "object" ? payload : null;
}

function parseJsonFromMessage(message) {
  const text = String(message || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function findErrorCode(err) {
  const payload = extractErrorPayload(err);
  if (payload) {
    const code = Number(payload.code ?? payload.type ?? payload.errCode);
    if (Number.isFinite(code) && code > 0) return code;
  }
  // 错误消息本身可能包含 code
  if (typeof err?.code === "number") return err.code;
  const text = String(err?.message || err?.errMsg || "");
  const match = text.match(/["']?(?:code|type|errCode)["']?\s*[:=]\s*(\d+)/);
  if (match) return Number(match[1]);
  return null;
}

function findErrorText(err) {
  const payload = extractErrorPayload(err);
  const candidates = [
    payload?.msg,
    payload?.message,
    payload?.desc,
    typeof payload === "string" ? payload : null,
    err?.message,
    err?.errMsg && typeof err.errMsg === "string" ? err.errMsg : null,
  ];
  return candidates
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase())
    .join(" ");
}

export function isRequestRateLimitedError(err) {
  if (!err) return false;
  const code = findErrorCode(err);
  if (code != null && RATE_LIMIT_CODE_HINTS.has(code)) return true;
  const text = findErrorText(err);
  return RATE_LIMIT_TEXT_HINTS.some((hint) => text.includes(hint.toLowerCase()));
}

export function createRateLimitError(iface, details = {}) {
  const error = new Error(`接口 ${iface} 触发服务端限频，已进入退避`);
  error.code = "REQUEST_RATE_LIMITED";
  error.rateLimited = true;
  error.iface = iface;
  error.rateLimitDetails = details;
  return error;
}

function nowMs(nowFn = Date.now) {
  return nowFn();
}

export function createRateLimitGuard(options = {}) {
  const windowMs = Number.isFinite(Number(options.windowMs))
    ? Math.max(1, Number(options.windowMs))
    : DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxBackoffMs = Number.isFinite(Number(options.maxBackoffMs))
    ? Math.max(1, Number(options.maxBackoffMs))
    : DEFAULT_RATE_LIMIT_MAX_BACKOFF_MS;
  const minBackoffMs = Number.isFinite(Number(options.minBackoffMs))
    ? Math.max(0, Number(options.minBackoffMs))
    : DEFAULT_RATE_LIMIT_MIN_BACKOFF_MS;
  const maxRequestsPerWindow = Number.isFinite(Number(options.maxRequestsPerWindow))
    ? Math.max(0, Number(options.maxRequestsPerWindow))
    : DEFAULT_RATE_LIMIT_MAX_REQUESTS;
  const nowFn = options.nowFn || Date.now;
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // iface -> { requestTimes: number[], backoffUntilMs: number, backoffCount: number, lastRateLimitedAtMs: number|null }
  const state = new Map();

  function ifaceState(iface) {
    let entry = state.get(iface);
    if (!entry) {
      entry = {
        requestTimes: [],
        backoffUntilMs: 0,
        backoffCount: 0,
        lastRateLimitedAtMs: null,
        rateLimitedCount: 0,
      };
      state.set(iface, entry);
    }
    return entry;
  }

  function pruneWindow(entry, current) {
    const cutoff = current - windowMs;
    entry.requestTimes = entry.requestTimes.filter((time) => time >= cutoff);
  }

  // 检查某接口当前是否应放行；不放行时返回需要等待的毫秒数。
  function requestAllowed(iface, current = nowFn()) {
    const entry = state.get(iface);
    if (!entry) return { allowed: true, waitMs: 0 };
    if (current < entry.backoffUntilMs) {
      return { allowed: false, waitMs: entry.backoffUntilMs - current };
    }
    if (maxRequestsPerWindow > 0) {
      pruneWindow(entry, current);
      if (entry.requestTimes.length >= maxRequestsPerWindow) {
        const oldest = entry.requestTimes[0];
        return { allowed: false, waitMs: Math.max(1, windowMs - (current - oldest)) };
      }
    }
    return { allowed: true, waitMs: 0 };
  }

  // 记录一次请求发出（仅在启用窗口限制时维护请求时间窗）。
  function recordRequest(iface, current = nowFn()) {
    if (maxRequestsPerWindow <= 0) return;
    const entry = ifaceState(iface);
    pruneWindow(entry, current);
    entry.requestTimes.push(current);
  }

  // 收到服务端限频错误后触发指数退避。
  function recordRateLimited(iface, current = nowFn()) {
    const entry = ifaceState(iface);
    entry.rateLimitedCount += 1;
    entry.lastRateLimitedAtMs = current;
    const backoffMs = Math.min(
      maxBackoffMs,
      minBackoffMs * Math.pow(2, Math.min(entry.backoffCount, 10)),
    );
    entry.backoffCount += 1;
    entry.backoffUntilMs = current + backoffMs;
    return backoffMs;
  }

  // 一段时间无限频错误后，重置退避计数（渐进恢复）。无状态时不做任何事。
  function observeSuccess(iface, current = nowFn(), resetAfterMs = 60_000) {
    const entry = state.get(iface);
    if (
      entry
      && entry.backoffCount > 0
      && entry.lastRateLimitedAtMs != null
      && current - entry.lastRateLimitedAtMs >= resetAfterMs
    ) {
      entry.backoffCount = 0;
      entry.backoffUntilMs = 0;
    }
  }

  // 获取限频状态快照（只读，供状态页/日志观测）。
  function snapshot() {
    const current = nowFn();
    const out = {};
    for (const [iface, entry] of state.entries()) {
      pruneWindow(entry, current);
      out[iface] = {
        windowMs,
        maxRequestsPerWindow,
        recentRequestCount: entry.requestTimes.length,
        backoffUntilMs: entry.backoffUntilMs,
        backoffRemainingMs: Math.max(0, entry.backoffUntilMs - current),
        backoffCount: entry.backoffCount,
        rateLimitedCount: entry.rateLimitedCount,
        lastRateLimitedAtMs: entry.lastRateLimitedAtMs,
      };
    }
    return out;
  }

  // 在发送请求前调用：若接口处于退避或窗口满，返回等待 ms；否则记录请求并返回 0。
  async function acquire(iface) {
    while (true) {
      const decision = requestAllowed(iface);
      if (decision.allowed) {
        recordRequest(iface);
        return 0;
      }
      await sleepFn(decision.waitMs);
    }
  }

  return {
    requestAllowed,
    recordRequest,
    recordRateLimited,
    observeSuccess,
    snapshot,
    acquire,
    isRequestRateLimitedError,
    createRateLimitError,
  };
}
