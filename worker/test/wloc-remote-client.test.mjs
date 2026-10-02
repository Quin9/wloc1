import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = await readFile(path.resolve(workerDir, "../client/wloc-remote.js"), "utf8");

async function runClient({ settings = null, httpResult = null } = {}) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const store = new Map();
  if (settings) store.set("wloc_settings", JSON.stringify(settings));
  const context = vm.createContext({
    $argument: `apiBase=https://example.workers.dev&licenseKey=${"a".repeat(64)}&accuracy=25&randomRadius=0`,
    $request: { url: "https://gs-loc.apple.com/clls/wloc" },
    $response: { status: 200, headers: { "Content-Encoding": "gzip" }, body: Uint8Array.from([1, 2, 3]) },
    $persistentStore: {
      read(key) { return store.get(key) || null; },
      write(value, key) { store.set(key, value); return true; },
    },
    $httpClient: {
      post(_options, callback) {
        if (!httpResult) throw new Error("HTTP should not be called");
        callback(httpResult.error || null, httpResult.response || {}, httpResult.body || "");
      },
    },
    $done(value) { resolveDone(value); },
    console: { log() {} },
    crypto: webcrypto,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
  });
  vm.runInContext(script, context);
  return Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("client did not call $done")), 500)),
  ]);
}

test("licensed client fails closed when no target coordinate is stored", async () => {
  assert.equal(Object.keys(await runClient()).length, 0);
});

test("licensed client applies an authorized server response", async () => {
  const result = await runClient({
    settings: { longitude: 113.9, latitude: 22.5, accuracy: 25, randomRadius: 0 },
    httpResult: {
      response: { status: 200 },
      body: JSON.stringify({ success: true, payload: "CQgH", stats: { locations: 1 } }),
    },
  });
  assert.deepEqual(Array.from(result.response.body), [9, 8, 7]);
  assert.equal(result.response.headers["Content-Encoding"], undefined);
  assert.equal(result.response.headers["Content-Length"], "3");
});

test("licensed client fails closed on a disabled license", async () => {
  const result = await runClient({
    settings: { longitude: 113.9, latitude: 22.5, accuracy: 25, randomRadius: 0 },
    httpResult: {
      response: { status: 403 },
      body: JSON.stringify({ success: false, error: "LICENSE_DISABLED" }),
    },
  });
  assert.equal(Object.keys(result).length, 0);
});
