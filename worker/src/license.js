const LICENSE_KEY_BYTES = 32;

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomLicenseKey() {
  const bytes = new Uint8Array(LICENSE_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left || "");
  const b = new TextEncoder().encode(right || "");
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) mismatch |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return mismatch === 0;
}

export function requireAdmin(c) {
  const configured = c.env.ADMIN_TOKEN || "";
  const supplied = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  return configured.length >= 24 && constantTimeEqual(configured, supplied);
}

export async function findLicenseByKey(db, licenseKey) {
  if (!db) throw new Error("D1 binding DB is not configured");
  if (!/^[0-9a-f]{64}$/i.test(licenseKey || "")) return null;
  const keyHash = await sha256Hex(licenseKey.toLowerCase());
  return db.prepare(
    `SELECT id, label, status, expires_at, max_devices, created_at, revoked_at
       FROM licenses WHERE key_hash = ? LIMIT 1`,
  ).bind(keyHash).first();
}

export async function authorizeInstall(db, licenseKey, installId, now = Math.floor(Date.now() / 1000)) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(installId || "")) {
    return { ok: false, status: 400, code: "INVALID_INSTALL_ID" };
  }
  const license = await findLicenseByKey(db, licenseKey);
  if (!license) return { ok: false, status: 401, code: "INVALID_LICENSE" };
  if (license.status !== "active") return { ok: false, status: 403, code: "LICENSE_DISABLED" };
  if (license.expires_at !== null && Number(license.expires_at) <= now) {
    return { ok: false, status: 403, code: "LICENSE_EXPIRED" };
  }

  const existing = await db.prepare(
    "SELECT id, last_seen FROM license_devices WHERE license_id = ? AND install_id = ? LIMIT 1",
  ).bind(license.id, installId).first();
  if (existing) {
    // License status is still read on every request. Only coalesce operational
    // last_seen writes so frequent location lookups do not create needless D1 writes.
    if (now - Number(existing.last_seen || 0) >= 300) {
      await db.prepare(
        "UPDATE license_devices SET last_seen = ? WHERE license_id = ? AND install_id = ?",
      ).bind(now, license.id, installId).run();
    }
    return { ok: true, license };
  }

  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM license_devices WHERE license_id = ?",
  ).bind(license.id).first();
  if (Number(row?.count || 0) >= Number(license.max_devices || 1)) {
    return { ok: false, status: 403, code: "DEVICE_LIMIT_REACHED" };
  }
  await db.prepare(
    `INSERT INTO license_devices (license_id, install_id, first_seen, last_seen)
     VALUES (?, ?, ?, ?)`,
  ).bind(license.id, installId, now, now).run();
  return { ok: true, license };
}

export function licensedModule({ origin, licenseKey }) {
  const apiBase = origin.replace(/\/$/, "");
  return `#!name=Apple WLOC 授权版
#!desc=服务端授权与定位响应修改；授权失效或服务器不可用时恢复真实定位
#!author=Quin9
#!homepage=https://github.com/Quin9/wloc1
#!icon=https://raw.githubusercontent.com/Quin9/wloc1/refs/heads/main/wloc.jpg
#!category=Tools

[Script]
Apple WLOC Licensed = type=http-response,pattern=^https?:\\/\\/(?:gs-loc(?:-cn)?\\.apple\\.com|gsp-ssl\\.ls\\.apple\\.com|bluedot\\.is\\.autonavi\\.com(?:\\.gds\\.alibabadns\\.com)?)\\/clls\\/wloc,requires-body=1,binary-body-mode=1,max-size=0,timeout=30,script-path=https://raw.githubusercontent.com/Quin9/wloc1/refs/heads/main/client/wloc-local-licensed.js?v=20261003-2,argument=apiBase=${apiBase}&licenseKey=${licenseKey}&longitude=113.94114&latitude=22.544577&accuracy=25&randomRadius=0&logLevel=info
WLOC Settings Licensed = type=http-request,pattern=^https?:\\/\\/gs-loc(-cn)?\\.apple\\.com\\/wloc-settings\\/save,requires-body=0,max-size=0,timeout=15,script-path=https://raw.githubusercontent.com/Quin9/wloc1/refs/heads/main/client/wloc-settings-licensed.js?v=20261003-2,argument=apiBase=${apiBase}&licenseKey=${licenseKey}

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, gsp-ssl.ls.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com
`;
}
