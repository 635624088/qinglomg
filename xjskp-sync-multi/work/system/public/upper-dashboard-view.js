import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";

const WIZARD_BADGE_STATES = ["neutral", "missing", "invalid", "ready", "legacy-found"];
const WIZARD_COPY_STATES = [
  "loading",
  "missing",
  "invalid",
  "ready-validated",
  "ready-unvalidated",
  "legacy-found",
  "profile-missing",
  "legacy-incomplete",
];
const RISK_STATES = ["ok", "warn", "danger"];

export function createUpperDashboardRenderer(getNode) {
  const nodes = cacheNodes(getNode);
  return {
    renderRuntime(view) {
      setTextIfChanged(nodes.servicePort, view.servicePort);
      setTextIfChanged(nodes.servicePid, view.servicePid);
      setTextIfChanged(nodes.refreshTime, view.refreshTime);
      setTextIfChanged(nodes.lockState, view.lockState);
    },
    renderGameVersion(view) {
      setAttributeIfChanged(nodes.gameVersionMeta, "data-state", view.code.state);
      setAttributeIfChanged(nodes.gameVersionMeta, "title", view.code.title);
      setTextIfChanged(nodes.localGameVersion, view.code.localVersion);
      setTextIfChanged(nodes.remoteGameVersion, view.code.officialVersion);
      setTextIfChanged(nodes.gameCodeReviewState, view.code.statusText);
      setAttributeIfChanged(nodes.gameDataVersionMeta, "data-state", view.data.state);
      setAttributeIfChanged(nodes.gameDataVersionMeta, "title", view.data.title);
      setTextIfChanged(nodes.activeGameDataVersion, view.data.activeVersion);
      setTextIfChanged(nodes.activeGameDataSourceCodeVersion, view.data.sourceCodeVersion);
      setTextIfChanged(nodes.gameDataSyncState, view.data.statusText);
      setBooleanPropertyIfChanged(nodes.checkGameVersionButton, "disabled", view.checkButton.disabled);
      setTextIfChanged(nodes.checkGameVersionButton, view.checkButton.text);
      setAttributeIfChanged(nodes.checkGameVersionButton, "title", view.checkButton.title);
      setBooleanPropertyIfChanged(nodes.syncGameDataButton, "disabled", view.syncButton.disabled);
      setTextIfChanged(nodes.syncGameDataButton, view.syncButton.text);
      setAttributeIfChanged(nodes.syncGameDataButton, "title", view.syncButton.title);
      setBooleanPropertyIfChanged(nodes.gameDataSyncFeedback, "hidden", !view.feedback.visible);
      setAttributeIfChanged(nodes.gameDataSyncFeedback, "data-state", view.feedback.state);
      setTextIfChanged(nodes.gameDataSyncFeedback, view.feedback.text);
    },
    renderLegacyShell(view) {
      setBooleanPropertyIfChanged(nodes.legacyBanner, "hidden", !view.visible);
    },
    renderProfileCount(view) {
      setTextIfChanged(nodes.profileCountValue, view.value);
    },
    renderWizard(view) {
      setAttributeIfChanged(nodes.wizardPanel, "data-state", view.state);
      setTextIfChanged(nodes.wizardBadge, view.badgeText);
      patchExclusiveClass(nodes.wizardBadge, WIZARD_BADGE_STATES, view.badgeState);
      setTextIfChanged(nodes.wizardTitle, view.title);
      patchWizardCopy(nodes, view.copyState);
      setTextIfChanged(nodes.wizardValidationError, view.validationError);
      setTextIfChanged(nodes.wizardValidatedAt, view.validatedAt);
      setTextIfChanged(nodes.wizardMigrationProfileId, view.migrationProfileId);
      setBooleanPropertyIfChanged(nodes.wizardMissing, "hidden", !view.missingVisible);
      setBooleanPropertyIfChanged(nodes.migrateLegacyButton, "disabled", view.migrateDisabled);
      setBooleanPropertyIfChanged(nodes.validateProfileButton, "disabled", view.validateDisabled);
      toggleClassIfChanged(nodes.openImportButton, "primary", view.importPrimary);
    },
    renderTask(view) {
      setTextIfChanged(nodes.selectedProfileLabel, view.profileName);
      setBooleanPropertyIfChanged(nodes.selectedProfileIdWrap, "hidden", !view.hasProfile);
      setTextIfChanged(nodes.selectedProfileIdValue, view.profileId);
      setTextIfChanged(nodes.taskMode, view.mode);
      setTextIfChanged(nodes.taskPid, view.pid);
      setTextIfChanged(nodes.taskStartedAt, view.startedAt);
      setTextIfChanged(nodes.nextRunText, view.doubleGoldRemaining);
      setBooleanPropertyIfChanged(nodes.startButton, "disabled", view.startDisabled);
      setBooleanPropertyIfChanged(nodes.onceButton, "disabled", view.onceDisabled);
      setBooleanPropertyIfChanged(nodes.ordersButton, "disabled", view.ordersDisabled);
      setBooleanPropertyIfChanged(nodes.stopButton, "disabled", view.stopDisabled);
      setBooleanPropertyIfChanged(nodes.resetCredentialsButton, "disabled", view.resetDisabled);
    },
    renderSummary(view) {
      setTextIfChanged(nodes.statusAgeLabel, view.statusLabel);
      setTextIfChanged(nodes.statusAgeValue, view.statusValue);
      setTextIfChanged(nodes.landTotal, view.landTotal);
      setTextIfChanged(nodes.landEmpty, view.landEmpty);
      setTextIfChanged(nodes.landGrowing, view.landGrowing);
      setTextIfChanged(nodes.landMature, view.landMature);
      setTextIfChanged(nodes.nextMatureText, view.nextMature);
      setTextIfChanged(nodes.waterDropText, view.waterDrop);
      setTextIfChanged(nodes.waterNextText, view.waterNext);
      setTextIfChanged(nodes.waterNeedText, view.waterNeed);
      patchResources(nodes, view.resources);
      patchRisk(nodes.riskErrorsMetric, nodes.riskErrorsValue, view.risks.errors);
      patchRisk(nodes.riskStatusMetric, nodes.riskStatusValue, view.risks.status);
      patchRisk(nodes.riskLoginMetric, nodes.riskLoginValue, view.risks.login);
      patchRisk(nodes.riskCredentialsMetric, nodes.riskCredentialsValue, view.risks.credentials);
    },
    renderAccountLevel(view) {
      setTextIfChanged(nodes.accountServerSummaryValue, view.server);
      setTextIfChanged(nodes.accountLevelValueSummaryValue, view.level);
      setTextIfChanged(nodes.accountExperienceSummaryValue, view.experience);
    },
    renderArtifacts(view) {
      setBooleanPropertyIfChanged(nodes.artifactLinks, "hidden", !view.visible);
      setAttributeIfChanged(nodes.artifactStatusPageLink, "href", view.statusPageHref);
      setAttributeIfChanged(nodes.artifactStatusJsonLink, "href", view.statusJsonHref);
      setAttributeIfChanged(nodes.artifactOrderJsonLink, "href", view.orderJsonHref);
    },
  };
}

