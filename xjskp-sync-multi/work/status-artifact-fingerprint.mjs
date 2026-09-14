import path from "node:path";

const OMITTED_KEYS = new Set([
  "updatedAt",
  "cycle",
  "accountScheduler",
  "nextMatureInSeconds",
  "nextMatureText",
  "remainingText",
  "restRemainingText",
  "remainingMs",
  "nextRestoreText",
  "nextRestoreInSeconds",
  "waterDropNextRestoreText",
  "doubleGoldRemainingText",
  "nextFmlLandScanAt",
  "nextScanAt",
]);

const stagedFingerprints = new Map();

export function buildStatusArtifactFingerprint(value) {
  return JSON.stringify(normalizeForFingerprint(value, null));
}

export function getStatusArtifactFingerprint(filePath, content) {
  if (!path.basename(String(filePath)).endsWith(".json")) return null;
  try {
    return buildStatusArtifactFingerprint(JSON.parse(Buffer.from(content).toString("utf8")));
  } catch {
    return null;
  }
}

export function rememberStagedArtifactFingerprint(filePath, fingerprint) {
  if (fingerprint !== null && fingerprint !== undefined) {
    stagedFingerprints.set(path.resolve(String(filePath)), fingerprint);
  }
}

export function takeStagedArtifactFingerprint(filePath) {
  const key = path.resolve(String(filePath));
  const fingerprint = stagedFingerprints.get(key) ?? null;
  stagedFingerprints.delete(key);
  return fingerprint;
}

export function clearStagedArtifactFingerprint(filePath) {
  stagedFingerprints.delete(path.resolve(String(filePath)));
}

function normalizeForFingerprint(value, key) {
  if (key && OMITTED_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => normalizeForFingerprint(item, null));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, normalizeForFingerprint(value[childKey], childKey)])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  return value;
}
