# xpost

xpost helps you research a topic, draft an original post with Gemini, review it, and publish it to X. Use the command line locally or run the password-protected dashboard on Render.

## Posting choices

- **X API:** publishes directly through X’s official API. Requires OAuth 1.0a credentials, an app attached to a project with write permission, and available X API credits.
- **X composer:** opens X’s supported composer link with the draft filled in. Review it and press Post yourself. xpost does not automate the X website.
- **Dry run:** generates and saves a draft without calling X.

Reading public X posts also depends on the selected source and its availability. `nitter` uses third-party public RSS mirrors, which may be incomplete or unavailable. `api` uses official X search and may incur charges. You can also draft from a topic without collecting posts.

## Local setup

Requirements: Node.js 20 or newer, a Gemini API key, and X API credentials if you want direct API posting.

```powershell
npm install
Copy-Item .env.example .env
```

Fill in `.env`, then run:

```powershell
npm run doctor
npm run dry -- --topic "A short update about what I'm building"
npm run ui
```

The dashboard is at `http://127.0.0.1:4321`. To post directly, select **X API** and confirm the publish prompt. To use the manual route, select **X composer**, then review and submit in X.

## Public dashboard

For Render deployment, follow [DEPLOY.md](DEPLOY.md). For a Vercel deployment with hourly browser notifications and manual X review, follow [VERCEL_SETUP.md](VERCEL_SETUP.md). Both public dashboards require a separate password. Vercel keeps draft history in the current browser; Render's free filesystem is temporary.

## Useful commands

```powershell
npm start -- --topic "A topic for the post"  # review and publish from terminal
npm run dry -- --topic "A topic for the post" # generate/save only
npm run whoami                                # verify X API credentials
npm run scoop -- --topic "web development"    # collect research context
npm run history                               # list saved drafts and posts
```

Set `XPOST_MANUAL=1` to make CLI publishing prepare the composer instead of calling the API. Keep `.env` and API credentials private. The dashboard password and signing secret are separate from X and Gemini keys.
