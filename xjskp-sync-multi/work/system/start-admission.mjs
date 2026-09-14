export function createStartAdmission(options = {}) {
  const configuredMaxParallelTasks = Number(options.maxParallelTasks);
  const maxParallelTasks = Number.isFinite(configuredMaxParallelTasks) && configuredMaxParallelTasks >= 1
    ? Math.floor(configuredMaxParallelTasks)
    : null;
  const startingProfiles = new Set();
  let tail = Promise.resolve();

  function enqueue(operation) {
    const current = tail.catch(() => {}).then(operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  }

  async function reserve(profileId, readRunningProfileIds) {
    const id = String(profileId || "");
    return await enqueue(async () => {
      const runningProfiles = new Set(await readRunningProfileIds());
      if (runningProfiles.has(id) || startingProfiles.has(id)) {
        const err = new Error(`Automation is already running for ${id}`);
        err.code = "ACTIVE_AUTOMATION_RUNNING";
        throw err;
      }

      const occupiedProfiles = new Set([...runningProfiles, ...startingProfiles]);
      if (maxParallelTasks !== null && occupiedProfiles.size >= maxParallelTasks) {
        const err = new Error(`Maximum parallel automation tasks reached (${maxParallelTasks})`);
        err.code = "MAX_PARALLEL_TASKS_REACHED";
        err.runningCount = occupiedProfiles.size;
        err.maxParallelTasks = maxParallelTasks;
        throw err;
      }

      startingProfiles.add(id);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          startingProfiles.delete(id);
        },
      };
    });
  }

  return { reserve };
}
