export function createProfileOperationCoordinator() {
  const queues = new Map();

  function run(profileId, operation) {
    const previous = queues.get(profileId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    let tracked;
    tracked = current.finally(() => {
      if (queues.get(profileId) === tracked) queues.delete(profileId);
    });
    queues.set(profileId, tracked);
    return tracked;
  }

  function runCanonical(profileId, operation) {
    const canonicalId = canonicalizeProfileOperationKey(profileId);
    if (!canonicalId) {
      const error = new Error("Profile ID cannot produce a canonical operation key");
      error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
      throw error;
    }
    return run(canonicalId, () => operation(canonicalId));
  }

  return { run, runCanonical };
}

export function canonicalizeProfileOperationKey(value) {
  const canonicalId = String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return canonicalId || null;
}
