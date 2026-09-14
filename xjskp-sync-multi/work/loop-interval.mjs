function toPositiveInteger(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getLoopIntervalConfig(env = process.env) {
  const fixedSeconds = toPositiveInteger(env.LOOP_INTERVAL_SECONDS);
  if (fixedSeconds > 0) {
    return {
      mode: "fixed",
      seconds: Math.max(10, fixedSeconds),
    };
  }

  const minSeconds = Math.max(10, toPositiveInteger(env.LOOP_INTERVAL_MIN_SECONDS, 30));
  const maxSeconds = Math.max(minSeconds, toPositiveInteger(env.LOOP_INTERVAL_MAX_SECONDS, 58));
  return {
    mode: "random",
    minSeconds,
    maxSeconds,
  };
}

export function getLoopSleepSeconds(env = process.env, rng = Math.random) {
  const config = getLoopIntervalConfig(env);
  if (config.mode === "fixed") return config.seconds;

  const span = config.maxSeconds - config.minSeconds + 1;
  const r = Math.min(0.999999999999, Math.max(0, Number(rng()) || 0));
  return config.minSeconds + Math.floor(r * span);
}
