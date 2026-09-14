import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProfileStore } from "../system/profile-store.mjs";
import { createSystemServer } from "../system/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "work", "system", "public");
const SETTINGS_PATH = /^\/api\/profiles\/[^/]+\/settings$/;

export async function startT6ProfileSettingsVisibleServer(options = {}) {
  const tempRoot = options.tempRoot || await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-t6-profile-settings-"));
  assertSafeTempRoot(tempRoot);
  const runtimeDir = path.join(tempRoot, "runtime");
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
    protect: (value) => `fixture:${value}`,
    unprotect: (value) => String(value).replace(/^fixture:/, ""),
  });
  await seedProfiles(profileStore);

  let workerStarts = 0;
  let externalGameCalls = 0;
  const disabledError = () => {
    const error = new Error("This action is disabled in the isolated T6 fixture");
    error.code = "T6_FIXTURE_ACTION_DISABLED";
    error.statusCode = 409;
    return error;
  };
  const runner = {
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0 }),
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0 }),
    restoreDesiredLoops: async () => ({ desired: 0, scheduled: 0 }),
    stop: async () => ({ stopped: false }),
    beginAutomationAlreadyCoordinated: async () => {
      workerStarts += 1;
      throw disabledError();
    },
  };
  const gameVersionService = {
    getStatus: async () => ({ status: "disabled", reason: "t6-isolated-fixture" }),
    checkScheduled: async () => ({ status: "disabled" }),
    check: async () => {
      externalGameCalls += 1;
      throw disabledError();
    },
  };
  const gameVersionScheduler = {
    start() {},
    async stop() {},
    getStatus: () => ({ running: false, reason: "t6-isolated-fixture" }),
  };
  const sessionToken = randomUUID();
  const inner = createSystemServer({
    rootDir: tempRoot,
    runtimeDir,
    publicDir: PUBLIC_DIR,
    listenHost: "127.0.0.1",
    localRequestToken: sessionToken,
    profileStore,
    runner,
    coordinatedRunner: runner,
    gameVersionService,
    gameVersionScheduler,
  });
  await inner.listen(0);

  const controlToken = randomUUID();
  const controls = createControls();
  let closing = false;
  const proxy = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/__t6/legacy-page") {
        sendLegacyPage(response);
        return;
      }
      if (url.pathname.startsWith("/__t6/")) {
        await handleControl({ request, response, url, controls, controlToken, sessionToken, close: () => close() });
        return;
      }
      if (request.method === "POST" && !SETTINGS_PATH.test(url.pathname)) {
        sendJson(response, 409, { error: "T6_FIXTURE_ACTION_DISABLED" });
        return;
      }
      await proxyRequest({ request, response, url, innerPort: inner.port, controls });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: "T6_FIXTURE_PROXY_ERROR", message: error?.message || String(error) });
      } else if (!response.destroyed) {
        response.destroy(error);
      }
    }
  });
  await listenLoopback(proxy, options.port || 0);
  const port = proxy.address().port;

  async function close() {
    if (closing) return;
    closing = true;
    controls.releaseAll();
    await closeHttpServer(proxy);
    await inner.close();
    if (workerStarts !== 0 || externalGameCalls !== 0) {
      throw new Error(`T6 safety counters changed: workers=${workerStarts}, gameCalls=${externalGameCalls}`);
    }
    assertSafeTempRoot(tempRoot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    innerPort: inner.port,
    tempRoot,
    controlToken,
    controls,
    close,
    safetyCounters: () => ({ workerStarts, externalGameCalls }),
  };
}

