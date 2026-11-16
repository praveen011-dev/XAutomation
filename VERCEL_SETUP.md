# Hourly X draft reminders on Vercel

This guide deploys the current xpost dashboard to Vercel. Click **Start hourly automation** in the app to have it generate a draft each hour and send its own browser notification for your review. You choose whether to edit it, open X’s composer, and press **Post**.

## What this setup does

- Generates a draft from the topic currently in the dashboard. If the topic field is blank, it uses a general software development / AI topic.
- Stores reminder settings and draft history in that browser’s local storage.
- Shows a browser notification after the dashboard has been open for about an hour.
- Opens a prepared X composer when you choose **Composer**. You submit the post yourself.
- Does not require an X login to generate a draft or receive its notification. You need to sign in to X only when you choose to publish from the composer. The dashboard itself still requires its separate `XPOST_UI_PASSWORD` sign-in.
- Does not run a server-side hourly schedule. The Vercel Hobby plan’s Cron schedule is not hourly, and this implementation does not use Cron.

Keep the dashboard open and signed in to the dashboard in a browser. X login does not affect draft generation or notification delivery. If you close the tab, quit the browser, or the computer sleeps, the timer pauses; it may run late when the browser becomes active again. Notifications are tied to the browser and domain where you enabled them. Clearing site data removes the local draft history and reminder preference.

## 1. Connect your existing Vercel project

1. Push the latest project files to `praveen011-dev/XAutomation` on the `main` branch.
2. Open the Vercel project you already created. In **Settings → Git**, confirm the connected repository is `praveen011-dev/XAutomation` and the production branch is `main`.
3. If no repository is connected, use **Project → Settings → Git → Connect Git Repository** and select `XAutomation`. If GitHub does not list it, open the Render/Vercel GitHub App installation settings on GitHub and grant access to `XAutomation`, then refresh the provider page.
4. Use the **Other** framework preset. The included `vercel.json` serves the `public` folder and routes `/api/*` to a Vercel Node function. No build command is required; Vercel installs the dependencies from `package-lock.json`.
5. After connecting Git, open **Deployments** and redeploy the latest `main` commit if Vercel did not start a deployment automatically.

Vercel serves the site over HTTPS, which browsers require for notifications. Add a custom domain later in **Project → Settings → Domains** if you want one; notifications must be allowed separately for that exact domain.

## 2. Add environment variables in Vercel

Open **Project → Settings → Environment Variables** and add these for **Production** (also add them to Preview if you plan to test preview deployments):

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your Google AI Studio API key. Keep it server-side. |
| `XPOST_UI_PASSWORD` | A unique password with at least 12 characters. |
| `XPOST_UI_SECRET` | A random signing secret with at least 32 characters. |
| `XPOST_MANUAL` | `1` — forces the reviewed X composer route. |
| `GEMINI_MODEL` | Optional. The project default is `gemini-3.8-flash`. |

You can generate a strong password and session secret from PowerShell after installing Node.js:

```powershell
node -e "const c=require('node:crypto'); console.log('XPOST_UI_PASSWORD='+c.randomBytes(24).toString('base64url')); console.log('XPOST_UI_SECRET='+c.randomBytes(48).toString('base64url'))"
```

Save the values in a password manager, add them to Vercel, then redeploy so the production deployment receives them. Do not commit them to `.env`, Git, or source files.

