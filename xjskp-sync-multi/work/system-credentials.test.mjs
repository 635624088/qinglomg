import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_CREDENTIAL_FIELDS,
  getMissingCredentialFields,
  parseCredentialInput,
} from "./system/credentials.mjs";

test("parseCredentialInput reads copy-as-curl headers, cookies, and explicit fields", () => {
  const input = String.raw`curl "https://hygnhmzfb.babigame.cn/gw" ^
    -H "Cookie: bigfish_ctoken_abcd=ctoken-from-cookie; _openid=open-id-1; userId=2088123456789012" ^
    -H "x-game-token-pcweb: pc-token-1" ^
    -H "x-babigame-token: babi-token-1"
PC_USER_ID=2088123456789012`;

  const parsed = parseCredentialInput(input);

  assert.equal(parsed.CTOKEN, "ctoken-from-cookie");
  assert.equal(parsed.PC_USER_ID, "2088123456789012");
  assert.equal(parsed.PC_TOKEN, "pc-token-1");
  assert.equal(parsed.BABI_TOKEN, "babi-token-1");
  assert.equal(parsed.OPEN_ID, "open-id-1");
  assert.deepEqual(getMissingCredentialFields(parsed), []);
});

test("parseCredentialInput reads HAR request headers and cookies", () => {
  const har = {
    log: {
      entries: [
        {
          request: {
            headers: [
              { name: "x-game-token-pcweb", value: "pc-token-har" },
              { name: "token", value: "babi-token-har" },
            ],
            cookies: [
              { name: "bigfish_ctoken_123", value: "ctoken-har" },
              { name: "_openid", value: "open-har" },
              { name: "userId", value: "2088000000000000" },
            ],
          },
        },
      ],
    },
  };

  const parsed = parseCredentialInput(JSON.stringify(har));

  assert.deepEqual(parsed, {
    CTOKEN: "ctoken-har",
    PC_USER_ID: "2088000000000000",
    PC_TOKEN: "pc-token-har",
    BABI_TOKEN: "babi-token-har",
    OPEN_ID: "open-har",
  });
});

test("getMissingCredentialFields reports every missing required field", () => {
  assert.deepEqual(getMissingCredentialFields({ CTOKEN: "ctoken-only" }), [
    "PC_USER_ID",
    "PC_TOKEN",
    "BABI_TOKEN",
    "OPEN_ID",
  ]);
  assert.deepEqual(REQUIRED_CREDENTIAL_FIELDS, [
    "CTOKEN",
    "PC_USER_ID",
    "PC_TOKEN",
    "BABI_TOKEN",
    "OPEN_ID",
  ]);
});
