import assert from "node:assert/strict";
import test from "node:test";
import { getAdminPageHtml } from "../src/admin-page.js";

test("admin page exposes license controls without embedding credentials", () => {
  const html = getAdminPageHtml();
  assert.match(html, /WLOC 授权管理/);
  assert.match(html, /创建授权/);
  assert.match(html, /停用/);
  assert.match(html, /重置设备/);
  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /Bearer\s+[0-9a-f]{24,}/i);
  assert.doesNotMatch(html, /7e4f91399ee3b5e0/i);
});
