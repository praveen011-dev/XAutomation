# Setup and troubleshooting

## Local install

1. Install Node.js 20 or newer.
2. Run `npm install` in this folder.
3. Copy `.env.example` to `.env`.
4. Add `GEMINI_API_KEY` for drafting.
5. Add all four X OAuth 1.0a values if you want to verify your account or publish through the X API.
6. Run `npm run doctor`, then `npm run dry -- --topic "A short test topic"`.
7. Run `npm run ui` and open `http://127.0.0.1:4321`.

## X API credentials

Create an X Developer project and attach the app to it. Set the app’s OAuth 1.0a app permission to **Read and write**, save, then regenerate the access token and access token secret. Put the Consumer Key, Consumer Secret, Access Token, and Access Token Secret in the matching `.env` variables. Run `npm run whoami` to check authentication.

Direct posting can still fail with HTTP 402 when the X API account has no available credits. In the dashboard, select **X composer** to prepare the post for manual review and submission in X. This avoids the API write call; the final submission is still made by you in X. A direct API post may use credits.

## Public Render dashboard

Use [DEPLOY.md](DEPLOY.md) for the Render Blueprint, dashboard password, secret variables, HTTPS and storage limits. Do not put secrets in source files or commit `.env`.

For Vercel hosting with hourly browser notifications, use [VERCEL_SETUP.md](VERCEL_SETUP.md). It covers the Vercel function adapter, environment variables, notification permission, review workflow, and the requirement to keep the browser dashboard open.

## Common issues

| Symptom | What to check |
| --- | --- |
| Gemini credentials missing | `GEMINI_API_KEY` is set in `.env` or the Render service environment. Restart/redeploy after changing it. |
| Gemini timeout or 503 | Retry later or choose an available model with `GEMINI_MODEL`. |
| X `401` or `403` | Check all four OAuth values, ensure the app is attached to a project, set Read and write, then regenerate the access token and secret. |
| X `402` credits depleted | Choose **X composer** to prepare a manual post, or add X API credits for direct API posting. |
| `xpost ui` refuses public binding | Set `XPOST_UI_HOST=0.0.0.0`, a dashboard password of at least 12 characters, and a random `XPOST_UI_SECRET` of at least 32 characters. |
| Draft history disappears after Render restart | The free filesystem is ephemeral. Attach a persistent disk on a paid service and set `XPOST_DRAFTS_DIR` to its mount path. |
| Research feed is empty | Third-party Nitter mirrors may be unavailable. Try another topic, configure a working `NITTER_INSTANCES` list, use official X API search, or draft from the topic alone. |
