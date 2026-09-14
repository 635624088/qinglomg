import test from "node:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_PROFILE_SETTINGS,
  PROFILE_SETTING_INPUT_KEYS,
  createProfileStore,
  mergeProfileSettings,
  normalizeProfileSettings,
} from "./system/profile-store.mjs";

test("cyclic-note parent defaults off while retaining the legacy highest-reward child", () => {
  const normalized = normalizeProfileSettings({
    autoCompleteCyclicNoteHighestRewardTask: true,
  });
  assert.equal(normalized.autoHandleCyclicNote, false);
  assert.equal(normalized.autoCompleteCyclicNoteHighestRewardTask, true);
  assert.equal(
    mergeProfileSettings(normalized, { autoHandleCyclicNote: true }).autoHandleCyclicNote,
    true,
  );
  assert.throws(
    () => mergeProfileSettings({}, { autoHandleCyclicNote: "true" }),
    (error) => error?.code === "INVALID_PROFILE_SETTINGS",
  );
});

test("customer order reward release mask defaults to 4 and accepts only a 0..7 safe integer", () => {
  assert.equal(DEFAULT_PROFILE_SETTINGS.customerOrderFlowerCurrencyRewardReleaseMask, 4);
  assert.equal(
    normalizeProfileSettings({}).customerOrderFlowerCurrencyRewardReleaseMask,
    4,
  );
  for (const value of [0, 1, 4, 5, 7]) {
    assert.equal(
      mergeProfileSettings({}, {
        customerOrderFlowerCurrencyRewardReleaseMask: value,
      }).customerOrderFlowerCurrencyRewardReleaseMask,
      value,
    );
  }
  for (const value of [-1, 8, 1.5, "4", true, null]) {
    assert.throws(
      () => mergeProfileSettings({}, {
        customerOrderFlowerCurrencyRewardReleaseMask: value,
      }),
      (error) => error?.code === "INVALID_PROFILE_SETTINGS",
    );
  }
});

test("profile settings normalize waterwheel bucket switches with compatible defaults", () => {
  assert.deepEqual(
    {
      autoReceiveWaterwheelBuckets:
        normalizeProfileSettings({}).autoReceiveWaterwheelBuckets,
      skipWaterwheelVideoBuckets:
        normalizeProfileSettings({}).skipWaterwheelVideoBuckets,
    },
    {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
    },
  );
  assert.equal(
    normalizeProfileSettings({ autoReceiveWaterwheelBuckets: false })
      .autoReceiveWaterwheelBuckets,
    false,
  );
  assert.equal(
    normalizeProfileSettings({ skipWaterwheelVideoBuckets: true })
      .skipWaterwheelVideoBuckets,
    true,
  );
  assert.equal(
    normalizeProfileSettings({ autoReceiveWaterwheelBuckets: "false" })
      .autoReceiveWaterwheelBuckets,
    true,
  );
  assert.equal(
    normalizeProfileSettings({ skipWaterwheelVideoBuckets: "true" })
      .skipWaterwheelVideoBuckets,
    false,
  );
});

test("profile settings accept only boolean waterwheel bucket switches", () => {
  for (const key of [
    "autoReceiveWaterwheelBuckets",
    "skipWaterwheelVideoBuckets",
  ]) {
    assert.equal(PROFILE_SETTING_INPUT_KEYS.includes(key), true);
    for (const value of [true, false]) {
      assert.equal(mergeProfileSettings({}, { [key]: value })[key], value);
    }
    for (const value of ["true", "false", 1, 0, null]) {
      assert.throws(
        () => mergeProfileSettings({}, { [key]: value }),
        (error) => (
          error?.code === "INVALID_PROFILE_SETTINGS"
          && error?.statusCode === 400
        ),
      );
    }
  }
});

