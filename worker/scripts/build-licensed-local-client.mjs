#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(workerDir, "../dist/wloc.js");
const outputPath = path.resolve(workerDir, "../client/wloc-local-licensed.js");
const source = await readFile(sourcePath, "utf8");

const marker = 'let ze;(async()=>{const e=function(){try{return"undefined"!=typeof $response?$response:void 0}catch{return}}();if(!e)return void t.warn("[wloc] 非响应模式，跳过");const a=Ze();';
if (!source.includes(marker)) throw new Error("dist/wloc.js runner marker not found");

const gate = `async function wlocLicenseAllowed(){
const args=globalThis.$argument||{},apiBase=String(args.apiBase||"").replace(/\\/$/,""),licenseKey=String(args.licenseKey||"");
if(!/^https:\\/\\//i.test(apiBase)||!/^[0-9a-f]{64}$/i.test(licenseKey))return t.warn("[wloc-licensed] 授权模块参数无效"),!1;
const now=Math.floor(Date.now()/1e3),lease=o.getItem("wloc_license_lease_v1");
if(lease&&lease.licenseKey===licenseKey&&Number(lease.validUntil)>now)return!0;
let installId=o.getItem("wloc_install_id_v1");
if(!/^[A-Za-z0-9_-]{16,128}$/.test(installId||"")){const bytes=new Uint8Array(24);try{crypto.getRandomValues(bytes)}catch{for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(256*Math.random())}installId=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""),o.setItem("wloc_install_id_v1",installId)}
return await new Promise(resolve=>$httpClient.post({url:apiBase+"/api/v1/authorize",timeout:10,headers:{Authorization:"Bearer "+licenseKey,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({installId})},(error,response,body)=>{if(error)return o.setItem("wloc_license_lease_v1",null),t.warn("[wloc-licensed] 授权服务器不可用: "+error),resolve(!1);const status=Number(response&&(response.statusCode||response.status)||0);let result;try{result=JSON.parse(String(body||response.body||""))}catch{return o.setItem("wloc_license_lease_v1",null),t.warn("[wloc-licensed] 授权响应无法解析"),resolve(!1)}if(200!==status||!result.success||!Number.isInteger(result.validUntil))return o.setItem("wloc_license_lease_v1",null),t.warn("[wloc-licensed] "+(result.error||"授权被拒绝")),resolve(!1);return o.setItem("wloc_license_lease_v1",{licenseKey,validUntil:result.validUntil}),resolve(!0)}))}
`;

const replacement = `${gate}let ze;(async()=>{const e=function(){try{return"undefined"!=typeof $response?$response:void 0}catch{return}}();if(!e)return void t.warn("[wloc] 非响应模式，跳过");if(!await wlocLicenseAllowed())return ze=e,void t.warn("[wloc-licensed] 授权无效，透传真实定位");const a=Ze();`;
const output = source.replace(marker, replacement);
await writeFile(outputPath, output);
console.log(`generated ${path.relative(path.resolve(workerDir, ".."), outputPath)}`);
