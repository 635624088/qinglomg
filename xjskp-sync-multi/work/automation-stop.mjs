import fs from "node:fs/promises";
import path from "node:path";

function profileIdFromPath(filePath) {
  return path.basename(path.dirname(path.resolve(filePath))) || "default";
}

export async function writeAutomationStopRequest(filePath, reason) {
  const request = {
    reason: String(reason || "user-stop"),
    requestedAt: new Date().toISOString(),
    profileId: profileIdFromPath(filePath),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return request;
}

export async function readAutomationStopRequest(filePath) {
  try {
    const request = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      !request
      || typeof request !== "object"
      || typeof request.reason !== "string"
      || !request.reason
      || typeof request.requestedAt !== "string"
      || !request.requestedAt
      || typeof request.profileId !== "string"
      || !request.profileId
    ) {
      throw new Error("invalid stop request contract");
    }
    return {
      reason: request.reason,
      requestedAt: request.requestedAt,
      profileId: request.profileId,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.error(`[automation-stop] failed to read ${filePath}: ${error?.message || error}`);
    return {
      reason: "invalid-stop-request",
      requestedAt: null,
      profileId: profileIdFromPath(filePath),
    };
  }
}

export async function clearAutomationStopRequest(filePath) {
  await fs.rm(filePath, { force: true });
}
