import { formatDuration } from "./status-format.mjs";

export function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mdCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatMaturitySeconds(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "-";
  return formatDuration(Number(seconds) * 1000);
}

export function formatPlainSeconds(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "-";
  const value = Number(seconds);
  if (value <= 0) return "0秒";
  return formatDuration(value * 1000);
}

