import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";
import { applyRandomRadius, patchWlocBytes, validateSettings } from "./wloc-patch.js";
import {
  authorizeInstall,
  findLicenseByKey,
  licensedModule,
  randomLicenseKey,
  requireAdmin,
  sha256Hex,
} from "./license.js";

const app = new Hono();

app.get("/", (c) => {
  return c.html(getPageHtml());
});

const MAX_WLOC_BYTES = 2 * 1024 * 1024;
const AUTH_LEASE_SECONDS = 60;

function jsonError(c, status, code, message = code) {
  return c.json({ success: false, error: code, message }, status);
}

function decodeBase64(value) {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i);
  return output;
}

function encodeBase64(bytes) {
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(output);
}

async function maybeGunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The phone calls this endpoint for every intercepted Apple WLOC response.
// Authorization is deliberately checked on every call so disabling a license
// takes effect on the next location request instead of after a client lease.
app.post("/api/v1/patch", async (c) => {
  try {
    const licenseKey = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const body = await c.req.json();
    const auth = await authorizeInstall(c.env.DB, licenseKey, body.installId);
    if (!auth.ok) return jsonError(c, auth.status, auth.code);

    if (typeof body.payload !== "string" || body.payload.length > Math.ceil(MAX_WLOC_BYTES * 4 / 3) + 16) {
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE");
    }
    let bytes;
    try {
      bytes = decodeBase64(body.payload);
    } catch {
      return jsonError(c, 400, "INVALID_BASE64");
    }
    if (bytes.length === 0 || bytes.length > MAX_WLOC_BYTES) {
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE");
    }

    let settings;
    try {
      settings = applyRandomRadius(validateSettings(body));
    } catch (error) {
      return jsonError(c, 400, "INVALID_SETTINGS", error.message);
    }
    const uncompressed = await maybeGunzip(bytes);
    if (uncompressed.length > MAX_WLOC_BYTES) return jsonError(c, 413, "PAYLOAD_TOO_LARGE");
    const patched = patchWlocBytes(uncompressed, settings);
    return c.json({
      success: true,
      payload: encodeBase64(patched.data),
      stats: patched.stats,
      randomDistance: settings.randomDistance || 0,
    });
  } catch (error) {
    console.error("wloc patch failed", error);
    return jsonError(c, 500, "PATCH_FAILED", "patch failed");
  }
});

// Lightweight authorization for the local licensed client. The shortcut
// primes this lease while saving coordinates, so the following WLOC response
// can be patched locally without a large request/response round trip.
app.post("/api/v1/authorize", async (c) => {
  try {
    const licenseKey = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const body = await c.req.json().catch(() => ({}));
    const auth = await authorizeInstall(c.env.DB, licenseKey, body.installId);
    if (!auth.ok) return jsonError(c, auth.status, auth.code);
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      success: true,
      validUntil: now + AUTH_LEASE_SECONDS,
    });
  } catch (error) {
    console.error("wloc authorize failed", error);
    return jsonError(c, 500, "AUTHORIZE_FAILED", "authorization failed");
  }
});

// A personalized module contains a per-user bearer key.  It prevents public
// installation but is not a hardware identity; device limits are enforced by
// the installId registered by /api/v1/patch.
app.get("/api/v1/module/:licenseKey", async (c) => {
  try {
    const licenseKey = c.req.param("licenseKey");
    const license = await findLicenseByKey(c.env.DB, licenseKey);
    const now = Math.floor(Date.now() / 1000);
    if (!license) return c.text("Invalid license", 401);
    if (license.status !== "active" || (license.expires_at !== null && Number(license.expires_at) <= now)) {
      return c.text("License disabled or expired", 403);
    }
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "private, no-store");
    return c.body(licensedModule({ origin: new URL(c.req.url).origin, licenseKey }));
  } catch (error) {
    return c.text(error?.message || "Module generation failed", 500);
  }
});

