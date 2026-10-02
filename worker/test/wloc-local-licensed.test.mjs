import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localClient = await readFile(path.resolve(workerDir, "../client/wloc-local-licensed.js"), "utf8");
const settingsClient = await readFile(path.resolve(workerDir, "../client/wloc-settings-licensed.js"), "utf8");
const licenseKey = "a".repeat(64);

function varint(value) {
  const output = [];
  let remaining = Math.floor(value);
  while (remaining >= 128) {
    output.push((remaining % 128) | 128);
    remaining = Math.floor(remaining / 128);
  }
  output.push(remaining);
  return Uint8Array.from(output);
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function field(number, wire, value) {
  const tag = varint(number * 8 + wire);
  return wire === 0 ? concat(tag, varint(value)) : concat(tag, varint(value.length), value);
}

function fixture() {
  const location = concat(field(1, 0, 100), field(2, 0, 200), field(3, 0, 50));
  const mac = new TextEncoder().encode("aa:bb:cc:dd:ee:ff");
  const wifi = concat(field(1, 2, mac), field(2, 2, location));
  const root = field(2, 2, wifi);
  return concat(new Uint8Array(8), Uint8Array.from([root.length >> 8, root.length & 255]), root);
}

function runScript(script, additions) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const context = vm.createContext({
    console: { log() {} },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    $done(value) { resolveDone(value); },
    ...additions,
  });
  vm.runInContext(script, context);
  return Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("script did not call $done")), 1000)),
  ]);
}

test("licensed local client uses a primed lease and patches without network latency", async () => {
  const store = new Map([
    ["wloc_settings", JSON.stringify({ longitude: 125.318121, latitude: 43.908893, accuracy: 25 })],
    ["wloc_license_lease_v1", JSON.stringify({ licenseKey, validUntil: Math.floor(Date.now() / 1000) + 300 })],
  ]);
  const result = await runScript(localClient, {
    $rocket: {},
    $argument: `apiBase=https://example.workers.dev&licenseKey=${licenseKey}&longitude=113.94114&latitude=22.544577&accuracy=25&randomRadius=0&logLevel=off`,
    $request: { url: "https://gs-loc-cn.apple.com/clls/wloc", method: "POST", headers: {} },
    $response: { status: 200, headers: { "Content-Type": "application/octet-stream" }, body: fixture() },
    $persistentStore: {
      read(key) { return store.get(key) || null; },
      write(value, key) { store.set(key, value); return true; },
    },
    $httpClient: { post() { throw new Error("network authorization should use the primed lease"); } },
  });
  assert.ok(result.response);
  assert.notDeepEqual(Array.from(result.response.body), Array.from(fixture()));
});

test("licensed settings writer authorizes before storing coordinates and primes the lease", async () => {
  const store = new Map();
  const validUntil = Math.floor(Date.now() / 1000) + 60;
  const result = await runScript(settingsClient, {
    $argument: `apiBase=https://example.workers.dev&licenseKey=${licenseKey}`,
    $request: { url: "https://gs-loc.apple.com/wloc-settings/save?lat=43.908893&lon=125.318121&acc=25" },
    $persistentStore: {
      read(key) { return store.get(key) || null; },
      write(value, key) { store.set(key, value); return true; },
    },
    $httpClient: {
      post(_options, callback) {
        callback(null, { status: 200 }, JSON.stringify({ success: true, validUntil }));
      },
    },
  });
  assert.equal(JSON.parse(result.response.body).success, true);
  assert.deepEqual(JSON.parse(store.get("wloc_settings")), {
    longitude: 125.318121,
    latitude: 43.908893,
    accuracy: 25,
    updatedAt: JSON.parse(store.get("wloc_settings")).updatedAt,
  });
  assert.deepEqual(JSON.parse(store.get("wloc_license_lease_v1")), { licenseKey, validUntil });
});
