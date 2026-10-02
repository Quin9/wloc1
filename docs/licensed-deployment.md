# WLOC 授权版部署与管理

这套版本把 Apple WLOC 二进制修改放到 Cloudflare Worker。手机上的脚本只负责读取本机坐标、上传原始响应和接收修改结果。Worker 每次都查询授权状态；授权被禁用或 Worker 不可用时，客户端不修改响应，iPhone 使用真实定位。

## 源码位置

- `client/wloc-remote.js`：小火箭轻客户端，不包含 protobuf 修改算法。
- `worker/src/wloc-patch.js`：服务端 WLOC 修改算法。
- `worker/src/license.js`：授权、设备登记和动态模块。
- `worker/src/index.js`：`/api/v1/patch` 与管理 API。
- `worker/migrations/0001_licenses.sql`：D1 数据表。
- `worker/scripts/license-admin.mjs`：创建、禁用、恢复授权的命令行工具。

原仓库没有 `dist/wloc.js` 对应的未压缩源码；根目录 `.gitignore` 明确忽略了旧的 `/src`。授权版因此采用独立、可维护的新客户端，而不是修改压缩产物。

## 一、确认 Cloudflare 账户

在 `worker` 目录执行：

```bash
npx wrangler login
npx wrangler whoami
```

确认显示的是你自己的 Cloudflare 账户。GitHub 用户名 `Quin9` 与 Cloudflare 账户名不要求相同；`shenguanjige.workers.dev` 是你当前 Workers 子域名的话，可以继续使用。

## 二、创建并绑定 D1

```bash
npx wrangler d1 create wloc-license-db --binding DB --location apac --update-config
```

该命令会创建远程数据库，并把真实 `database_id` 自动写入 `worker/wrangler.jsonc`。执行后确认配置中出现未被注释的 `d1_databases`，且 binding 为 `DB`。如果你的 Wrangler 版本不支持 `--update-config`，使用命令输出的配置片段手动替换文件中注释掉的示例。

应用数据库迁移：

```bash
npm run db:migrate:remote
```

## 三、设置管理密钥

生成至少 32 字节的随机密钥，例如：

```bash
openssl rand -hex 32
```

妥善保存输出，然后写入 Worker Secret：

```bash
npx wrangler secret put ADMIN_TOKEN
```

根据提示粘贴密钥。不要把它写入 `wrangler.jsonc`、GitHub、快捷指令或小火箭模块。

## 四、测试并部署

```bash
npm install
npm test
npm run deploy
```

部署后确认地址。预期类似：

```text
https://wloc-spoofer.shenguanjige.workers.dev
```

这次不能只使用原来的一键 Deploy 按钮，因为 D1 绑定、数据库迁移和 Worker Secret 需要在你的 Cloudflare 账户中完成。

## 五、发布 GitHub 客户端

动态模块固定从你的仓库读取：

```text
https://raw.githubusercontent.com/Quin9/wloc1/refs/heads/main/client/wloc-remote.js
```

因此必须把本次代码推送到 `Quin9/wloc1` 的 `main` 分支，用户安装模块前先在浏览器确认上述地址能打开。

## 六、创建用户授权

为避免把管理密钥写进命令参数，先把它放进当前终端的临时环境变量：

```bash
export WLOC_ADMIN_TOKEN='第三步生成的管理密钥'
```

创建一个最多绑定一台设备的授权：

```bash
npm run license-admin -- create \
  --base https://wloc-spoofer.shenguanjige.workers.dev \
  --label user-001 \
  --devices 1
```

输出包含：

```json
{
  "id": "后台管理使用的授权 ID",
  "licenseKey": "用户授权密钥",
  "moduleUrl": "发给用户的小火箭模块地址"
}
```

只把 `moduleUrl` 发给对应用户。用户像以前一样导入模块、安装证书、运行快捷指令，不需要进行额外验证操作。

如果需要设置到期时间，`--expires` 使用 Unix 秒时间戳：

```bash
npm run license-admin -- create --base https://wloc-spoofer.shenguanjige.workers.dev --label user-002 --devices 1 --expires 1798732800
```

## 七、查看、禁用和恢复

查看授权：

```bash
npm run license-admin -- list --base https://wloc-spoofer.shenguanjige.workers.dev
```

禁用：

```bash
npm run license-admin -- disable --base https://wloc-spoofer.shenguanjige.workers.dev --id 授权ID
```

恢复：

```bash
npm run license-admin -- enable --base https://wloc-spoofer.shenguanjige.workers.dev --id 授权ID
```

用户换手机或重装小火箭后，如果提示设备数量达到上限，清除该授权登记的设备：

```bash
npm run license-admin -- reset --base https://wloc-spoofer.shenguanjige.workers.dev --id 授权ID
```

禁用发生在下一次 Apple WLOC 请求。iOS 可能继续显示 `locationd` 已缓存的位置；这是系统定位缓存，不代表 Worker 仍然授权。重启设备并触发新的 WLOC 请求后应恢复真实定位。

## 八、迁移旧模块

不要再公开发送原来的地址：

```text
https://raw.githubusercontent.com/Quin9/wloc1/refs/heads/main/modules/wloc.module
```

新用户只使用动态生成的 `moduleUrl`。授权版验证稳定后，可以把公开的旧模块替换成说明文字或不再提供下载，但已经缓存旧 `dist/wloc.js` 的手机无法被这套系统远程停用。

建议先创建一个自己的测试授权，在一台测试手机完成以下检查后再给用户迁移：

1. 授权 active 时可以设置并修改位置。
2. 后台 disable 后，新 WLOC 请求不再修改响应。
3. Worker 断网时恢复真实响应，不保留虚拟定位。
4. reset-devices 后可以重新绑定测试手机。
5. 两台手机共用一份单设备授权时，第二个不同安装 ID 被拒绝。

## 隐私与安全边界

- `/api/v1/patch` 会临时接收 Apple WLOC 原始二进制数据，其中可能包含附近 Wi-Fi/BSSID 或基站信息。代码不把响应写入 D1，但运营者应向用户说明这一点。
- D1 只保存授权哈希、随机安装 ID 和最近调用时间，不保存明文授权密钥或目标坐标。
- 模块中的用户授权密钥是 bearer credential，用户可以查看并分享。`max_devices` 能限制普通分享，但小火箭没有可信硬件证明，不能做到不可复制的硬件绑定。
- 旧版完整算法已经公开，懂代码的人仍可继续运行或自行部署旧版；授权系统控制的是你提供的新版本服务。
