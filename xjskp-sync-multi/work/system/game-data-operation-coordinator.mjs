export function createGameDataOperationCoordinator() {
  let officialOperation = null;
  const runtimeTransitions = new Map();
  let tail = Promise.resolve();
  let sequence = 0;

  function enterCritical(operation) {
    const current = tail.catch(() => {}).then(operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  }

  async function acquireOfficial(kind) {
    return enterCritical(() => {
      if (officialOperation) {
        const checking = officialOperation.kind === "version-check" && kind === "version-check";
        throw coordinatorError(
          409,
          checking ? "VERSION_CHECK_IN_PROGRESS" : "GAME_DATA_SYNC_IN_PROGRESS",
          checking ? "已有版本检查正在进行" : "已有版本检查或数据同步正在进行",
        );
      }
      if (kind === "game-data-sync" && runtimeTransitions.size > 0) {
        throw coordinatorError(409, "GAME_DATA_SYNC_RUNTIME_ACTIVE", "账号任务正在启动、停止或恢复");
      }
      const token = `${kind}-${++sequence}`;
      officialOperation = { kind, token };
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          void enterCritical(() => {
            if (officialOperation?.token === token) officialOperation = null;
          });
        },
      };
    });
  }

  async function runVersionCheck(operation) {
    const reservation = await acquireOfficial("version-check");
    try {
      return await operation();
    } finally {
      reservation.release();
      await tail;
    }
  }

  async function runGameDataSync(operation) {
    const reservation = await acquireOfficial("game-data-sync");
    try {
      return await operation();
    } finally {
      reservation.release();
      await tail;
    }
  }

  async function reserveRuntimeTransition(profileId, kind = "start") {
    return enterCritical(() => {
      if (officialOperation?.kind === "game-data-sync" && kind !== "stop") {
        throw coordinatorError(409, "GAME_DATA_SYNC_IN_PROGRESS", "游戏数据同步期间不能启动账号任务");
      }
      const token = `runtime-${++sequence}`;
      runtimeTransitions.set(token, {
        profileId: String(profileId || ""),
        kind: String(kind || "start"),
      });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          void enterCritical(() => runtimeTransitions.delete(token));
        },
      };
    });
  }

  function getStatus() {
    return {
      officialOperation: officialOperation ? { kind: officialOperation.kind } : null,
      runtimeTransitions: Array.from(runtimeTransitions.values(), (entry) => ({ ...entry })),
    };
  }

  return Object.freeze({
    runVersionCheck,
    runGameDataSync,
    reserveRuntimeTransition,
    getStatus,
  });
}

function coordinatorError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}
