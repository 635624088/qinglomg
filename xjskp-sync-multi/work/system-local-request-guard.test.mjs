import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createLocalRequestGuard } from "./system/local-request-guard.mjs";

function request({ host = "127.0.0.1:43722", origin, fetchSite, contentType = "application/json", token, body = "{}", forwardedHost } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = {
    host,
    ...(origin ? { origin } : {}),
    ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
    ...(token ? { "x-xjskp-session-token": token } : {}),
    ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
  };
  return req;
}

test("local request guard accepts a valid local JSON mutation", async () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  const req = request({ origin: "http://127.0.0.1:43722", token: "fixed-token" });
  guard.assertMutation(req, 43722);
  assert.deepEqual(await guard.readJsonBody(req), {});
});

test("local request guard allows a private 10.x LAN host", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "10.1.2.3:43722" }), 43722));
});

test("local request guard allows private 172.16-31.x LAN hosts", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "172.16.0.1:43722" }), 43722));
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "172.31.255.254:43722" }), 43722));
});

test("local request guard rejects out-of-range 172.x LAN hosts", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "172.15.1.1:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
  assert.throws(
    () => guard.assertLocalHost(request({ host: "172.32.1.1:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard allows a private 192.168.x LAN host", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "192.168.1.100:43722" }), 43722));
});

test("local request guard rejects a public IP host", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "8.8.8.8:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard rejects a LAN IP with a mismatched port", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "192.168.1.100:43723" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard rejects a domain-style host even on the same port", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "attacker.invalid:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard accepts a LAN-hosted JSON mutation with matching origin", async () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  const req = request({ host: "192.168.1.100:43722", origin: "http://192.168.1.100:43722", token: "fixed-token" });
  guard.assertMutation(req, 43722);
  assert.deepEqual(await guard.readJsonBody(req), {});
});

test("local request guard rejects a cross-site origin", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertMutation(request({ origin: "https://attacker.example", token: "fixed-token" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard rejects cross-site fetch metadata", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertMutation(request({ fetchSite: "cross-site", token: "fixed-token" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard rejects form posts without a session token", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertMutation(request({ contentType: "application/x-www-form-urlencoded", token: null }), 43722),
    (err) => err.statusCode === 415 && err.code === "JSON_CONTENT_TYPE_REQUIRED",
  );
});

test("local request guard rejects bodies larger than 256 KiB", async () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", maxBodyBytes: 256 * 1024 });
  const req = request({ token: "fixed-token", body: "x".repeat(256 * 1024 + 1) });
  await assert.rejects(
    () => guard.readJsonBody(req),
    (err) => err.statusCode === 413 && err.code === "REQUEST_BODY_TOO_LARGE",
  );
});

test("local request guard reports malformed JSON as a 400", async () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  const req = request({ token: "fixed-token", body: "{" });
  await assert.rejects(
    () => guard.readJsonBody(req),
    (err) => err.statusCode === 400 && err.code === "INVALID_JSON_BODY",
  );
});

test("local request guard whitelist entry with exact port allows only that port", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["100.110.1.2:43722"] });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722));
  assert.throws(
    () => guard.assertLocalHost(request({ host: "100.110.1.2:9999" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard portless whitelist entry allows any port", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["100.110.1.2"] });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722));
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "100.110.1.2:8888" }), 43722));
});

test("local request guard whitelists a domain host case-insensitively", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["xxx.jdxb.com:43722"] });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "xxx.jdxb.com:43722" }), 43722));
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "XXX.JDXB.COM:43722" }), 43722));
});

test("local request guard portless whitelist entry matches a portless host", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["xxx.jdxb.com"] });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "xxx.jdxb.com" }), 43722));
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "xxx.jdxb.com:8080" }), 43722));
});

test("local request guard keeps rejecting CGN hosts not on the whitelist", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["100.110.1.2:43722"] });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "100.110.1.3:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard keeps rejecting CGN hosts when no whitelist is configured", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard allows a whitelisted CGN host mutation with matching origin", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["100.110.1.2:43722"] });
  const req = request({ host: "100.110.1.2:43722", origin: "http://100.110.1.2:43722", token: "fixed-token" });
  assert.doesNotThrow(() => guard.assertMutation(req, 43722));
});

