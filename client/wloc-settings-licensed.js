/* WLOC licensed settings writer for Shadowrocket. */
(function () {
  "use strict";

  const SETTINGS_KEY = "wloc_settings";
  const INSTALL_KEY = "wloc_install_id_v1";
  const LEASE_KEY = "wloc_license_lease_v1";

  function parseArguments(value) {
    const output = {};
    for (const item of String(value || "").replace(/^\?/, "").split("&")) {
      if (!item) continue;
      const index = item.indexOf("=");
      const key = index < 0 ? item : item.slice(0, index);
      const raw = index < 0 ? "" : item.slice(index + 1);
      try { output[decodeURIComponent(key)] = decodeURIComponent(raw.replace(/\+/g, " ")); }
      catch { output[key] = raw; }
    }
    return output;
  }

  function query(url) {
    const output = {};
    const source = String(url || "").split("?")[1] || "";
    for (const item of source.split("&")) {
      if (!item) continue;
      const index = item.indexOf("=");
      const key = index < 0 ? item : item.slice(0, index);
      const value = index < 0 ? "" : item.slice(index + 1);
      try { output[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " ")); }
      catch { output[key] = value; }
    }
    return output;
  }

  function randomInstallId() {
    const bytes = new Uint8Array(24);
    try { crypto.getRandomValues(bytes); }
    catch { for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256); }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function getInstallId() {
    let value = $persistentStore.read(INSTALL_KEY);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value || "")) {
      value = randomInstallId();
      $persistentStore.write(value, INSTALL_KEY);
    }
    return value;
  }

  function finish(body) {
    $done({
      response: {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      },
    });
  }

  const args = parseArguments(typeof $argument === "undefined" ? "" : $argument);
  const params = query($request.url);
  const action = params.action || "save";

  if (action === "clear") {
    $persistentStore.write(null, SETTINGS_KEY);
    $persistentStore.write(null, LEASE_KEY);
    return finish({ success: true });
  }

  if (action === "query") {
    try {
      const saved = JSON.parse($persistentStore.read(SETTINGS_KEY) || "null");
      return finish(saved ? { success: true, ...saved } : { success: false, error: "无已保存的坐标" });
    } catch (error) {
      return finish({ success: false, error: error.message || "读取失败" });
    }
  }

  const longitude = Number(params.lon || params.longitude);
  const latitude = Number(params.lat || params.latitude);
  const accuracy = Number.parseInt(params.acc || params.accuracy || "25", 10);
  const apiBase = String(args.apiBase || "").replace(/\/$/, "");
  const licenseKey = String(args.licenseKey || "");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return finish({ success: false, error: "缺少或无效的 lon/lat 参数" });
  }
  if (!/^https:\/\//i.test(apiBase) || !/^[0-9a-f]{64}$/i.test(licenseKey)) {
    return finish({ success: false, error: "授权模块参数无效" });
  }

  $httpClient.post({
    url: `${apiBase}/api/v1/authorize`,
    timeout: 10,
    headers: {
      Authorization: `Bearer ${licenseKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ installId: getInstallId() }),
  }, function (error, response, body) {
    if (error) return finish({ success: false, error: `授权服务器不可用: ${error}` });
    const status = Number(response && (response.statusCode || response.status) || 0);
    let result;
    try { result = JSON.parse(String(body || response.body || "")); }
    catch { return finish({ success: false, error: `授权响应无法解析 (${status || "unknown"})` }); }
    if (status !== 200 || !result.success || !Number.isInteger(result.validUntil)) {
      $persistentStore.write(null, LEASE_KEY);
      return finish({ success: false, error: result.error || `授权被拒绝 (${status || "unknown"})` });
    }
    const settings = {
      longitude,
      latitude,
      accuracy: Number.isInteger(accuracy) ? accuracy : 25,
      updatedAt: new Date().toISOString(),
    };
    if (params.randomRadius != null && params.randomRadius !== "") {
      settings.randomRadius = Number(params.randomRadius) || 0;
    }
    $persistentStore.write(JSON.stringify(settings), SETTINGS_KEY);
    $persistentStore.write(JSON.stringify({ licenseKey, validUntil: result.validUntil }), LEASE_KEY);
    return finish({ success: true, ...settings, validUntil: result.validUntil });
  });
}());
