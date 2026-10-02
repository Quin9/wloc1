#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args.shift();

function option(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`--${name} requires a value`);
  return args[index + 1];
}

function usage() {
  console.log(`Usage:
  WLOC_ADMIN_TOKEN=... node scripts/license-admin.mjs create  --base https://worker.example --label USER [--devices 1] [--expires UNIX]
  WLOC_ADMIN_TOKEN=... node scripts/license-admin.mjs list    --base https://worker.example
  WLOC_ADMIN_TOKEN=... node scripts/license-admin.mjs disable --base https://worker.example --id LICENSE_ID
  WLOC_ADMIN_TOKEN=... node scripts/license-admin.mjs enable  --base https://worker.example --id LICENSE_ID
  WLOC_ADMIN_TOKEN=... node scripts/license-admin.mjs reset   --base https://worker.example --id LICENSE_ID`);
}

if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(command ? 0 : 1);
}

const token = process.env.WLOC_ADMIN_TOKEN;
const base = String(option("base", "")).replace(/\/$/, "");
if (!token || token.length < 24) throw new Error("WLOC_ADMIN_TOKEN is missing or too short");
if (!/^https:\/\//.test(base)) throw new Error("--base must be an https:// URL");

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!response.ok) throw new Error(`${response.status} ${body.error || body.message || text}`);
  return body;
}

let result;
if (command === "create") {
  const expires = option("expires");
  result = await request("/api/admin/licenses", {
    method: "POST",
    body: JSON.stringify({
      label: option("label", ""),
      maxDevices: Number.parseInt(option("devices", "1"), 10),
      expiresAt: expires == null ? null : Number.parseInt(expires, 10),
    }),
  });
} else if (command === "list") {
  result = await request("/api/admin/licenses");
} else if (command === "disable" || command === "enable") {
  const id = option("id");
  if (!id) throw new Error("--id is required");
  result = await request(`/api/admin/licenses/${encodeURIComponent(id)}/status`, {
    method: "POST",
    body: JSON.stringify({ status: command === "enable" ? "active" : "disabled" }),
  });
} else if (command === "reset") {
  const id = option("id");
  if (!id) throw new Error("--id is required");
  result = await request(`/api/admin/licenses/${encodeURIComponent(id)}/reset-devices`, {
    method: "POST",
    body: "{}",
  });
} else {
  usage();
  throw new Error(`unknown command: ${command}`);
}

console.log(JSON.stringify(result, null, 2));