function createControls() {
  const state = {
    holdNextMutation: false,
    holdNextMutationResponse: false,
    holdNextReconcile: false,
    dropNextMutationAfterCommit: false,
    degradeNextMutation: false,
    failNextMutation: false,
    legacySessionProtocol: false,
    pending: [],
  };
  return {
    state,
    arm(input) {
      for (const key of [
        "holdNextMutation",
        "holdNextMutationResponse",
        "holdNextReconcile",
        "dropNextMutationAfterCommit",
        "degradeNextMutation",
        "failNextMutation",
        "legacySessionProtocol",
      ]) {
        if (Object.hasOwn(input, key)) state[key] = input[key] === true;
      }
    },
    hold(kind, resume, response) {
      const entry = { kind, resume };
      state.pending.push(entry);
      response?.once("close", () => {
        if (response.writableEnded) return;
        const index = state.pending.indexOf(entry);
        if (index >= 0) state.pending.splice(index, 1);
      });
    },
    release(kind = "all") {
      const index = state.pending.findIndex((entry) => kind === "all" || entry.kind === kind);
      if (index < 0) return false;
      const [entry] = state.pending.splice(index, 1);
      entry.resume();
      return true;
    },
    releaseAll() {
      while (this.release("all")) {}
    },
    snapshot() {
      return {
        holdNextMutation: state.holdNextMutation,
        holdNextMutationResponse: state.holdNextMutationResponse,
        holdNextReconcile: state.holdNextReconcile,
        dropNextMutationAfterCommit: state.dropNextMutationAfterCommit,
        degradeNextMutation: state.degradeNextMutation,
        failNextMutation: state.failNextMutation,
        legacySessionProtocol: state.legacySessionProtocol,
        pending: state.pending.map((entry) => entry.kind),
        lastMutation: state.lastMutation || null,
      };
    },
    recordMutation(value) {
      state.lastMutation = value;
    },
  };
}

async function proxyRequest({ request, response, url, innerPort, controls }) {
  const isMutation = request.method === "POST" && SETTINGS_PATH.test(url.pathname);
  const isReconcile = request.method === "GET" && SETTINGS_PATH.test(url.pathname);
  const body = await readRequestBody(request);
  const execute = async () => {
    if (isMutation && controls.state.failNextMutation) {
      controls.state.failNextMutation = false;
      sendJson(response, 400, {
        error: "INVALID_PROFILE_SETTINGS",
        transactionId: request.headers["x-xjskp-settings-transaction-id"],
        commitState: "not-applied",
      });
      return;
    }
    if (isMutation && controls.state.degradeNextMutation) {
      controls.state.degradeNextMutation = false;
      sendJson(response, 503, {
        error: "PROFILE_SETTINGS_RUNTIME_DEGRADED",
        transactionId: request.headers["x-xjskp-settings-transaction-id"],
        commitState: "not-applied",
        runtimeSyncStatus: "degraded",
      });
      return;
    }
    await forwardToInner({
      request,
      response,
      url,
      body,
      innerPort,
      holdResponse: isMutation && consumeFlag(controls.state, "holdNextMutationResponse"),
      dropResponse: isMutation && consumeFlag(controls.state, "dropNextMutationAfterCommit"),
      controls,
    });
  };
  if (isMutation && consumeFlag(controls.state, "holdNextMutation")) {
    controls.hold("mutation", () => execute().catch((error) => response.destroy(error)), response);
    return;
  }
  if (isReconcile && consumeFlag(controls.state, "holdNextReconcile")) {
    controls.hold("reconcile", () => execute().catch((error) => response.destroy(error)), response);
    return;
  }
  await execute();
}

function forwardToInner({ request, response, url, body, innerPort, holdResponse, dropResponse, controls }) {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, host: `127.0.0.1:${innerPort}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${innerPort}`;
    if (headers.referer) headers.referer = `http://127.0.0.1:${innerPort}/`;
    const forwarded = http.request({
      host: "127.0.0.1",
      port: innerPort,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
    }, (innerResponse) => {
      const chunks = [];
      innerResponse.on("data", (chunk) => chunks.push(chunk));
      innerResponse.on("end", () => {
        let outputBody = Buffer.concat(chunks);
        if (request.method === "GET" && url.pathname === "/api/session" && controls.state.legacySessionProtocol) {
          const session = parseJson(outputBody) || {};
          delete session.settingsProtocolVersion;
          outputBody = Buffer.from(JSON.stringify(session));
        }
        if (request.method === "POST" && SETTINGS_PATH.test(url.pathname)) {
          const responseBody = parseJson(outputBody);
          controls.recordMutation({
            statusCode: innerResponse.statusCode || 0,
            error: responseBody?.error || null,
            commitState: responseBody?.commitState || null,
            transactionCorrelated: responseBody?.transactionId === request.headers["x-xjskp-settings-transaction-id"],
          });
        }
        const finish = () => {
          if (dropResponse) {
            const responseHeaders = { ...innerResponse.headers };
            delete responseHeaders.connection;
            responseHeaders["content-length"] = 1;
            response.writeHead(innerResponse.statusCode || 200, responseHeaders);
            response.end("{");
            resolve();
            return;
          }
          const responseHeaders = { ...innerResponse.headers };
          delete responseHeaders.connection;
          delete responseHeaders["transfer-encoding"];
          responseHeaders["content-length"] = outputBody.length;
          response.writeHead(innerResponse.statusCode || 502, responseHeaders);
          response.end(outputBody);
          resolve();
        };
        if (holdResponse) {
          controls.hold("mutation-response", finish, response);
        } else {
          finish();
        }
      });
    });
    forwarded.on("error", reject);
    if (body.length) forwarded.write(body);
    forwarded.end();
  });
}

