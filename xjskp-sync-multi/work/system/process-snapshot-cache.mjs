export function createStaleWhileRevalidateSnapshot({
  load,
  maxAgeMs,
  now = Date.now,
  onError = () => {},
}) {
  if (typeof load !== "function") throw new TypeError("load must be a function");

  const normalizedMaxAgeMs = Math.max(0, Number(maxAgeMs) || 0);
  let hasValue = false;
  let value;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let refreshPromise = null;

  function refresh({ background = false } = {}) {
    if (refreshPromise) return refreshPromise;

    const currentRefresh = Promise.resolve()
      .then(() => load())
      .then((nextValue) => {
        value = nextValue;
        hasValue = true;
        refreshedAt = Number(now());
        return value;
      })
      .catch((error) => {
        if (!background || !hasValue) throw error;
        refreshedAt = Number(now());
        onError(error);
        return value;
      })
      .finally(() => {
        if (refreshPromise === currentRefresh) refreshPromise = null;
      });
    refreshPromise = currentRefresh;
    return currentRefresh;
  }

  async function get() {
    if (!hasValue) return await refresh();
    if (Number(now()) - refreshedAt >= normalizedMaxAgeMs) {
      void refresh({ background: true });
    }
    return value;
  }

  function prime() {
    void refresh({ background: true }).catch(onError);
  }

  async function flush() {
    if (refreshPromise) await refreshPromise;
  }

  return { get, refresh, prime, flush };
}
