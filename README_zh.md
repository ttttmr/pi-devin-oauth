# pi-devin-oauth

[English](README.md) | **简体中文**

在 [Pi](https://pi.dev) 里用 Devin 模型，不用装 Devin CLI。登录和模型目录都在 Pi 内完成，聊天直接发到 Devin 客户端用的端点。

非官方项目，和 Cognition 无关。协议是逆向来的，随时可能失效。

## 安装

```bash
pi install git:github.com/ttttmr/pi-devin-oauth
```

然后 `/reload`。

## 使用

```text
/login devin
/model
```

`/login devin` 提供两种登录方式：

1. 浏览器登录。Pi 打开 Windsurf 登录页，你把页面上的 token 贴回来。
2. 粘贴已有 API key，比如 `devin-session-token$...`。

登录之后，`/model` 会列出你账号能用的模型，`/thinking` 或 Shift+Tab 调整 thinking 档位。

## 工作原理

登录调用 `register.windsurf.com` 的 `RegisterUser`，拿到的 API key 存进 `~/.pi/agent/auth.json`。模型列表来自 `GetCliModelConfigs`，缓存在 `~/.pi/agent/cache/devin-oauth-catalog.json`。聊天走 `GetChatMessage` 流式返回。

模型 ID 不写死，`/model` 显示的就是这个账号实际能跑的，每个 family 一条，thinking 档位决定发哪个变体。

不要和 `pi-devin`、`pi-devin-local`、`pi-devin-auth` 同时安装，它们注册的是同一个 `devin` provider。

## License

MIT.