function cacheNodes(getNode) {
  const ids = [
    "servicePort", "servicePid", "refreshTime", "lockState",
    "gameVersionMeta", "localGameVersion", "remoteGameVersion", "gameCodeReviewState",
    "gameDataVersionMeta", "activeGameDataVersion", "activeGameDataSourceCodeVersion", "gameDataSyncState",
    "checkGameVersionButton", "syncGameDataButton", "gameDataSyncFeedback",
    "legacyBanner", "profileCountValue", "wizardPanel", "wizardBadge", "wizardTitle",
    "wizardValidationError", "wizardValidatedAt", "wizardMigrationProfileId", "wizardMissing",
    "migrateLegacyButton", "validateProfileButton", "openImportButton",
    "selectedProfileLabel", "selectedProfileIdWrap", "selectedProfileIdValue",
    "taskMode", "taskPid", "taskStartedAt", "nextRunText",
    "startButton", "onceButton", "ordersButton", "stopButton", "resetCredentialsButton",
    "statusAgeLabel", "statusAgeValue", "landTotal", "landEmpty", "landGrowing", "landMature",
    "nextMatureText", "waterDropText", "waterNextText", "waterNeedText",
    "resourceGoldValue", "resourcePearlValue", "resourceFlowerShopCoinValue",
    "resourceSatinSilkValue", "resourceBuildingMaterialValue", "resourceYuanbaoValue",
    "resourceHireItemCountValue", "riskErrorsMetric", "riskErrorsValue",
    "riskStatusMetric", "riskStatusValue", "riskLoginMetric", "riskLoginValue",
    "riskCredentialsMetric", "riskCredentialsValue", "accountServerSummaryValue",
    "accountLevelValueSummaryValue", "accountExperienceSummaryValue", "artifactLinks",
    "artifactStatusPageLink", "artifactStatusJsonLink", "artifactOrderJsonLink",
    ...WIZARD_COPY_STATES.map((state) => wizardCopyId(state)),
  ];
  return Object.fromEntries(ids.map((id) => [id, getNode(id)]));
}

function patchWizardCopy(nodes, activeState) {
  for (const state of WIZARD_COPY_STATES) {
    setBooleanPropertyIfChanged(nodes[wizardCopyId(state)], "hidden", state !== activeState);
  }
}

function patchResources(nodes, resources) {
  setTextIfChanged(nodes.resourceGoldValue, resources.gold);
  setTextIfChanged(nodes.resourcePearlValue, resources.pearl);
  setTextIfChanged(nodes.resourceFlowerShopCoinValue, resources.flowerShopCoin);
  setTextIfChanged(nodes.resourceSatinSilkValue, resources.satinSilk);
  setTextIfChanged(nodes.resourceBuildingMaterialValue, resources.buildingMaterial);
  setTextIfChanged(nodes.resourceYuanbaoValue, resources.yuanbao);
  setTextIfChanged(nodes.resourceHireItemCountValue, resources.hireItemCount);
}

function patchRisk(metricNode, valueNode, risk) {
  setTextIfChanged(valueNode, risk.value);
  patchExclusiveClass(metricNode, RISK_STATES, risk.state);
}

function patchExclusiveClass(node, classNames, activeClass) {
  for (const className of classNames) {
    toggleClassIfChanged(node, className, className === activeClass);
  }
}

function wizardCopyId(state) {
  return `wizardCopy${state.split("-").map(capitalize).join("")}`;
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
