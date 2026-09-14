export function buildProfileStatusProjection({ gardenStatus, orderStatus }) {
  const garden = gardenStatus?.ok ? gardenStatus.data : null;
  const order = orderStatus?.ok ? orderStatus.data : null;
  return {
    garden: garden ? projectGardenStatus(garden) : null,
    order: order ? projectOrderStatus(order) : null,
  };
}

function projectGardenStatus(garden) {
  const summary = garden.summary || {};
  return {
    summary: {
      doubleGoldRemainingText: summary.doubleGoldRemainingText || "-",
      waterDropNeedText: summary.waterDropNeedText || "",
      accountLevel: summary.accountLevel || null,
      automationStopped: summary.automationStopped || null,
      experienceGuard: summary.experienceGuard || null,
    },
    waterwheel: garden.waterwheel || null,
    flowerRack: garden.flowerRack || null,
    specialOrders: garden.specialOrders || null,
    customerOrders: garden.customerOrders || null,
    ordinaryResidentOrders: garden.ordinaryResidentOrders || null,
    cyclicStory: garden.cyclicStory || null,
    cyclicNote: garden.cyclicNote || null,
    mainTaskStatus: garden.mainTaskStatus || null,
    mainTasks: garden.mainTasks || null,
    accountLevel: garden.accountLevel || null,
    experienceGuard: garden.experienceGuard || null,
  };
}

function projectOrderStatus(order) {
  return {
    residentBoard: order.residentBoard || null,
  };
}