test("profile store persists waterwheel bucket switches per account", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    await fixture.store.importProfile(makeCredentialProfile("alt"));

    await fixture.store.updateProfileSettings("main", {
      autoReceiveWaterwheelBuckets: false,
      skipWaterwheelVideoBuckets: true,
    });

    assert.deepEqual(
      {
        autoReceiveWaterwheelBuckets:
          (await fixture.store.getProfileSettings("main"))
            .autoReceiveWaterwheelBuckets,
        skipWaterwheelVideoBuckets:
          (await fixture.store.getProfileSettings("main"))
            .skipWaterwheelVideoBuckets,
      },
      {
        autoReceiveWaterwheelBuckets: false,
        skipWaterwheelVideoBuckets: true,
      },
    );
    assert.deepEqual(
      {
        autoReceiveWaterwheelBuckets:
          (await fixture.store.getProfileSettings("alt"))
            .autoReceiveWaterwheelBuckets,
        skipWaterwheelVideoBuckets:
          (await fixture.store.getProfileSettings("alt"))
            .skipWaterwheelVideoBuckets,
      },
      {
        autoReceiveWaterwheelBuckets: true,
        skipWaterwheelVideoBuckets: false,
      },
    );
  } finally {
    await fixture.close();
  }
});

test("profile settings default pearl hire item reserve to one hundred", () => {
  assert.equal(normalizeProfileSettings({}).pearlHireItemReserveCount, 100);
});

test("profile settings validate a configurable experience guard threshold percentage", () => {
  assert.equal(normalizeProfileSettings({}).experienceGuardThresholdPercent, 0.5);
  assert.equal(
    PROFILE_SETTING_INPUT_KEYS.includes("experienceGuardThresholdPercent"),
    true,
  );
  for (const value of [0, 0.01, 0.37, 0.5, 1.25, 100.01]) {
    assert.equal(
      mergeProfileSettings({}, { experienceGuardThresholdPercent: value })
        .experienceGuardThresholdPercent,
      value,
    );
  }
  for (const value of [0.001, 0.009, 0.011, -1, NaN, Infinity, "0.5", null]) {
    assert.throws(
      () => mergeProfileSettings({}, { experienceGuardThresholdPercent: value }),
      (error) => (
        error?.code === "INVALID_PROFILE_SETTINGS"
        && error?.statusCode === 400
      ),
    );
    assert.equal(
      normalizeProfileSettings({ experienceGuardThresholdPercent: value })
        .experienceGuardThresholdPercent,
      0.5,
    );
  }
});

test("profile settings validate a configurable team-order guard multiplier", () => {
  assert.equal(normalizeProfileSettings({}).teamOrderGuardMultiplier, 2);
  assert.equal(
    PROFILE_SETTING_INPUT_KEYS.includes("teamOrderGuardMultiplier"),
    true,
  );
  for (const value of [0, 0.5, 1.5, 2, 2.25, 10]) {
    assert.equal(
      mergeProfileSettings({}, { teamOrderGuardMultiplier: value })
        .teamOrderGuardMultiplier,
      value,
    );
  }
  for (const value of [-1, 10.01, 1.234, "2", null, NaN, Infinity]) {
    assert.throws(
      () => mergeProfileSettings({}, { teamOrderGuardMultiplier: value }),
      (error) => (
        error?.code === "INVALID_PROFILE_SETTINGS"
        && error?.statusCode === 400
      ),
    );
    assert.equal(
      normalizeProfileSettings({ teamOrderGuardMultiplier: value })
        .teamOrderGuardMultiplier,
      2,
    );
  }
});

test("profile store persists experience guard threshold percentage per account", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    await fixture.store.importProfile(makeCredentialProfile("alt"));

    await fixture.store.updateProfileSettings("main", {
      experienceGuardThresholdPercent: 0.37,
    });

    assert.equal(
      (await fixture.store.getProfileSettings("main"))
        .experienceGuardThresholdPercent,
      0.37,
    );
    assert.equal(
      (await fixture.store.getProfileSettings("alt"))
        .experienceGuardThresholdPercent,
      0.5,
    );
  } finally {
    await fixture.close();
  }
});