async function handleControl({ request, response, url, controls, controlToken, sessionToken, close }) {
  if (
    request.headers["x-t6-control-token"] !== controlToken
    && request.headers["x-xjskp-session-token"] !== sessionToken
  ) {
    sendJson(response, 403, { error: "T6_CONTROL_TOKEN_INVALID" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__t6/status") {
    sendJson(response, 200, controls.snapshot());
    return;
  }
  const body = request.method === "POST" ? JSON.parse((await readRequestBody(request)).toString("utf8") || "{}") : {};
  if (request.method === "POST" && url.pathname === "/__t6/arm") {
    controls.arm(body);
    sendJson(response, 200, controls.snapshot());
    return;
  }
  if (request.method === "POST" && url.pathname === "/__t6/release") {
    sendJson(response, 200, { released: controls.release(body.kind || "all"), ...controls.snapshot() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__t6/shutdown") {
    sendJson(response, 200, { closing: true });
    setTimeout(() => close().catch((error) => console.error(error)), 0);
    return;
  }
  sendJson(response, 404, { error: "T6_CONTROL_NOT_FOUND" });
}

function sendLegacyPage(response) {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>T6 legacy settings client</title>
<button id="legacyMutationButton">旧页面保存设置</button>
<p id="legacyMutationStatus">尚未发送</p>
<script>
document.querySelector("#legacyMutationButton").addEventListener("click", async () => {
  const session = await fetch("/api/session").then((value) => value.json());
  const result = await fetch("/api/profiles/p1/settings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": session.token,
    },
    body: JSON.stringify({ autoReceiveWaterwheelBuckets: true }),
  });
  const body = await result.json();
  document.querySelector("#legacyMutationStatus").textContent = result.status + " " + (body.refreshHint || body.message || body.error || "");
});
</script>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  response.end(html);
}

async function seedProfiles(profileStore) {
  const credentials = (id) => ({
    CTOKEN: `fixture-${id}`,
    PC_USER_ID: id,
    PC_TOKEN: `fixture-${id}`,
    BABI_TOKEN: `fixture-${id}`,
    OPEN_ID: `fixture-${id}`,
  });
  await profileStore.importProfile({
    id: "p1",
    label: "T6 虚拟账号 A",
    credentials: credentials("p1"),
    settings: {
      experienceGuardThresholdPercent: 0.5,
      teamOrderGuardMultiplier: 1,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
    },
  });
  await profileStore.importProfile({
    id: "p2",
    label: "T6 虚拟账号 B",
    credentials: credentials("p2"),
    settings: {
      experienceGuardThresholdPercent: 0.7,
      teamOrderGuardMultiplier: 1,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:40",
    },
  });
}

function consumeFlag(state, key) {
  if (!state[key]) return false;
  state[key] = false;
  return true;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("T6 fixture request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function assertSafeTempRoot(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("T6 fixture root must be a dedicated child of the system TEMP directory");
  }
  if (!path.basename(resolved).startsWith("xjskp-t6-profile-settings-")) {
    throw new Error("T6 fixture root has an unexpected name");
  }
}

async function runCli() {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const readyArg = process.argv.find((arg) => arg.startsWith("--ready-file="));
  const fixture = await startT6ProfileSettingsVisibleServer({
    port: portArg ? Number(portArg.slice("--port=".length)) : 0,
  });
  const ready = {
    url: fixture.url,
    port: fixture.port,
    tempRoot: fixture.tempRoot,
    controlToken: fixture.controlToken,
  };
  if (readyArg) {
    await fs.writeFile(readyArg.slice("--ready-file=".length), `${JSON.stringify(ready)}\n`, "utf8");
  }
  console.log(`T6_READY url=${fixture.url} profiles=2 workers=0 gameCalls=0`);
  console.log("仅用于 T6 设置并发验收；Ctrl+C 可安全关闭并清理临时目录。");
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      await fixture.close();
      console.log("T6_CLEANUP complete=true workers=0 gameCalls=0");
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.once(signal, () => stop(signal));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
