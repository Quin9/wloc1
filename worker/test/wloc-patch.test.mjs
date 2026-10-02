import assert from "node:assert/strict";
import test from "node:test";
import { parseFields, patchWlocBytes, validateSettings } from "../src/wloc-patch.js";

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
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function field(no, wire, value) {
  const tag = varint(no * 8 + wire);
  if (wire === 0) return concat(tag, varint(value));
  return concat(tag, varint(value.length), value);
}

function fixture() {
  const location = concat(field(1, 0, 100), field(2, 0, 200), field(3, 0, 50));
  const mac = new TextEncoder().encode("aa:bb:cc:dd:ee:ff");
  const wifi = concat(field(1, 2, mac), field(2, 2, location));
  const root = field(2, 2, wifi);
  const header = new Uint8Array(8);
  return concat(header, Uint8Array.from([root.length >> 8, root.length & 255]), root);
}

test("server patch rewrites a framed Wi-Fi WLOC location", () => {
  const result = patchWlocBytes(fixture(), {
    latitude: 22.544577,
    longitude: 113.94114,
    accuracy: 25,
    randomRadius: 0,
  });
  assert.equal(result.stats.locations, 1);
  assert.equal(result.stats.wifi, 1);

  const frameLength = (result.data[8] << 8) | result.data[9];
  const root = parseFields(result.data.slice(10, 10 + frameLength));
  const wifi = parseFields(root.find((item) => item.fieldNo === 2).value);
  const location = parseFields(wifi.find((item) => item.fieldNo === 2).value);
  assert.equal(location.find((item) => item.fieldNo === 1).value, 2254457700);
  assert.equal(location.find((item) => item.fieldNo === 2).value, 11394114000);
  assert.equal(location.find((item) => item.fieldNo === 3).value, 25);
});

test("invalid coordinates are rejected", () => {
  assert.throws(() => validateSettings({ latitude: 91, longitude: 0 }), /latitude/);
  assert.throws(() => validateSettings({ latitude: 0, longitude: 181 }), /longitude/);
});