test("profile store persists team-order guard multiplier per account", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    await fixture.store.importProfile(makeCredentialProfile("alt"));

    await fixture.store.updateProfileSettings("main", {
      teamOrderGuardMultiplier: 3,
    });

    assert.equal(
      (await fixture.store.getProfileSettings("main")).teamOrderGuardMultiplier,
      3,
    );
    assert.equal(
      (await fixture.store.getProfileSettings("alt")).teamOrderGuardMultiplier,
      2,
    );
  } finally {
    await fixture.close();
  }
});

test("profile settings keep material shop midnight refresh disabled with a validated start time", () => {
  const defaults = normalizeProfileSettings({});
  assert.equal(defaults.materialShopMidnightRefreshEnabled, false);
  assert.equal(defaults.materialShopRefreshWindowStart, "23:50");
  assert.equal(defaults.materialShopRefreshMaxCostYuanbao, 4);
  assert.equal(PROFILE_SETTING_INPUT_KEYS.includes("materialShopMidnightRefreshEnabled"), true);
  assert.equal(PROFILE_SETTING_INPUT_KEYS.includes("materialShopRefreshWindowStart"), true);
  assert.equal(PROFILE_SETTING_INPUT_KEYS.includes("materialShopRefreshMaxCostYuanbao"), true);

  const enabled = mergeProfileSettings({}, {
    materialShopMidnightRefreshEnabled: true,
    materialShopRefreshWindowStart: "23:40",
    materialShopRefreshMaxCostYuanbao: 16,
  });
  assert.equal(enabled.materialShopMidnightRefreshEnabled, true);
  assert.equal(enabled.materialShopRefreshWindowStart, "23:40");
  assert.equal(enabled.materialShopRefreshMaxCostYuanbao, 16);

  for (const value of [0, 1, 2, 4, 8, 12, 16]) {
    assert.equal(
      mergeProfileSettings({}, { materialShopRefreshMaxCostYuanbao: value })
        .materialShopRefreshMaxCostYuanbao,
      value,
    );
  }
  for (const value of [-1, 3, 15, 17, "8", null]) {
    assert.throws(
      () => mergeProfileSettings({}, { materialShopRefreshMaxCostYuanbao: value }),
      (err) => err.code === "INVALID_PROFILE_SETTINGS" && err.statusCode === 400,
    );
  }

  for (const value of ["24:00", "23:60", "7:30", "invalid", 2350]) {
    assert.throws(
      () => mergeProfileSettings({}, { materialShopRefreshWindowStart: value }),
      (err) => err.code === "INVALID_PROFILE_SETTINGS" && err.statusCode === 400,
    );
  }
  assert.throws(
    () => mergeProfileSettings({}, { materialShopMidnightRefreshEnabled: "true" }),
    (err) => err.code === "INVALID_PROFILE_SETTINGS" && err.statusCode === 400,
  );
});

test("profile settings default team-order trigger protection to enabled", () => {
  assert.equal(
    normalizeProfileSettings({}).teamOrderTriggerProtectionEnabled,
    true,
  );
});

test("profile settings persist only boolean team-order trigger protection values", () => {
  assert.equal(
    mergeProfileSettings({}, {
      teamOrderTriggerProtectionEnabled: false,
    }).teamOrderTriggerProtectionEnabled,
    false,
  );
  assert.throws(
    () => mergeProfileSettings({}, {
      teamOrderTriggerProtectionEnabled: "false",
    }),
    (err) => (
      err.code === "INVALID_PROFILE_SETTINGS"
      && err.statusCode === 400
    ),
  );
});

test("profile settings default team-order paid-renew protection to enabled", () => {
  assert.equal(
    normalizeProfileSettings({}).teamOrderPaidRenewProtectionEnabled,
    true,
  );
  assert.equal(
    PROFILE_SETTING_INPUT_KEYS.includes("teamOrderPaidRenewProtectionEnabled"),
    true,
  );
});