test("local request guard setAllowedHosts applies a new whitelist immediately", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  assert.throws(
    () => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
  guard.setAllowedHosts(["100.110.1.2"]);
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722));
});

test("local request guard setAllowedHosts with an empty list restores rejection", () => {
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["100.110.1.2"] });
  assert.doesNotThrow(() => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722));
  guard.setAllowedHosts([]);
  assert.throws(
    () => guard.assertLocalHost(request({ host: "100.110.1.2:43722" }), 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard allows a whitelisted domain mutation via forwarded host (reverse proxy)", () => {
  // Cloudflare/nginx 代理场景：源站 Host 是 IP，X-Forwarded-Host 携带原始域名。
  // 域名在白名单内、Origin hostname 与转发域名一致时放行写操作。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["console.example.com"] });
  const req = request({
    host: "127.0.0.1:43722",
    origin: "https://console.example.com",
    token: "fixed-token",
    forwardedHost: "console.example.com",
  });
  assert.doesNotThrow(() => guard.assertMutation(req, 43722));
});

test("local request guard allows a whitelisted domain host with https origin", () => {
  // 源站 Host 直接是白名单域名（代理保留 Host），Origin 是 https。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["console.example.com"] });
  const req = request({
    host: "console.example.com",
    origin: "https://console.example.com",
    token: "fixed-token",
  });
  assert.doesNotThrow(() => guard.assertMutation(req, 43722));
});

test("local request guard rejects a forwarded host not on the whitelist", () => {
  // 域名未配置白名单：即使 X-Forwarded-Host 与 Origin hostname 一致也拒绝。
  const guard = createLocalRequestGuard({ token: "fixed-token" });
  const req = request({
    host: "127.0.0.1:43722",
    origin: "https://console.example.com",
    token: "fixed-token",
    forwardedHost: "console.example.com",
  });
  assert.throws(
    () => guard.assertMutation(req, 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard rejects a whitelisted forwarded host with a mismatched origin hostname", () => {
  // 白名单域名命中，但 Origin 是攻击者域名：hostname 不一致，拒绝。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["console.example.com"] });
  const req = request({
    host: "127.0.0.1:43722",
    origin: "https://evil.example",
    token: "fixed-token",
    forwardedHost: "console.example.com",
  });
  assert.throws(
    () => guard.assertMutation(req, 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});

test("local request guard allows a whitelisted public-IP host with https origin (cloudflare origin)", () => {
  // Cloudflare 源站形态：Host 头是公网源站 IP:端口（非回环），浏览器 Origin 是 https。
  // 白名单配公网源站 IP:端口，Origin hostname 与 Host hostname 一致时放行。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["203.0.113.10:43722"] });
  const req = request({
    host: "203.0.113.10:43722",
    origin: "https://203.0.113.10:43722",
    token: "fixed-token",
  });
  assert.doesNotThrow(() => guard.assertMutation(req, 43722));
});

test("local request guard allows a whitelisted public-IP host with https domain origin via forwarded host", () => {
  // Cloudflare 源站形态：Host 是公网源站 IP:端口，X-Forwarded-Host 是浏览器域名，
  // Origin 是 https://域名。域名在白名单内、Origin hostname 与转发域名一致时放行。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["console.example.com"] });
  const req = request({
    host: "203.0.113.10:43722",
    origin: "https://console.example.com",
    token: "fixed-token",
    forwardedHost: "console.example.com",
  });
  assert.doesNotThrow(() => guard.assertMutation(req, 43722));
});

test("local request guard rejects a whitelisted public-IP host with https domain origin and no forwarded host", () => {
  // 白名单配的是源站 IP:端口，但 Origin 是 https://域名（Cloudflare 未发 X-Forwarded-Host）：
  // hostname 不匹配，拒绝 —— 必须靠 X-Forwarded-Host 或把域名加入白名单。
  const guard = createLocalRequestGuard({ token: "fixed-token", allowedHosts: ["203.0.113.10:43722"] });
  const req = request({
    host: "203.0.113.10:43722",
    origin: "https://console.example.com",
    token: "fixed-token",
  });
  assert.throws(
    () => guard.assertMutation(req, 43722),
    (err) => err.statusCode === 403 && err.code === "LOCAL_REQUEST_FORBIDDEN",
  );
});
