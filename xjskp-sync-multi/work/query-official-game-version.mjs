import { pathToFileURL } from "node:url";

import {
  OFFICIAL_QUERY_CREDENTIAL_FIELDS,
  fetchOfficialGameInfo,
  normalizeOfficialGameInfo,
  selectOfficialQueryProfile,
} from "./official-game-info.mjs";
import { createProfileStore } from "./system/profile-store.mjs";

function envQueryCredentials(env = process.env) {
  if (!env.CTOKEN || !env.PC_USER_ID || !env.PC_TOKEN) return null;
  return {
    CTOKEN: env.CTOKEN,
    PC_USER_ID: env.PC_USER_ID,
    PC_TOKEN: env.PC_TOKEN,
  };
}

export async function loadOfficialQueryCredentials({
  env = process.env,
  profileStore = createProfileStore(),
} = {}) {
  const fromEnv = envQueryCredentials(env);
  if (fromEnv) return fromEnv;
  const selected = selectOfficialQueryProfile(
    await profileStore.listProfiles(),
    env.XJSKP_QUERY_PROFILE_ID || null,
  );
  return profileStore.loadProfileCredentialFields(selected.id, OFFICIAL_QUERY_CREDENTIAL_FIELDS);
}

export async function queryOfficialGameVersion(options = {}) {
  const credentials = options.credentials || await loadOfficialQueryCredentials(options);
  const response = await fetchOfficialGameInfo({
    credentials,
    fetchImpl: options.fetchImpl || fetch,
  });
  return normalizeOfficialGameInfo(response, { queriedAt: options.queriedAt });
}

async function main() {
  const result = await queryOfficialGameVersion();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ queried: false, error: error.message }));
    process.exitCode = 1;
  });
}