test("profile settings persist only boolean team-order paid-renew protection values", () => {
  assert.equal(
    mergeProfileSettings({}, {
      teamOrderPaidRenewProtectionEnabled: false,
    }).teamOrderPaidRenewProtectionEnabled,
    false,
  );
  assert.throws(
    () => mergeProfileSettings({}, {
      teamOrderPaidRenewProtectionEnabled: "false",
    }),
    (err) => (
      err.code === "INVALID_PROFILE_SETTINGS"
      && err.statusCode === 400
    ),
  );
});

test("profile store persists team-order paid-renew protection per account", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    await fixture.store.importProfile(makeCredentialProfile("alt"));

    await fixture.store.updateProfileSettings("main", {
      teamOrderPaidRenewProtectionEnabled: false,
    });

    assert.equal(
      (await fixture.store.getProfileSettings("main"))
        .teamOrderPaidRenewProtectionEnabled,
      false,
    );
    assert.equal(
      (await fixture.store.getProfileSettings("alt"))
        .teamOrderPaidRenewProtectionEnabled,
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("profile settings persist only boolean ordinary resident switches", () => {
  for (const key of [
    "autoSubmitOrdinaryResidentOrdersForLevelUp",
    "autoSubmitOrdinaryResidentOrders",
  ]) {
    assert.equal(
      mergeProfileSettings({}, { [key]: true })
        .autoSubmitOrdinaryResidentOrdersForLevelUp,
      true,
    );
    assert.throws(
      () => mergeProfileSettings({}, { [key]: "true" }),
      (err) => (
        err.code === "INVALID_PROFILE_SETTINGS"
        && err.statusCode === 400
      ),
    );
  }
});

test("profile settings persist boolean cyclic story auto submit switch", () => {
  assert.equal(
    mergeProfileSettings({}, { autoSubmitCyclicStoryOrders: true })
      .autoSubmitCyclicStoryOrders,
    true,
  );
  assert.equal(
    normalizeProfileSettings({}).autoSubmitCyclicStoryOrders,
    false,
  );
  assert.equal(
    PROFILE_SETTING_INPUT_KEYS.includes("autoSubmitCyclicStoryOrders"),
    true,
  );
  assert.throws(
    () => mergeProfileSettings({}, { autoSubmitCyclicStoryOrders: "true" }),
    (err) => (
      err.code === "INVALID_PROFILE_SETTINGS"
      && err.statusCode === 400
    ),
  );
});

test("ordinary resident switch keeps canonical precedence while exposing one total-switch value", () => {
  assert.equal(
    normalizeProfileSettings({ autoSubmitOrdinaryResidentOrders: true })
      .autoSubmitOrdinaryResidentOrdersForLevelUp,
    true,
  );
  assert.equal(
    normalizeProfileSettings({
      autoSubmitOrdinaryResidentOrdersForLevelUp: false,
      autoSubmitOrdinaryResidentOrders: true,
    }).autoSubmitOrdinaryResidentOrdersForLevelUp,
    false,
  );
  assert.equal(
    mergeProfileSettings({}, { autoSubmitOrdinaryResidentOrders: true })
      .autoSubmitOrdinaryResidentOrders,
    true,
  );
});

test("profile settings persist boolean cyclic story highest experience switch", () => {
  const key = "cyclicStoryOnlyHighestExperienceOrder";
  assert.equal(
    mergeProfileSettings({}, { [key]: true })[key],
    true,
  );
  assert.equal(normalizeProfileSettings({})[key], false);
  assert.equal(PROFILE_SETTING_INPUT_KEYS.includes(key), true);
  assert.throws(
    () => mergeProfileSettings({}, { [key]: "true" }),
    (err) => (
      err.code === "INVALID_PROFILE_SETTINGS"
      && err.statusCode === 400
    ),
  );
});

test("profile settings accept non-negative safe pearl hire item reserves", () => {
  for (const value of [0, 6, 20, 100, Number.MAX_SAFE_INTEGER]) {
    assert.equal(mergeProfileSettings({}, { pearlHireItemReserveCount: value }).pearlHireItemReserveCount, value);
  }
});

test("profile settings normalize only numeric non-negative safe pearl hire item reserves", () => {
  for (const value of [undefined, "20", 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeProfileSettings({ pearlHireItemReserveCount: value }).pearlHireItemReserveCount, 100);
  }
});

test("profile settings reject invalid pearl hire item reserves", () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "invalid"]) {
    assert.throws(
      () => mergeProfileSettings({}, { pearlHireItemReserveCount: value }),
      (err) => err.code === "INVALID_PROFILE_SETTINGS" && err.statusCode === 400,
    );
  }
});

