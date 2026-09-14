const STATUS_COPY = {
  "missing-order": "未生成/未开启",
  ready: "可完成",
  cooldown: "冷却中",
  "missing-items": "缺少材料",
  "daily-limit": "已达上限",
  video: "视频订单",
  "server-confirmed-out-of-stock": "服务端确认缺货",
};

export function buildSpecialOrderCategoryView(order = {}) {
  const state = order?.exists === false
    ? "missing-order"
    : cleanText(order?.status) || "unknown";
  const status = formatStatus(order, state);
  const missing = state === "server-confirmed-out-of-stock"
    ? formatRejectedItem(order)
    : formatExactMissingItems(order?.requirements);
  return { state, status, missing };
}

function formatStatus(order, state) {
  if (state === "missing-order") return STATUS_COPY[state];
  const base = cleanText(order?.statusText) || STATUS_COPY[state] || "状态异常";
  const remaining = cleanText(order?.remainingText);
  if (state === "cooldown" && remaining && remaining !== "-") {
    return `${base}（${remaining}）`;
  }
  return base;
}

function formatExactMissingItems(requirements) {
  const items = (Array.isArray(requirements) ? requirements : [])
    .filter((item) => Number(item?.missing) > 0)
    .map((item) => `${itemName(item)}(${displayNumber(item?.need)}/${displayNumber(item?.have)})`);
  return items.length > 0 ? items.join("、") : "无";
}

function formatRejectedItem(order) {
  const rejection = order?.stockRejection || {};
  const itemId = Number(rejection?.itemId);
  const requirement = (Array.isArray(order?.requirements) ? order.requirements : [])
    .find((item) => Number(item?.itemId) === itemId);
  if (!requirement && !itemId) return "缺货明细待同步";
  const item = requirement || { itemId };
  const need = rejection?.need ?? item?.need;
  const observedHave = rejection?.observedHave ?? item?.have;
  if (rejection?.exactHaveKnown === true) {
    return `${itemName(item)}(${displayNumber(need)}/${displayNumber(observedHave)})`;
  }
  return `${itemName(item)}(需${displayNumber(need)}/本地可见${displayNumber(observedHave)}，非精确)`;
}

function itemName(item) {
  return cleanText(item?.name)
    || cleanText(item?.label)
    || `花朵${displayNumber(item?.itemId)}`;
}

function displayNumber(value) {
  return value === null || value === undefined || value === "" ? "未知" : String(value);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
