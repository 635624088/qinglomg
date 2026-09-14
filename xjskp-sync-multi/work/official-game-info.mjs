export const OFFICIAL_GAME_ID = "xjskp";
export const OFFICIAL_GAME_APP_ID = "2021004163668677";
export const OFFICIAL_GAME_INFO_SERVICE = "com.alipay.gamecenterhome.common.facade.service.GameCenterPcGameFacade";
export const OFFICIAL_WEBGW_STATION = "uprodhatchstation66500008";
export const OFFICIAL_QUERY_CREDENTIAL_FIELDS = Object.freeze([
  "CTOKEN",
  "PC_USER_ID",
  "PC_TOKEN",
]);

const OFFICIAL_WEBGW_APP_ID = "180020010001270314";
const OFFICIAL_ORIGIN = "https://www.wanyiwan.top";
const OFFICIAL_REFERER = `${OFFICIAL_ORIGIN}/game/${OFFICIAL_GAME_ID}`;

function normalizeQueryCredentials(credentials = {}) {
  return {
    ctoken: credentials.CTOKEN || credentials.ctoken || "",
    pcUserId: credentials.PC_USER_ID || credentials.pcUserId || "",
    pcToken: credentials.PC_TOKEN || credentials.pcToken || "",
  };
}

function validateQueryCredentials(credentials) {
  for (const [name, value] of Object.entries(credentials)) {
    if (!value) throw new Error(`Missing official query credential: ${name}`);
  }
}

export function selectOfficialQueryProfile(profiles = [], requestedId = null) {
  const complete = profiles.filter((profile) => profile?.hasCredentials === true);
  if (requestedId) {
    const selected = complete.find((profile) => profile.id === requestedId);
    if (selected) return selected;
    throw new Error(`Official query profile ${requestedId} was not found or incomplete`);
  }
  if (complete.length === 1) return complete[0];
  if (complete.length === 0) throw new Error("No complete profile is available for official version query");
  throw new Error("Multiple complete profiles are available; set XJSKP_QUERY_PROFILE_ID explicitly");
}

export async function fetchOfficialGameInfo({
  credentials = {},
  gameId = OFFICIAL_GAME_ID,
  fetchImpl = fetch,
  signal,
} = {}) {
  const normalized = normalizeQueryCredentials(credentials);
  validateQueryCredentials(normalized);
  const url = new URL(
    `https://webgwmobiler.alipay.com/gamecenterhome/${OFFICIAL_GAME_INFO_SERVICE}/queryPcGameInfo/${OFFICIAL_WEBGW_STATION}`,
  );
  url.searchParams.set("ctoken", normalized.ctoken);

  const response = await fetchImpl(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-game-token-pcweb": normalized.pcToken,
      "x-game-uid-pcweb": normalized.pcUserId,
      "x-webgw-appId": OFFICIAL_WEBGW_APP_ID,
      "x-webgw-version": "2.0",
      origin: OFFICIAL_ORIGIN,
      referer: OFFICIAL_REFERER,
    },
    body: JSON.stringify({ gameId }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Official game info HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Official game info response is not valid JSON");
  }
}

export async function queryOfficialGameMetadata(options = {}) {
  const response = await fetchOfficialGameInfo(options);
  return normalizeOfficialGameInfo(response, { queriedAt: options.queriedAt });
}

export function normalizeOfficialGameInfo(response, {
  queriedAt = new Date().toISOString(),
  gameId = OFFICIAL_GAME_ID,
} = {}) {
  if (response?.success !== true) {
    throw new Error(`Official game info query failed: ${response?.errorMsg || response?.errorCode || "unknown error"}`);
  }
  const data = response?.data;
  if (!data?.appVersion) throw new Error("Official game info response is missing appVersion");
  const packageUrl = data?.pkgUrl?.pkgUrl;
  if (!packageUrl) throw new Error("Official game info response is missing packageUrl");

  return {
    queriedAt,
    source: "alipay-gamecenter-official",
    gameId,
    appId: String(data.appId || data.pkgUrl?.appId || OFFICIAL_GAME_APP_ID),
    appName: data.appName || null,
    appVersion: String(data.appVersion),
    packageUrl: String(packageUrl),
  };
}