test("legacy profile files normalize missing and invalid pearl reserves to one hundred", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("legacy"));
    const filePath = path.join(fixture.dir, "legacy.json");
    for (const value of [undefined, "20", 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const record = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
      if (value === undefined) delete record.settings.pearlHireItemReserveCount;
      else record.settings.pearlHireItemReserveCount = value;
      await fsPromises.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      assert.equal((await fixture.store.getProfileSettings("legacy")).pearlHireItemReserveCount, 100);
    }
  } finally {
    await fixture.close();
  }
});

test("profile store encrypts sensitive fields and lists profiles without secrets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profiles-"));
  const protectedValues = [];
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => {
        protectedValues.push(value);
        return `protected:${value}`;
      },
      unprotect: (value) => value.replace(/^protected:/, ""),
      now: () => new Date("2026-06-29T08:00:00.000Z"),
    });

    const profile = await store.importProfile({
      id: "main account!",
      label: "主号",
      credentials: {
        CTOKEN: "ctoken-1",
        PC_USER_ID: "2088123456789012",
        PC_TOKEN: "pc-token-1",
        BABI_TOKEN: "babi-token-1",
        OPEN_ID: "open-id-1",
      },
    });

    assert.equal(profile.id, "main-account");
    assert.equal(profile.label, "主号");
    assert.deepEqual(protectedValues.sort(), [
      "babi-token-1",
      "ctoken-1",
      "open-id-1",
      "pc-token-1",
    ].sort());

    const profiles = await store.listProfiles();
    assert.deepEqual(profiles, [
      {
        id: "main-account",
        label: "主号",
        pcUserId: "2088123456789012",
        settings: {
          autoReceiveWaterwheelBuckets: true,
          skipWaterwheelVideoBuckets: false,
          autoSubmitOrdinaryResidentOrdersForLevelUp: false,
          autoSubmitOrdinaryResidentOrders: false,
          autoSubmitCyclicStoryOrders: false,
          autoHandleCyclicNote: false,
          autoCompleteCyclicNoteHighestRewardTask: false,
          customerOrderFlowerCurrencyRewardReleaseMask: 4,
          cyclicStoryOnlyHighestExperienceOrder: false,
          experienceGuardThresholdPercent: 0.5,
          flowerRackTargetArtId: null,
          materialShopMidnightRefreshEnabled: false,
          materialShopRefreshWindowStart: "23:50",
          materialShopRefreshMaxCostYuanbao: 4,
          pearlHireItemReserveCount: 100,
          teamOrderTriggerProtectionEnabled: true,
          teamOrderPaidRenewProtectionEnabled: true,
          teamOrderGuardMultiplier: 2,
        },
        createdAt: "2026-06-29T08:00:00.000Z",
        updatedAt: "2026-06-29T08:00:00.000Z",
        lastValidatedAt: null,
        serverIdx: null,
        serverText: null,
        hasCredentials: true,
        missingFields: [],
      },
    ]);
    assert.equal(JSON.stringify(profiles).includes("pc-token-1"), false);

    assert.deepEqual(await store.loadProfileEnv("main-account"), {
      CTOKEN: "ctoken-1",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "pc-token-1",
      BABI_TOKEN: "babi-token-1",
      OPEN_ID: "open-id-1",
    });
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store decrypts only explicitly requested version-query credential fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profile-version-fields-"));
  const unprotected = [];
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => `p:${value}`,
      unprotect: (value) => {
        unprotected.push(value);
        return value.slice(2);
      },
    });
    await store.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    unprotected.length = 0;

    assert.deepEqual(
      await store.loadProfileCredentialFields("main", ["CTOKEN", "PC_USER_ID", "PC_TOKEN"]),
      { CTOKEN: "ct", PC_USER_ID: "2088", PC_TOKEN: "pc" },
    );
    assert.deepEqual(unprotected.sort(), ["p:ct", "p:pc"]);
    await assert.rejects(
      store.loadProfileCredentialFields("main", ["COOKIE"]),
      (error) => error.code === "UNSUPPORTED_CREDENTIAL_FIELD",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store persists level-up ordinary resident order auto-submit setting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profiles-"));
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    await store.importProfile({
      id: "main",
      label: "主号",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });

    assert.deepEqual(await store.getProfileSettings("main"), {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
      autoSubmitOrdinaryResidentOrdersForLevelUp: false,
      autoSubmitOrdinaryResidentOrders: false,
      autoSubmitCyclicStoryOrders: false,
      autoHandleCyclicNote: false,
      autoCompleteCyclicNoteHighestRewardTask: false,
      customerOrderFlowerCurrencyRewardReleaseMask: 4,
      cyclicStoryOnlyHighestExperienceOrder: false,
      experienceGuardThresholdPercent: 0.5,
      flowerRackTargetArtId: null,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
      materialShopRefreshMaxCostYuanbao: 4,
      pearlHireItemReserveCount: 100,
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
      teamOrderGuardMultiplier: 2,
    });

    const updated = await store.updateProfileSettings("main", {
      autoSubmitOrdinaryResidentOrdersForLevelUp: true,
    });

    assert.deepEqual(updated.settings, {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
      autoSubmitOrdinaryResidentOrdersForLevelUp: true,
      autoSubmitOrdinaryResidentOrders: true,
      autoSubmitCyclicStoryOrders: false,
      autoHandleCyclicNote: false,
      autoCompleteCyclicNoteHighestRewardTask: false,
      customerOrderFlowerCurrencyRewardReleaseMask: 4,
      cyclicStoryOnlyHighestExperienceOrder: false,
      experienceGuardThresholdPercent: 0.5,
      flowerRackTargetArtId: null,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
      materialShopRefreshMaxCostYuanbao: 4,
      pearlHireItemReserveCount: 100,
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
      teamOrderGuardMultiplier: 2,
    });
    assert.deepEqual(await store.getProfileSettings("main"), {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
      autoSubmitOrdinaryResidentOrdersForLevelUp: true,
      autoSubmitOrdinaryResidentOrders: true,
      autoSubmitCyclicStoryOrders: false,
      autoHandleCyclicNote: false,
      autoCompleteCyclicNoteHighestRewardTask: false,
      customerOrderFlowerCurrencyRewardReleaseMask: 4,
      cyclicStoryOnlyHighestExperienceOrder: false,
      experienceGuardThresholdPercent: 0.5,
      flowerRackTargetArtId: null,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
      materialShopRefreshMaxCostYuanbao: 4,
      pearlHireItemReserveCount: 100,
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
      teamOrderGuardMultiplier: 2,
    });
    assert.equal((await store.listProfiles())[0].settings.autoSubmitOrdinaryResidentOrdersForLevelUp, true);

    const legacyUpdated = await store.updateProfileSettings("main", {
      autoSubmitOrdinaryResidentOrders: false,
    });
    assert.deepEqual(legacyUpdated.settings, {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
      autoSubmitOrdinaryResidentOrdersForLevelUp: false,
      autoSubmitOrdinaryResidentOrders: false,
      autoSubmitCyclicStoryOrders: false,
      autoHandleCyclicNote: false,
      autoCompleteCyclicNoteHighestRewardTask: false,
      customerOrderFlowerCurrencyRewardReleaseMask: 4,
      cyclicStoryOnlyHighestExperienceOrder: false,
      experienceGuardThresholdPercent: 0.5,
      flowerRackTargetArtId: null,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
      materialShopRefreshMaxCostYuanbao: 4,
      pearlHireItemReserveCount: 100,
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
      teamOrderGuardMultiplier: 2,
    });
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store persists flower rack target per account and reset keeps settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profiles-"));
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-03T02:00:00.000Z"),
    });

    for (const id of ["a", "b"]) {
      await store.importProfile({
        id,
        credentials: {
          CTOKEN: "ct",
          PC_USER_ID: id,
          PC_TOKEN: "pc",
          BABI_TOKEN: "babi",
          OPEN_ID: "open",
        },
      });
    }

    assert.equal((await store.getProfileSettings("a")).flowerRackTargetArtId, null);
    assert.equal((await store.getProfileSettings("b")).flowerRackTargetArtId, null);

    await store.updateProfileSettings("a", { flowerRackTargetArtId: 305101 });
    await store.updateProfileSettings("b", { flowerRackTargetArtId: 302003 });

    assert.equal((await store.getProfileSettings("a")).flowerRackTargetArtId, 305101);
    assert.equal((await store.getProfileSettings("b")).flowerRackTargetArtId, 302003);

    await store.updateProfileSettings("a", { flowerRackTargetArtId: 300101 });
    assert.equal((await store.getProfileSettings("a")).flowerRackTargetArtId, 300101);
    await store.updateProfileSettings("a", { flowerRackTargetArtId: 305101 });

    const reset = await store.resetCredentials("a");
    assert.equal(reset.settings.flowerRackTargetArtId, 305101);
    await assert.rejects(
      () => store.updateProfileSettings("a", { flowerRackTargetArtId: 123456 }),
      /Invalid flowerRackTargetArtId/,
    );
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store saves account server after validation and clears it when credentials reset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profiles-"));
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-03T06:00:00.000Z"),
    });

    await store.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });

    const validated = await store.markValidated("main", undefined, { serverIdx: 726 });
    assert.equal(validated.serverIdx, 726);
    assert.equal(validated.serverText, "区服 726");

    const listed = await store.listProfiles();
    assert.equal(listed[0].serverIdx, 726);
    assert.equal(listed[0].serverText, "区服 726");

    const reset = await store.resetCredentials("main");
    assert.equal(reset.serverIdx, null);
    assert.equal(reset.serverText, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store merges parsed credential text with manually provided fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profiles-"));
  try {
    const store = createProfileStore({
      accountsDir: dir,
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-06-29T09:00:00.000Z"),
    });

    await store.importProfile({
      label: "副号",
      credentialText: "Cookie: bigfish_ctoken_a=ct; _openid=open\nx-game-token-pcweb: pc",
      credentials: {
        PC_USER_ID: "2088999999999999",
        BABI_TOKEN: "babi",
      },
    });

    const [profile] = await store.listProfiles();
    assert.equal(profile.id, "2088999999999999");
    assert.equal(profile.label, "副号");
    assert.deepEqual(profile.missingFields, []);
    assert.equal((await store.loadProfileEnv(profile.id)).OPEN_ID, "open");
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile store preserves settings and validation from concurrent updates", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    const results = await Promise.all([
      fixture.store.updateProfileSettings("main", { flowerRackTargetArtId: 305101 }),
      fixture.store.markValidated("main", new Date("2026-07-20T00:00:00.000Z"), { serverIdx: 726 }),
    ]);
    assert.equal(results.length, 2);
    const profile = await fixture.store.getProfile("main");
    assert.equal(profile.settings.flowerRackTargetArtId, 305101);
    assert.equal(profile.lastValidatedAt, "2026-07-20T00:00:00.000Z");
    assert.equal(profile.serverIdx, 726);
  } finally {
    await fixture.close();
  }
});

