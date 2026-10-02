// Apple WLOC protobuf patcher used by the licensed Worker endpoint.
//
// The phone sends the original Apple response to the Worker.  This module
// performs the binary rewrite on the server so a disabled license can no
// longer obtain a modified response.

const MAX_SCAN_OFFSET = 96;

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readVarint(bytes, offset) {
  let value = 0;
  let multiplier = 1;
  let bits = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    offset += 1;
    if (bits < 56) value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, offset];
    multiplier *= 128;
    bits += 7;
    if (bits >= 70) throw new Error(`varint too long at ${offset}`);
  }
  throw new Error("truncated varint");
}

function encodeVarint(input) {
  let value = Math.floor(input);
  if (value >= 0) {
    const out = [];
    while (value >= 128) {
      out.push((value % 128) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(value);
    return Uint8Array.from(out);
  }

  // Protobuf int64 uses the two's-complement representation for negatives.
  const bytes = new Uint8Array(8);
  let absolute = -value;
  for (let i = 0; i < 8; i += 1) {
    bytes[i] = absolute & 0xff;
    absolute = Math.floor(absolute / 256);
  }
  let carry = 1;
  for (let i = 0; i < 8; i += 1) {
    const next = (~bytes[i] & 0xff) + carry;
    bytes[i] = next & 0xff;
    carry = next >> 8;
  }
  const out = [];
  for (let group = 0; group < 10; group += 1) {
    let byte = 0;
    for (let bit = 0; bit < 7; bit += 1) {
      const index = group * 7 + bit;
      if (index < 64) byte |= ((bytes[index >> 3] >> (index & 7)) & 1) << bit;
    }
    if (group < 9) byte |= 0x80;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

export function parseFields(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    const [tag, afterTag] = readVarint(bytes, offset);
    offset = afterTag;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNo === 0) throw new Error(`invalid protobuf field 0 at ${start}`);

    let value;
    if (wireType === 0) {
      [value, offset] = readVarint(bytes, offset);
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new Error("truncated fixed64 field");
      value = bytes.slice(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      let length;
      [length, offset] = readVarint(bytes, offset);
      if (length < 0 || offset + length > bytes.length) throw new Error("truncated length-delimited field");
      value = bytes.slice(offset, offset + length);
      offset += length;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new Error("truncated fixed32 field");
      value = bytes.slice(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    fields.push({ fieldNo, wireType, value, raw: bytes.slice(start, offset) });
  }
  return fields;
}

function encodeField(fieldNo, wireType, value) {
  const tag = encodeVarint(fieldNo * 8 + wireType);
  if (wireType === 0) return concatBytes([tag, encodeVarint(value)]);
  if (wireType === 1 || wireType === 5) return concatBytes([tag, value]);
  if (wireType === 2) return concatBytes([tag, encodeVarint(value.length), value]);
  throw new Error(`cannot encode wire type ${wireType}`);
}

function patchLocation(bytes, settings, stats) {
  const fields = parseFields(bytes);
  const hasLatitude = fields.some((field) => field.fieldNo === 1 && field.wireType === 0);
  const hasLongitude = fields.some((field) => field.fieldNo === 2 && field.wireType === 0);
  if (!hasLatitude || !hasLongitude) return bytes;

  const output = fields.map((field) => {
    if (field.fieldNo === 1 && field.wireType === 0) {
      return encodeField(1, 0, Math.round(settings.latitude * 1e8));
    }
    if (field.fieldNo === 2 && field.wireType === 0) {
      return encodeField(2, 0, Math.round(settings.longitude * 1e8));
    }
    if (field.fieldNo === 3 && field.wireType === 0) {
      return encodeField(3, 0, settings.accuracy);
    }
    return field.raw;
  });
  stats.locations += 1;
  return concatBytes(output);
}

function ascii(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function patchWifi(bytes, settings, stats) {
  const fields = parseFields(bytes);
  const isWifi = fields.some(
    (field) => field.fieldNo === 1 && field.wireType === 2 &&
      /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(ascii(field.value)),
  );
  if (!isWifi) return bytes;

  let changed = false;
  const output = fields.map((field) => {
    if (field.fieldNo !== 2 || field.wireType !== 2) return field.raw;
    try {
      const patched = patchLocation(field.value, settings, stats);
      if (!bytesEqual(field.value, patched)) changed = true;
      return encodeField(field.fieldNo, field.wireType, patched);
    } catch {
      stats.skipped += 1;
      return field.raw;
    }
  });
  if (changed) stats.wifi += 1;
  return concatBytes(output);
}

function patchCell(bytes, settings, stats) {
  const fields = parseFields(bytes);
  let changed = false;
  const output = fields.map((field) => {
    if (field.fieldNo !== 5 || field.wireType !== 2) return field.raw;
    try {
      const patched = patchLocation(field.value, settings, stats);
      if (!bytesEqual(field.value, patched)) changed = true;
      return encodeField(field.fieldNo, field.wireType, patched);
    } catch {
      stats.skipped += 1;
      return field.raw;
    }
  });
  if (changed) stats.cell += 1;
  return concatBytes(output);
}

function patchRoot(bytes, settings, stats) {
  const fields = parseFields(bytes);
  const output = fields.map((field) => {
    if (field.fieldNo === 2 && field.wireType === 2) {
      return encodeField(field.fieldNo, field.wireType, patchWifi(field.value, settings, stats));
    }
    if ((field.fieldNo === 22 || field.fieldNo === 24) && field.wireType === 2) {
      return encodeField(field.fieldNo, field.wireType, patchCell(field.value, settings, stats));
    }
    return field.raw;
  });
  return concatBytes(output);
}

function snapshotStats(stats) {
  return { ...stats };
}

function restoreStats(stats, snapshot) {
  Object.assign(stats, snapshot);
}

function patchFrame(bytes, base, settings, stats) {
  if (bytes.length < base + 10) throw new Error(`body too short: ${bytes.length}, base=${base}`);
  const frameLength = (bytes[base + 8] << 8) | bytes[base + 9];
  if (frameLength <= 0) throw new Error(`invalid empty frame length at ${base}`);
  if (base + 10 + frameLength > bytes.length) {
    throw new Error(`invalid frame length ${frameLength} at ${base} for ${bytes.length}`);
  }

  const prefix = bytes.slice(0, base + 8);
  const payload = bytes.slice(base + 10, base + 10 + frameLength);
  const suffix = bytes.slice(base + 10 + frameLength);
  const before = snapshotStats(stats);
  const patched = patchRoot(payload, settings, stats);
  const changes = (stats.locations - before.locations) + (stats.wifi - before.wifi) + (stats.cell - before.cell);
  if (patched.length > 65535) throw new Error(`patched payload too large: ${patched.length}`);
  if (changes <= 0 || bytesEqual(payload, patched)) {
    restoreStats(stats, before);
    throw new Error(`frame parsed but no patchable wloc payload at ${base}`);
  }

  return concatBytes([
    prefix,
    Uint8Array.from([(patched.length >> 8) & 0xff, patched.length & 0xff]),
    patched,
    suffix,
  ]);
}

function patchRaw(bytes, settings, stats) {
  const errors = [];
  const limit = Math.min(256, bytes.length);
  for (let offset = 0; offset <= limit; offset += 1) {
    const before = snapshotStats(stats);
    try {
      const input = bytes.slice(offset);
      const patched = patchRoot(input, settings, stats);
      const changes = (stats.locations - before.locations) + (stats.wifi - before.wifi) + (stats.cell - before.cell);
      if (changes > 0 && !bytesEqual(input, patched)) {
        return concatBytes([bytes.slice(0, offset), patched]);
      }
      restoreStats(stats, before);
    } catch (error) {
      restoreStats(stats, before);
      if (errors.length < 6) errors.push(`raw@${offset}:${error.message}`);
    }
  }
  throw new Error(`raw protobuf scan failed; ${errors.join(" | ")}`);
}

export function applyRandomRadius(settings, random = Math.random) {
  const radius = Number(settings.randomRadius);
  if (!Number.isFinite(radius) || radius <= 0) return settings;
  const distance = Math.sqrt(random()) * radius;
  const bearing = 2 * random() * Math.PI;
  const angular = distance / 6378137;
  const lat1 = (settings.latitude * Math.PI) / 180;
  const lon1 = (settings.longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 = (
    lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    ) + 3 * Math.PI
  ) % (2 * Math.PI) - Math.PI;
  return {
    ...settings,
    latitude: Number(((lat2 * 180) / Math.PI).toFixed(8)),
    longitude: Number(((lon2 * 180) / Math.PI).toFixed(8)),
    randomDistance: distance,
  };
}

export function patchWlocBytes(input, settings) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 10) throw new Error(`body too short: ${bytes.length}`);
  const stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
  const errors = [];
  const offsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  const maxOffset = Math.min(MAX_SCAN_OFFSET, Math.max(0, bytes.length - 10));
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (!offsets.includes(offset)) offsets.push(offset);
  }
  for (const offset of offsets) {
    const before = snapshotStats(stats);
    try {
      return { data: patchFrame(bytes, offset, settings, stats), stats };
    } catch (error) {
      restoreStats(stats, before);
      if (errors.length < 6) errors.push(`@${offset}:${error.message}`);
    }
  }
  try {
    return { data: patchRaw(bytes, settings, stats), stats };
  } catch (error) {
    errors.push(`raw:${error.message}`);
  }
  throw new Error(`no patchable wloc payload found; ${errors.join(" | ")}`);
}

export function validateSettings(input) {
  const longitude = Number(input.longitude);
  const latitude = Number(input.latitude);
  const accuracy = Number.parseInt(input.accuracy ?? 25, 10);
  const randomRadius = Number(input.randomRadius ?? 0);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("longitude must be between -180 and 180");
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("latitude must be between -90 and 90");
  }
  if (!Number.isInteger(accuracy) || accuracy < 1 || accuracy > 10000) {
    throw new Error("accuracy must be an integer between 1 and 10000");
  }
  if (!Number.isFinite(randomRadius) || randomRadius < 0 || randomRadius > 100000) {
    throw new Error("randomRadius must be between 0 and 100000");
  }
  return { longitude, latitude, accuracy, randomRadius };
}
