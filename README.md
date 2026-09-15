# pi-devin-oauth

**English** | [简体中文](README_zh.md)

Use Devin models in [Pi](https://pi.dev) without the Devin CLI. Sign-in and the model catalog run inside Pi, and chat goes straight to the endpoints the Devin client uses.

Unofficial, not affiliated with Cognition. The protocol is reverse engineered, so it can break without notice.

## Install

```bash
pi install git:github.com/ttttmr/pi-devin-oauth
```

Then `/reload`.

## Usage

```text
/login devin
/model
```

`/login devin` offers two ways in:

1. Browser sign-in. Pi opens the Windsurf sign-in page, and you paste the token it shows.
2. Paste an existing API key, such as `devin-session-token$...`.

After that, `/model` lists the models your account can use, and `/thinking` or Shift+Tab sets the thinking level.

## How it works

Login calls `RegisterUser` on `register.windsurf.com` and stores the API key in `~/.pi/agent/auth.json`. The model list comes from `GetCliModelConfigs` and is cached at `~/.pi/agent/cache/devin-oauth-catalog.json`. Chat streams from `GetChatMessage`.

Model IDs are never hardcoded. `/model` shows what your account can run, one entry per family, and the thinking level picks the matching variant.

Do not install this alongside `pi-devin`, `pi-devin-local` or `pi-devin-auth`; all of them register the same `devin` provider.

## License

MIT.