test("profile store write queue recovers after one atomic rename failure", async () => {
  const fixture = await createProfileStoreFixture();
  try {
    await fixture.store.importProfile({
      ...makeCredentialProfile("main"),
      settings: { flowerRackTargetArtId: 305101 },
    });
    const profilePath = path.join(fixture.dir, "main.json");
    const before = JSON.parse(await fsPromises.readFile(profilePath, "utf8"));
    fixture.armRenameFailure();

    await assert.rejects(
      () => fixture.store.updateProfileSettings("main", { flowerRackTargetArtId: 302003 }),
      /rename failed/,
    );

    const afterFailure = JSON.parse(await fsPromises.readFile(profilePath, "utf8"));
    assert.deepEqual(afterFailure, before);
    const entries = await fsPromises.readdir(fixture.dir);
    assert.deepEqual(entries.filter((entry) => entry.includes(".tmp")), []);

    const recovered = await fixture.store.markValidated("main", new Date("2026-07-20T00:00:00.000Z"), { serverIdx: 726 });
    assert.equal(recovered.settings.flowerRackTargetArtId, 305101);
    assert.equal(recovered.lastValidatedAt, "2026-07-20T00:00:00.000Z");
    assert.equal(recovered.serverIdx, 726);
  } finally {
    await fixture.close();
  }
});