app.post("/api/admin/licenses", async (c) => {
  if (!requireAdmin(c)) return jsonError(c, 401, "UNAUTHORIZED");
  try {
    const input = await c.req.json().catch(() => ({}));
    const id = crypto.randomUUID();
    const licenseKey = randomLicenseKey();
    const keyHash = await sha256Hex(licenseKey);
    const label = String(input.label || "").slice(0, 120);
    const requestedMaxDevices = Number.parseInt(input.maxDevices || 1, 10);
    if (!Number.isInteger(requestedMaxDevices) || requestedMaxDevices < 1 || requestedMaxDevices > 20) {
      return jsonError(c, 400, "INVALID_MAX_DEVICES", "maxDevices must be an integer between 1 and 20");
    }
    const maxDevices = requestedMaxDevices;
    const expiresAt = input.expiresAt == null ? null : Number.parseInt(input.expiresAt, 10);
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) {
      return jsonError(c, 400, "INVALID_EXPIRES_AT", "expiresAt must be a future Unix timestamp");
    }
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT INTO licenses (id, key_hash, label, status, expires_at, max_devices, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(id, keyHash, label, expiresAt, maxDevices, now).run();
    const origin = new URL(c.req.url).origin;
    return c.json({
      success: true,
      id,
      licenseKey,
      moduleUrl: `${origin}/api/v1/module/${licenseKey}`,
      label,
      maxDevices,
      expiresAt,
    }, 201);
  } catch (error) {
    return jsonError(c, 500, "CREATE_LICENSE_FAILED", error?.message || "create failed");
  }
});

app.get("/api/admin/licenses", async (c) => {
  if (!requireAdmin(c)) return jsonError(c, 401, "UNAUTHORIZED");
  try {
    const result = await c.env.DB.prepare(
      `SELECT l.id, l.label, l.status, l.expires_at, l.max_devices, l.created_at, l.revoked_at,
              COUNT(d.id) AS device_count, MAX(d.last_seen) AS last_seen
         FROM licenses l
         LEFT JOIN license_devices d ON d.license_id = l.id
        GROUP BY l.id
        ORDER BY l.created_at DESC
        LIMIT 500`,
    ).all();
    return c.json({ success: true, licenses: result.results || [] });
  } catch (error) {
    return jsonError(c, 500, "LIST_LICENSES_FAILED", error?.message || "list failed");
  }
});

app.post("/api/admin/licenses/:id/status", async (c) => {
  if (!requireAdmin(c)) return jsonError(c, 401, "UNAUTHORIZED");
  const input = await c.req.json().catch(() => ({}));
  const status = input.status === "active" ? "active" : input.status === "disabled" ? "disabled" : null;
  if (!status) return jsonError(c, 400, "INVALID_STATUS");
  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.DB.prepare(
    "UPDATE licenses SET status = ?, revoked_at = ? WHERE id = ?",
  ).bind(status, status === "disabled" ? now : null, c.req.param("id")).run();
  if (!result.meta?.changes) return jsonError(c, 404, "LICENSE_NOT_FOUND");
  return c.json({ success: true, id: c.req.param("id"), status });
});

app.post("/api/admin/licenses/:id/reset-devices", async (c) => {
  if (!requireAdmin(c)) return jsonError(c, 401, "UNAUTHORIZED");
  const result = await c.env.DB.prepare(
    "DELETE FROM license_devices WHERE license_id = ?",
  ).bind(c.req.param("id")).run();
  return c.json({ success: true, removed: result.meta?.changes || 0 });
});

// 地图链接解析: 供快捷指令调用。
// GET /api/parse?u=<链接>&format=json&cs=<gcj|none>
//   返回 {lat, lon, name}; 高德/苹果地图(中国大陆均为 GCJ-02)自动转 WGS84; 境外坐标自动跳过(out_of_china)。cs=none 可强制不转换。
//   不带 format=json 时返回纯文本 "lat=..&lon=.." 片段。
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // 默认按来源自动换算; cs=none 强制不转换, cs=gcj/bd 强制按指定坐标系转换。
    if (cs === "gcj") ({ lat, lon } = gcj02ToWgs84(lat, lon));
    else if (cs === "bd") ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    else if (cs !== "none") ({ lat, lon } = toWgs84(lat, lon, src));
    // 出口再校验一次: cs= 是调用方指定的, 强行按错误坐标系换算也可能把值推出值域。
    // 宁可报错也不要返回一个能被当成坐标写进设备的数字。
    if (!inRange(lat, lon)) throw new Error("解析出的坐标超出合法范围");
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

// 兜底 500 也要带 CORS —— 否则快捷指令那边看到的是跨域错误, 而不是真正的原因。
app.onError((e, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.text(`${e && e.message ? e.message : e}`, 500);
});

export default app;
