const DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER = 2;
const MAX_TEAM_ORDER_GUARD_MULTIPLIER = 10;

export function parseTeamOrderGuardMultiplierInput(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const multiplier = Number(text);
  return Number.isFinite(multiplier)
    && multiplier >= 0
    && multiplier <= MAX_TEAM_ORDER_GUARD_MULTIPLIER
    ? multiplier
    : null;
}

export function formatTeamOrderGuardMultiplier(value) {
  if (value === null || value === undefined || value === "") {
    return String(DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER);
  }
  const multiplier = Number(value);
  return Number.isFinite(multiplier)
    && multiplier >= 0
    && multiplier <= MAX_TEAM_ORDER_GUARD_MULTIPLIER
    ? String(multiplier)
    : String(DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER);
}

export function computeTeamOrderGuardExp(historyMaxExp, multiplier) {
  if (historyMaxExp === null || historyMaxExp === undefined) return null;
  const history = Number(historyMaxExp);
  if (!Number.isFinite(history)) return null;
  let effectiveMultiplier = DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER;
  if (multiplier !== null && multiplier !== undefined && multiplier !== "") {
    const configured = Number(multiplier);
    if (Number.isFinite(configured)
      && configured >= 0
      && configured <= MAX_TEAM_ORDER_GUARD_MULTIPLIER) {
      effectiveMultiplier = configured;
    }
  }
  return history * effectiveMultiplier;
}

export const TEAM_ORDER_VISIBLE_DAY_COUNT = 7;

export function getRecentTeamOrderCutoffMs(
  now = new Date(),
  dayCount = TEAM_ORDER_VISIBLE_DAY_COUNT,
) {
  const current = validDate(now);
  if (!current) return Number.NaN;
  const days = Math.max(1, Math.trunc(Number(dayCount) || TEAM_ORDER_VISIBLE_DAY_COUNT));
  const cutoff = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  );
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff.getTime();
}

export function getRecentCompletedTeamOrderGroups(
  items,
  {
    now = new Date(),
    dayCount = TEAM_ORDER_VISIBLE_DAY_COUNT,
  } = {},
) {
  const current = validDate(now);
  if (!current) return [];
  const cutoffMs = getRecentTeamOrderCutoffMs(current, dayCount);
  const nowMs = current.getTime();
  const completed = (Array.isArray(items) ? items : [])
    .filter((item) => item?.readError !== true)
    .map((item) => ({
      item,
      finishedDate: validDate(item?.finishedAt),
    }))
    .filter(({ finishedDate }) => (
      finishedDate
      && finishedDate.getTime() >= cutoffMs
      && finishedDate.getTime() <= nowMs
    ))
    .sort((left, right) => right.finishedDate.getTime() - left.finishedDate.getTime());

  const groups = [];
  for (const entry of completed) {
    const dateLabel = localDateLabel(entry.finishedDate);
    let group = groups.at(-1);
    if (!group || group.dateLabel !== dateLabel) {
      group = { dateLabel, items: [] };
      groups.push(group);
    }
    group.items.push(entry.item);
  }
  for (const group of groups) {
    group.items.reverse();
  }
  return groups;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localDateLabel(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}
