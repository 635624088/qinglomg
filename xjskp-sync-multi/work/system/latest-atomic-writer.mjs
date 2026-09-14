import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);

export function createLatestAtomicWriter({
  fs = fsp,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = delay,
  now = Date.now,
  random = Math.random,
  onError = () => {},
} = {}) {
  const states = new Map();
  const delays = normalizeRetryDelays(retryDelaysMs);
  const completedResults = [];

  function enqueue(filePath, content, options = {}) {
    const key = path.resolve(String(filePath));
    const state = states.get(key) || {
      filePath: key,
      pending: null,
      running: null,
      lastCommittedFingerprint: null,
    };
    if (state.pending) {
      settle(state.pending.ticket, {
        path: key,
        status: "superseded",
        attempts: 0,
        replaced: false,
        replacedBy: options.replacedBy ?? replacementLabel(content),
      });
    }
    const ticket = createTicket(key);
    state.pending = {
      content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content)),
      fingerprint: options.fingerprint ?? null,
      ticket,
    };
    states.set(key, state);
    ensureDrain(state);
    return ticket.promise;
  }

  function ensureDrain(state) {
    if (state.running) return state.running;
    state.running = drain(state).finally(() => {
      state.running = null;
      if (state.pending) ensureDrain(state);
    });
    return state.running;
  }

  async function drain(state) {
    while (state.pending) {
      const { content, fingerprint, ticket } = state.pending;
      state.pending = null;
      try {
        const writeResult = await writeAtomic(state.filePath, content, {
          fs,
          delays,
          wait,
          now,
          random,
          fingerprint,
          state,
        });
        if (fingerprint !== null) state.lastCommittedFingerprint = fingerprint;
        settle(ticket, {
          path: state.filePath,
          status: "committed",
          attempts: writeResult.attempts,
          replaced: writeResult.replaced,
        });
      } catch (error) {
        const status = error?.commitStatus === "unknown"
          || error?.writeOutcome === "unknown"
          || error?.outcome === "unknown"
          ? "unknown"
          : "failed";
        const result = {
          path: state.filePath,
          status,
          attempts: error?.attempts || 1,
          replaced: false,
        };
        settle(ticket, result);
        try {
          onError({
            ...result,
            code: error?.code || null,
            message: error?.message || String(error),
          });
        } catch {}
      }
    }
  }

  async function flush() {
    while (true) {
      for (const state of states.values()) {
        if (state.pending && !state.running) ensureDrain(state);
      }
      const running = Array.from(states.values()).map((state) => state.running).filter(Boolean);
      if (!running.length) return completedResults.splice(0, completedResults.length);
      await Promise.allSettled(running);
    }
  }

  function createTicket(filePath) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { filePath, promise, resolve, settled: false };
  }

  function settle(ticket, result) {
    if (!ticket || ticket.settled) return;
    ticket.settled = true;
    completedResults.push(result);
    ticket.resolve(result);
  }

  return { enqueue, flush };
}

async function writeAtomic(filePath, content, {
  fs,
  delays,
  wait,
  now,
  random,
  fingerprint,
  state,
}) {
  if (fingerprint !== null && state.lastCommittedFingerprint === fingerprint) {
    return { attempts: 0, replaced: false };
  }
  if (typeof fs.readFile === "function") {
    try {
      const existing = await fs.readFile(filePath);
      const existingBuffer = Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing));
      if (Buffer.compare(existingBuffer, content) === 0) {
        return { attempts: 0, replaced: false };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        error.commitStatus = error.commitStatus || "unknown";
        throw error;
      }
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Number(now())}.${Math.floor(Number(random()) * 0x1_0000_0000).toString(16)}.tmp`;
  let renamed = false;
  let attempts = 0;
  try {
    await fs.writeFile(tmpPath, content);
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0 && delays[index] > 0) await wait(delays[index]);
      attempts += 1;
      try {
        await fs.rename(tmpPath, filePath);
        renamed = true;
        return { attempts, replaced: true };
      } catch (error) {
        if (error?.commitStatus === "unknown" || error?.writeOutcome === "unknown" || error?.outcome === "unknown") {
          error.attempts = attempts;
          throw error;
        }
        if (!TRANSIENT_RENAME_CODES.has(error?.code) || index === delays.length - 1) {
          error.attempts = attempts;
          throw error;
        }
      }
    }
  } finally {
    if (!renamed) await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

function normalizeRetryDelays(values) {
  const normalized = Array.isArray(values)
    ? values.map((value) => Math.max(0, Number(value) || 0))
    : [];
  return normalized.length ? normalized : [0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replacementLabel(content) {
  return Buffer.from(content).toString("utf8");
}
