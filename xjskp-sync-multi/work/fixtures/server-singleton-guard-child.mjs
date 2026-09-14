import { acquireServerSingletonGuard } from "../system/server-singleton-guard.mjs";

const runtimeDir = process.argv[2];
let guard = null;

try {
  guard = await acquireServerSingletonGuard({ runtimeDir, timeoutMs: 0 });
  process.send?.({
    status: "acquired",
    instanceId: guard.instanceId,
    guardName: guard.guardName,
  });
} catch (error) {
  process.send?.({ status: "error", code: error?.code, message: error?.message });
  process.exitCode = 1;
}

process.on("message", async (message) => {
  if (message !== "release") return;
  await guard?.release();
  process.exit(0);
});
