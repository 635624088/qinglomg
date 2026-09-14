export function parseAutomationProgressLine(line, now = () => new Date()) {
  const text = String(line || "").trim();
  if (!text || !text.startsWith("{")) return null;
  try {
    const payload = JSON.parse(text);
    const step = String(payload?.step || "").trim();
    if (!step) return null;
    if (payload.warn || payload.error || payload.err) return null;
    if (/(?:error|failed|failure)$/i.test(step)) return null;
    const timestamp = payload.readyAt || payload.at || now().toISOString();
    return {
      step,
      ...(payload.cycle != null ? { cycle: payload.cycle } : {}),
      at: timestamp,
    };
  } catch {
    return null;
  }
}