test("profile store does not serialize writes for different profiles", async () => {
  const fixture = await createProfileStoreFixture({ blockMainWrite: true });
  try {
    await fixture.store.importProfile(makeCredentialProfile("main"));
    await fixture.store.importProfile(makeCredentialProfile("alt"));
    fixture.enableMainWriteBlock();
    const mainWrite = fixture.store.updateProfileSettings("main", { flowerRackTargetArtId: 305101 });
    await fixture.mainWriteStarted;
    const altWrite = fixture.store.updateProfileSettings("alt", { flowerRackTargetArtId: 302003 });
    const first = await Promise.race([
      altWrite.then(() => "alt"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    assert.equal(first, "alt");
    fixture.releaseMainWrite();
    await mainWrite;
  } finally {
    fixture.releaseMainWrite();
    await fixture.close();
  }
});

function makeCredentialProfile(id) {
  return {
    id,
    label: id,
    credentials: {
      CTOKEN: `ct-${id}`,
      PC_USER_ID: id,
      PC_TOKEN: `pc-${id}`,
      BABI_TOKEN: `babi-${id}`,
      OPEN_ID: `open-${id}`,
    },
  };
}

async function createProfileStoreFixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-profile-queue-"));
  let pendingRenameFailures = options.failRenameOnce === true ? 1 : 0;
  let mainWriteBlockEnabled = false;
  let notifyMainWriteStarted;
  let releaseMainWrite;
  const mainWriteStarted = new Promise((resolve) => {
    notifyMainWriteStarted = resolve;
  });
  const mainWriteGate = new Promise((resolve) => {
    releaseMainWrite = resolve;
  });
  const fsImpl = {
    ...fsPromises,
    async writeFile(filePath, data, writeOptions) {
      if (mainWriteBlockEnabled && String(filePath).includes("main.json")) {
        notifyMainWriteStarted();
        await mainWriteGate;
      }
      return fsPromises.writeFile(filePath, data, writeOptions);
    },
    async rename(from, to) {
      if (pendingRenameFailures > 0) {
        pendingRenameFailures -= 1;
        throw Object.assign(new Error("rename failed"), { code: "EIO" });
      }
      return fsPromises.rename(from, to);
    },
  };
  const store = createProfileStore({
    accountsDir: dir,
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
    fs: fsImpl,
  });
  return {
    store,
    dir,
    mainWriteStarted,
    enableMainWriteBlock() {
      mainWriteBlockEnabled = options.blockMainWrite === true;
    },
    armRenameFailure() {
      pendingRenameFailures += 1;
    },
    releaseMainWrite,
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