The four `X_API_*` / `X_ACCESS_*` variables are not needed for this review-first flow. Adding them does not make direct posting free. If you later turn off `XPOST_MANUAL` and select direct API posting, X can charge API credits; the current X pricing page lists Post Create at $0.015 per request and Post Create with a URL at $0.20 per request. [X API pricing](https://docs.x.com/x-api/getting-started/pricing)

## 3. Sign in and enable notifications

1. Open the production Vercel URL and sign in with `XPOST_UI_PASSWORD`.
2. Enter the topic you want to write about. The current topic is remembered in that browser.
3. Click **Start hourly automation** and allow notifications from this app’s domain in the browser prompt.
4. Keep this page open. In about an hour, the app will generate a draft and show a browser notification.
5. Click the notification to bring the page forward and load that draft into the editor.
6. Review and edit it. Keep **Composer** selected, choose **Open composer**, then press **Post** in X if you want to publish.
7. Click **Stop hourly automation** whenever you want to stop the timer.

The hourly generator makes up to 24 Gemini text requests a day if the page stays active all day. Google currently lists Gemini 3.8 Flash text generation in the free tier, but per-project quotas and availability vary and can change. Check the project’s live limits in [AI Studio](https://aistudio.google.com/). If you hit a quota, pause reminders or increase the interval by changing the `HOUR_MS` value in `public/app.js` and redeploying. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## 4. Test without publishing

1. Sign in and enable reminders.
2. For a quick check, click **Draft with AI** once and confirm a draft appears. This uses Gemini but does not post.
3. Wait for the first hourly reminder, or temporarily change `HOUR_MS` in `public/app.js` to `60_000` for a one-minute local/preview check. Restore it to `60 * 60 * 1000` before production.
4. Select **Composer** and choose **Open composer**. Confirm the text is prefilled in X. Close the tab if you do not want to post.

Do not test with the **Auto** route unless you have X API credits and intentionally want a direct API publish.

## Current workflow and free-plan boundaries

| Part | Current implementation | Cost / limit |
| --- | --- | --- |
| Drafting | Gemini text API, one request per reminder | Currently free for eligible models within project quotas. |
| Hourly timing | Browser timer in `public/app.js` | Free; the browser tab must remain open. |
| Notification | Browser Notifications API | Free; requires HTTPS and permission for this domain. |
| Draft storage | Browser local storage | Free; only available in that browser profile and cleared with site data. |
| X publishing | X composer link and your manual Post click | No X developer API write call from this app. |
| Direct X API publishing | Existing optional backend route | Requires available X API credits; credentials alone do not cover the write cost. |

Vercel Functions have a read-only filesystem with only temporary `/tmp` scratch space, so the Vercel adapter intentionally stores draft history in browser local storage. Vercel Hobby Cron jobs also do not run hourly; the hourly reminder uses the browser timer instead. [Vercel filesystem limits](https://vercel.com/docs/functions/runtimes) · [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)

X’s automation rules prohibit scripting the X website. This project does not click **Post** or simulate browser actions on X; you review the draft and submit it yourself. [X Automation rules](https://help.x.com/en/rules-and-policies/x-automation)

## Reference-account content analysis

The public profile [@itsmeriyapal](https://x.com/itsmeriyapal) describes a tech / AI / startup focus. In the publicly indexed examples available during this review, recurring formats included short developer jokes, concise AI or software observations, list-style explainers, and questions inviting developer replies. The profile also includes reposts. Public posts do not reveal whether the account uses a scheduler or AI, so this is a format analysis, not a claim about its tooling.

For your own posts, use those broad formats as inspiration while writing original material from your projects and point of view:

- A real build update or a debugging lesson from your own work.
- A short practical tip you can verify.
- A small developer joke based on a real, relatable situation.
- A specific question other developers can answer.
- A short list only when each point adds useful information.

Do not copy another creator’s wording or invent a personal experience. An hourly draft is a review opportunity, not a recommendation to publish 24 times a day. Avoid repetitive posts; X prohibits spammy or substantially duplicative automated content.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No browser permission prompt | Use the production HTTPS URL. Check the browser’s site settings and allow notifications. |
| No reminder after one hour | Keep the tab open and wake the computer. Browser background throttling or sleep can delay timers. |
| Draft generation fails | Check `GEMINI_API_KEY`, the model name, and the Vercel function logs. Inspect your live Gemini quota. |
| Sign-in keeps failing | Check `XPOST_UI_PASSWORD` and `XPOST_UI_SECRET`, then redeploy after editing either variable. |
| Direct API mode is hidden | This is expected when `XPOST_MANUAL=1`; it keeps the review-first route selected. |
| Draft history disappeared | It is stored in browser local storage. Use the same browser and domain, and do not clear that site’s data. |
| Notification opens but draft is not loaded | Keep the dashboard tab open and signed in, then click the notification again. |
