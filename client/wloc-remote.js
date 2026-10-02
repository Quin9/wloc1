/*
 * Apple WLOC licensed client for Shadowrocket.
 *
 * This client intentionally does not contain the protobuf patch algorithm.
 * It sends the intercepted response to the license owner's Worker and only
 * applies a response returned by an authorized /api/v1/patch request.
 * Any error fails closed: the original Apple response is passed through.
 */
(function () {
  "use strict";

  const SETTINGS_KEY = "wloc_settings";
  const INSTALL_KEY = "wloc_install_id_v1";

  function log(message) {
    console.log(`[wloc-licensed] ${message}`);
  }

  function parseArguments(value) {
    const output = {};
    for (const item of String(value || "").replace(/^\?/, "").split("&")) {
      if (!item) continue;
      const index = item.indexOf("=");
      const rawKey = index < 0 ? item : item.slice(0, index);
      const rawValue = index < 0 ? "" : item.slice(index + 1);
      try {
        output[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, " "));
      } catch {
        output[rawKey] = rawValue;
      }
    }
    return output;
  }

  function readSettings(args) {
    let saved = null;
    try {
      const raw = $persistentStore.read(SETTINGS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (error) {
      log(`读取坐标失败: ${error.message || error}`);
    }
    const source = saved && typeof saved === "object" ? saved : args;
    const longitude = Number(source.longitude);
    const latitude = Number(source.latitude);
    const accuracy = Number.parseInt(source.accuracy || args.accuracy || "25", 10);
    const randomRadius = Number(source.randomRadius ?? args.randomRadius ?? 0);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
    return {
      longitude,
      latitude,
      accuracy: Number.isInteger(accuracy) ? accuracy : 25,
      randomRadius: Number.isFinite(randomRadius) ? randomRadius : 0,
    };
  }

  function randomInstallId() {
    const bytes = new Uint8Array(24);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
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

  function toBytes(value) {
    if (!value) return new Uint8Array();
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === "string") {
      const output = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i += 1) output[i] = value.charCodeAt(i) & 0xff;
      return output;
    }
    return new Uint8Array(value);
  }

  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function encodeBase64(bytes) {
    let output = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const hasB = i + 1 < bytes.length;
      const hasC = i + 2 < bytes.length;
      const b = hasB ? bytes[i + 1] : 0;
      const c = hasC ? bytes[i + 2] : 0;
      output += BASE64[a >> 2];
      output += BASE64[((a & 3) << 4) | (b >> 4)];
      output += hasB ? BASE64[((b & 15) << 2) | (c >> 6)] : "=";
      output += hasC ? BASE64[c & 63] : "=";
    }
    return output;
  }

  function decodeBase64(value) {
    const clean = String(value || "").replace(/\s/g, "");
    if (!clean || clean.length % 4 !== 0) throw new Error("服务器返回了无效的 Base64");
    const output = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = BASE64.indexOf(clean[i]);
      const b = BASE64.indexOf(clean[i + 1]);
      const c = clean[i + 2] === "=" ? 0 : BASE64.indexOf(clean[i + 2]);
      const d = clean[i + 3] === "=" ? 0 : BASE64.indexOf(clean[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("服务器返回了无效的 Base64");
      output.push((a << 2) | (b >> 4));
      if (clean[i + 2] !== "=") output.push(((b & 15) << 4) | (c >> 2));
      if (clean[i + 3] !== "=") output.push(((c & 3) << 6) | d);
    }
    return Uint8Array.from(output);
  }

  function responseText(value) {
    if (typeof value === "string") return value;
    const bytes = toBytes(value);
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let output = "";
    for (const byte of bytes) output += String.fromCharCode(byte);
    return output;
  }

  function finishOriginal(reason) {
    if (reason) log(`透传原始定位: ${reason}`);
    $done({});
  }

  const args = parseArguments(typeof $argument === "undefined" ? "" : $argument);
  const apiBase = String(args.apiBase || "").replace(/\/$/, "");
  const licenseKey = String(args.licenseKey || "");
  const settings = readSettings(args);
  const originalBytes = toBytes($response.bodyBytes || $response.rawBody || $response.body);

  if (!settings) return finishOriginal("尚未设置目标坐标");
  if (!/^https:\/\//i.test(apiBase)) return finishOriginal("apiBase 配置无效");
  if (!/^[0-9a-f]{64}$/i.test(licenseKey)) return finishOriginal("授权码配置无效");
  if (!originalBytes.length) return finishOriginal("苹果响应中没有二进制正文");

  const requestBody = JSON.stringify({
    payload: encodeBase64(originalBytes),
    installId: getInstallId(),
    longitude: settings.longitude,
    latitude: settings.latitude,
    accuracy: settings.accuracy,
    randomRadius: settings.randomRadius,
  });

  $httpClient.post({
    url: `${apiBase}/api/v1/patch`,
    timeout: 15,
    headers: {
      Authorization: `Bearer ${licenseKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: requestBody,
  }, function (error, response, body) {
    if (error) return finishOriginal(`授权服务器不可用: ${error}`);
    const status = Number(response && (response.statusCode || response.status) || 0);
    let result;
    try {
      result = JSON.parse(responseText(body || response.body));
    } catch (parseError) {
      return finishOriginal(`授权服务器响应无法解析 (${status || "unknown"})`);
    }
    if (status !== 200 || !result.success || !result.payload) {
      return finishOriginal(result.error || `授权被拒绝 (${status || "unknown"})`);
    }

    let patched;
    try {
      patched = decodeBase64(result.payload);
    } catch (decodeError) {
      return finishOriginal(decodeError.message || decodeError);
    }
    const headers = { ...($response.headers || {}) };
    delete headers["Content-Encoding"];
    delete headers["content-encoding"];
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
    delete headers["Content-Length"];
    delete headers["content-length"];
    headers["Content-Length"] = String(patched.length);
    log(`服务端修改成功: locations=${result.stats && result.stats.locations || 0}`);
    $done({
      response: {
        ...$response,
        status: 200,
        statusCode: 200,
        headers,
        body: patched,
        bodyBytes: patched,
        rawBody: patched,
      },
    });
  });
}());
