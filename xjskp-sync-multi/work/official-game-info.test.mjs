import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchOfficialGameInfo,
  normalizeOfficialGameInfo,
  selectOfficialQueryProfile,
} from "./official-game-info.mjs";
import {
  loadOfficialQueryCredentials,
  queryOfficialGameVersion,
} from "./query-official-game-version.mjs";

const OFFICIAL_RESPONSE = {
  success: true,
  data: {
    appId: "2021004163668677",
    appName: "我的花园世界",
    appVersion: "391.0.17",
    pkgUrl: {
      appId: "2021004163668677",
      pkgUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
    },
  },
};

test("fetchOfficialGameInfo posts directly to the official Alipay game-center endpoint", async () => {
  let request = null;
  const result = await fetchOfficialGameInfo({
    credentials: {
      CTOKEN: "ctoken-secret",
      PC_USER_ID: "pc-user",
      PC_TOKEN: "pc-token-secret",
    },
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify(OFFICIAL_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, OFFICIAL_RESPONSE);
  assert.match(request.url, /^https:\/\/webgwmobiler\.alipay\.com\/gamecenterhome\//);
  assert.match(request.url, /queryPcGameInfo/);
  assert.match(request.url, /ctoken=ctoken-secret/);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-game-token-pcweb"], "pc-token-secret");
  assert.equal(request.init.headers["x-game-uid-pcweb"], "pc-user");
  assert.deepEqual(JSON.parse(request.init.body), { gameId: "xjskp" });
});

test("normalizeOfficialGameInfo emits only non-secret version and package metadata", () => {
  const result = normalizeOfficialGameInfo(OFFICIAL_RESPONSE, {
    queriedAt: "2026-08-03T12:00:00.000Z",
  });

  assert.deepEqual(result, {
    queriedAt: "2026-08-03T12:00:00.000Z",
    source: "alipay-gamecenter-official",
    gameId: "xjskp",
    appId: "2021004163668677",
    appName: "我的花园世界",
    appVersion: "391.0.17",
    packageUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
  });
  assert.doesNotMatch(JSON.stringify(result), /token-secret|pc-user/i);
});

test("official query fails closed for missing credentials and invalid official responses", async () => {
  await assert.rejects(
    () => fetchOfficialGameInfo({ credentials: {}, fetchImpl: async () => new Response("{}") }),
    /Missing official query credential/,
  );
  assert.throws(
    () => normalizeOfficialGameInfo({ success: false, errorMsg: "expired" }),
    /Official game info query failed: expired/,
  );
  assert.throws(
    () => normalizeOfficialGameInfo({ success: true, data: {} }),
    /missing appVersion/,
  );
});

test("selectOfficialQueryProfile requires an explicit id when multiple profiles are complete", () => {
  const profiles = [
    { id: "one", hasCredentials: true },
    { id: "two", hasCredentials: true },
    { id: "broken", hasCredentials: false },
  ];

  assert.equal(selectOfficialQueryProfile(profiles, "two").id, "two");
  assert.throws(() => selectOfficialQueryProfile(profiles), /XJSKP_QUERY_PROFILE_ID/);
  assert.throws(() => selectOfficialQueryProfile([], null), /No complete profile/);
});

test("query command reads the selected local profile but only returns normalized public metadata", async () => {
  const credentials = {
    CTOKEN: "ctoken-secret",
    PC_USER_ID: "pc-user",
    PC_TOKEN: "pc-token-secret",
    BABI_TOKEN: "unused-babi-secret",
    OPEN_ID: "unused-open-id",
  };
  const profileStore = {
    async listProfiles() {
      return [{ id: "profile-1", hasCredentials: true }];
    },
    async loadProfileCredentialFields(id, fields) {
      assert.equal(id, "profile-1");
      assert.deepEqual(fields, ["CTOKEN", "PC_USER_ID", "PC_TOKEN"]);
      return Object.fromEntries(fields.map((field) => [field, credentials[field]]));
    },
    loadProfileEnv: async () => assert.fail("official query must not load full profile credentials"),
  };
  assert.deepEqual(await loadOfficialQueryCredentials({ env: {}, profileStore }), {
    CTOKEN: credentials.CTOKEN,
    PC_USER_ID: credentials.PC_USER_ID,
    PC_TOKEN: credentials.PC_TOKEN,
  });

  const result = await queryOfficialGameVersion({
    credentials,
    queriedAt: "2026-08-03T12:00:00.000Z",
    fetchImpl: async () => new Response(JSON.stringify(OFFICIAL_RESPONSE), { status: 200 }),
  });
  assert.equal(result.appVersion, "391.0.17");
  assert.doesNotMatch(JSON.stringify(result), /secret|pc-user|unused-open-id/);
});
