export const GAME_VERSION_CHECK_HOURS = Object.freeze([3, 15]);

export function getNextGameVersionCheckAt(now = new Date()) {
  const current = new Date(now);
  for (const hour of GAME_VERSION_CHECK_HOURS) {
    const candidate = new Date(current);
    candidate.setHours(hour, 0, 0, 0);
    if (candidate.getTime() >= current.getTime()) return candidate;
  }
  const tomorrow = new Date(current);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(GAME_VERSION_CHECK_HOURS[0], 0, 0, 0);
  return tomorrow;
}

export function createGameVersionScheduler(options = {}) {
  const check = options.check;
  const now = options.now || (() => new Date());
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const onError = options.onError || (() => {});
  let running = false;
  let timer = null;
  let nextCheckAt = null;
  let lastCheckAt = null;
  let lastErrorCode = null;

  function scheduleNext() {
    if (!running) return;
    const current = now();
    nextCheckAt = getNextGameVersionCheckAt(current);
    const delay = Math.max(0, nextCheckAt.getTime() - current.getTime());
    timer = setTimeoutFn(runScheduledCheck, delay);
    timer?.unref?.();
  }

  async function runScheduledCheck() {
    timer = null;
    nextCheckAt = null;
    lastCheckAt = now();
    try {
      await check();
      lastErrorCode = null;
    } catch (error) {
      lastErrorCode = safeErrorCode(error?.code);
      onError({ code: lastErrorCode });
    } finally {
      scheduleNext();
    }
  }

  function start() {
    if (running) return;
    running = true;
    scheduleNext();
  }

  function stop() {
    running = false;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    nextCheckAt = null;
  }

  function getStatus() {
    return {
      running,
      hours: [...GAME_VERSION_CHECK_HOURS],
      nextCheckAt: nextCheckAt?.toISOString() || null,
      lastCheckAt: lastCheckAt?.toISOString() || null,
      lastErrorCode,
    };
  }

  return { start, stop, getStatus, runNow: runScheduledCheck };
}

function safeErrorCode(value) {
  const code = String(value || "VERSION_CHECK_FAILED");
  return /^VERSION_CHECK_[A-Z_]+$/.test(code) ? code : "VERSION_CHECK_FAILED";
}
