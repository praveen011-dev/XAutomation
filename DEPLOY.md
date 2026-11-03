# Deploy xpost on Render

This deploys the password-protected xpost dashboard to a public HTTPS URL. The dashboard password is separate from your X and Gemini credentials. The included Blueprint uses Render’s free web service for a no-cost trial. Render free services sleep after 15 minutes without traffic and can take about a minute to wake; choose an always-on paid plan in Render if you need immediate access at all times. [Render free service limits](https://render.com/docs/free)

## 1. Put the project in a Git repository

Push this folder to a private GitHub repository. Check that `.env` and `drafts/` are ignored before pushing; never add API keys to Git.

## 2. Create the Render service

In Render, choose **New → Blueprint**, connect the repository, and apply the included `render.yaml`. Render will create the web service and generate `XPOST_UI_SECRET`.

## 3. Add the service secrets

In the service’s **Environment** settings, set:

- `XPOST_UI_PASSWORD`: choose a unique password with at least 12 characters. This is the dashboard sign-in password.
- `GEMINI_API_KEY`: your Google AI Studio key, for AI drafting.
- `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`: your X developer App credentials, if you want direct API posting. The app must have write access and X API credits.

Save the settings and let Render redeploy. The generated `XPOST_UI_SECRET` signs the browser session cookie; keep it private and stable across deploys.

## 4. Open and test the dashboard

Open the `onrender.com` URL shown by Render, sign in with `XPOST_UI_PASSWORD`, draft with a topic, and save a draft. Choose **X composer** to open a prefilled X composer and press Post there, or choose **X API** to publish directly (X may charge API credits). X account verification in the dashboard needs the OAuth 1.0a keys and tokens above.

## Storage on the free plan

Render’s free web service has an ephemeral filesystem. Drafts and history can disappear after a restart, redeploy, or spin-down. For durable drafts, use a paid Render service with a persistent disk and set `XPOST_DRAFTS_DIR` to the disk mount path, such as `/var/data/drafts`. Render only supports persistent disks on paid services. The included blueprint does not attach a disk or start paid resources. [Render disk docs](https://render.com/docs/disks)

## Updating the deployment

Push changes to the connected Git branch. Render builds with `npm ci`, starts with `npm run ui`, and checks `/api/health`. Keep `XPOST_UI_HOST=0.0.0.0`; the app uses Render’s `PORT` automatically.
