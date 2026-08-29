# dsh-subscription-antigravity

在 [DeepSeek Harness](https://github.com/shaomingbo/deepseek-harness) 中复用
**Google Antigravity 订阅**（Google AI Pro / Ultra）：一次授权一个或多个 Google
账号，插件即注册 `antigravity` 模型路由，把 Cloud Code Assist 的 Gemini、
Claude、GPT-OSS 模型通过 loopback OpenAI 兼容代理提供给 harness。

协议实现参考 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity)。
**非官方集成** —— 与 Google 无隶属或背书关系；只在你有权访问的账号和服务上使用。

## 安装

```bash
npx --yes github:shaomingbo/dsh-subscription-antigravity#v0.2.1
```

无参数安装器会把 bundle 加入 `web` profile（固定 tag 来源、
`pnpm install --ignore-scripts`、manifest 临时文件 + 原子重命名、依赖安装失败
自动回滚）。安装器从不停止或重启 DSH —— 结束后请**手动重启 DSH 并强制刷新
Web GUI**。

其他命令：

```bash
npx --yes github:shaomingbo/dsh-subscription-antigravity#v0.2.1 status
npx --yes github:shaomingbo/dsh-subscription-antigravity#v0.2.1 uninstall
```

选项：`--profile <name>`（默认 `web`）、`--source <spec>`、`--help`。
环境变量 `DSH_ANTIGRAVITY_SOURCE` 可覆盖包来源。

### 本地开发（link:）

```bash
npx --yes github:shaomingbo/dsh-subscription-antigravity#v0.2.1 install \
  --source link:/Users/you/open-source/dsh-subscription-antigravity
```

`link:` 仅用于开发；日常使用请切回固定 tag。

### 手动兜底

直接编辑 `~/.dsh/profiles/web/package.json`：在 `dependencies` 加入
`"dsh-subscription-antigravity": "github:shaomingbo/dsh-subscription-antigravity#v0.2.1"`，
在 `dsh.profile.bundles` 加入 `"dsh-subscription-antigravity"`，然后在 profile
目录运行 `pnpm install --ignore-scripts`，重启 DSH 并强刷。

## 账号池、额度与切换

1. 打开 **Settings → Antigravity**，点击 **添加 Google 账号**。Google 会显示账号
   选择器；OAuth 使用 PKCE，本地回调服务器只绑定 `localhost:51121`。
2. 重复添加即可组成本机账号池。每张账号卡显示邮箱、当前状态、project、最低已知
   剩余额度、重置时间，并可展开查看各 runtime model 的额度。
3. 点击 **切换到此账号** 即可切换，不需要重新 OAuth。已经开始的请求继续使用原
   账号，新请求使用当前账号。
4. **额度耗尽时自动切换账号** 默认关闭。开启后也只处理明确的额度耗尽 429；普通
   限流、授权错误、网络错误和 5xx 都不会触发切换。

新添加的账号默认成为当前账号。移除只删除对应的本机凭据；移除当前账号后会选择
下一个已保存账号。DSH 模型选择器仍只有一个 `antigravity` provider，并始终使用
当前账号。旧版 v1 单账号文件会自动迁移，无需重新登录。

远程/无头浏览器可把完整回调 URL
（`http://localhost:51121/oauth-callback?…`）粘贴进输入框。申请的 Google
scopes：`aicode`、`cloud-platform`、`userinfo.email`、`userinfo.profile`、
`cclog`、`experimentsandconfigs`；授权前请先审阅。

## 模型

公共模型 id 与 Antigravity CLI 目录一致；每个模型只暴露后端声明的思考级别
（思考级别映射到后端 runtime id，见 `SPEC.md`）：

| 模型 | 输入 | 思考级别 |
|---|---|---|
| `gemini-3.7-flash` | 文本、图片 | low / medium / high |
| `gemini-3.6-flash` | 文本、图片 | low / medium / high |
| `gemini-3.5-flash` | 文本、图片 | low / medium / high |
| `gemini-3.1-pro` | 文本、图片 | low / high |
| `claude-sonnet-4-6` | 文本、图片 | high |
| `claude-opus-4-6` | 文本、图片 | high |
| `gpt-oss-120b` | 文本 | medium |

模型可用性、订阅资格和配额因账号而异。设置页为每个已保存账号分别读取
`quotaInfo`；它是 runtime model 级的尽力快照，不承诺不同模型共用同一额度池。

## 工作原理

```mermaid
flowchart LR
    A["llm-pi-ai Antigravity 路由"] --> B["Loopback 代理 127.0.0.1:51122"]
    B -->|streamGenerateContent| C["Cloud Code Assist daily 端点"]
    D["Google OAuth PKCE"] --> E["本机账号池"]
    E --> F["当前账号路由"]
    F --> B
```

- 插件通过 settings 服务以「按 provider 合并」的方式供给（并修复）
  `llm-pi-ai.providers` 里的 `antigravity` 路由 —— 你自己改过的 `models`
  会被保留，其他 provider 永远不会被触碰。
- 代理只绑定 `127.0.0.1`，把 OpenAI chat completions（SSE 流式与 JSON）翻译为
  Cloud Code Assist 信封，覆盖工具调用、图片输入、思考 → `reasoning_content`、
  配额友好错误映射。端口可用 `DSH_ANTIGRAVITY_PROXY_PORT` 覆盖。
- 每个生成请求会固定同一账号的 token 和 project，因此手动切换不会让进行中的
  请求串号；可选额度轮换会串行执行，避免并发切换风暴。
- 当前账号的 access token 会同步进普通凭据 seam
  （`ANTIGRAVITY_ACCESS_TOKEN`）；账号池为空时会移除 seam 值。
- 按量计费、非 Google 端点不在范围内。

## 凭据安全

- OAuth 令牌只存于版本化账号池 `$DSH_HOME/.antigravity-auth.json`（0600、
  原子写）。它们不会进入浏览器 RPC、日志或导出内容，只会发送到 Google OAuth
  与 Cloud Code Assist 端点；错误里的上游文本会做脱敏与截断。
- **卸载会保留凭据文件。** 如需彻底清除，请自行删除
  `$DSH_HOME/.antigravity-auth.json`。
- 安装器只修改 profile 的 `package.json`（依赖 + bundle 条目）；从不读取
  凭据、不执行 lifecycle scripts、不停止/重启 DSH。

## 开发

```bash
npm install          # 仅测试工具链；插件本身零运行时依赖
npm run check        # 语法检查 + 完整测试
npm test
```

测试覆盖安装器契约（临时 `DSH_HOME` 的首次安装、重复安装、状态、卸载、畸形
manifest、参数错误、回滚）、v1→v2 凭据迁移、多账号 OAuth 与 refresh 隔离、
额度轮换并发、翻译层、loopback 代理、路由供给、凭据同步、按账号用量、双语键
一致性与打包内容。

## 许可

MIT —— 见 [LICENSE](LICENSE)。协议参考：[SPEC.md](SPEC.md)。
