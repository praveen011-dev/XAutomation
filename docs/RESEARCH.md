# Research: Twitter (X) Post Automation with AI Drafts

Collected: October 19, 2026
Purpose: build a CLI command that drafts a daily tweet (AI-generated, based on my coding
activity or the tech industry), shows it to me for approval, optionally attaches an
AI-generated image, and only then posts it to X.

---

## 1. Local environment

| Tool   | Version             |
|--------|---------------------|
| Node   | v20.20.2            |
| npm    | 10.8.2              |
| Python | 3.14.7              |
| git    | 2.53.0 (Windows, Git Bash) |

- Working folder: `/d/twitter automation` — currently empty except `.freebuff/`.
- Not a git repository.

---

## 2. Posting to X — API, auth, endpoints

**Sources:** [Create Posts](https://docs.x.com/x-api/posts/create-post) ·
[v2 authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping) ·
[Media upload v2](https://docs.x.com/x-api/media/upload-media) ·
[Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked) ·
[Media limits](https://docs.x.com/x-api/media/introduction) ·
[API key & secret](https://docs.x.com/fundamentals/authentication/oauth-1-0a/api-key-and-secret)

### Flow

1. **Upload the image first** → get a `media_id`.
   - Established route: v1.1 `media/upload` (works with OAuth 1.0a).
   - Newer route: v2 `POST /2/media/upload` (simple) or the chunked
     `initialize` / `append` / `finalize` sequence; v2 upload wants an
     OAuth 2.0 user token with the `media.write` scope.
2. **Create the post:** `POST https://api.x.com/2/tweets` with
   `{ "text": "...", "media": { "media_ids": ["..."] } }`.
   Up to 4 photos per post.

### Auth requirements

- **OAuth 1.0a user context** (4 values) is the simplest route for a CLI:
  1. API key (consumer key)
  2. API secret (consumer secret)
  3. Access token (for the posting account)
  4. Access token secret
- Alternative: **OAuth 2.0 Authorization Code + PKCE** with scopes
  `tweet.write`, `media.write`, and `offline.access` (refresh tokens;
  access tokens expire after ~2 hours by default).
- **App-only bearer tokens cannot post on a user's behalf** — a user-context
  token is mandatory.
- In the Developer Console the App's permissions must be set to
  **Read and write**, and the access token must be **regenerated after**
  changing permissions so it carries the new permission.

### Pricing / tiers (⚠️ changed in 2026)

**Source:** [X API pricing](https://docs.x.com/x-api/getting-started/pricing) ·
[X API changelog](https://docs.x.com/changelog) ·
[Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)

- Current docs describe **pay-per-use with credits**, not a general Free tier:
  **$0.015 per Post create**, **$0.20 for a Post containing a URL**.
- A legacy Free tier (monthly write allowance) may still exist on older
  developer accounts — check the Developer Console; do not design around it.
- **Rate limits are separate from billing:**
  - `POST /2/tweets`: 100 / user / 15 min, 10,000 / app / 24 h
  - `POST /2/media/upload`: 500 / user / 15 min, 50,000 / app / 24 h
  - Docs are internally inconsistent (manage-tweets guide says 200 / 15 min);
    trust the rate-limit headers in real responses.
- **Media limits:** 5 MB max; JPG, PNG, GIF, WEBP.
  Source: [Media best practices](https://docs.x.com/x-api/media/quickstart/best-practices)

### Library: `twitter-api-v2` (npm)

- Still maintained — latest release **1.29.1** (Aug 4, 2026): OAuth nonce /
  PKCE randomness fixes.
  Sources: [repo](https://github.com/plhery/node-twitter-api-v2) ·
  [releases](https://github.com/plhery/node-twitter-api-v2/releases) ·
  [examples](https://github.com/plhery/node-twitter-api-v2/blob/master/doc/examples.md)
- X also ships a first-party TypeScript XDK, but `twitter-api-v2` is the
  established community wrapper and covers v1.1 media upload + v2 posting.

Working example (OAuth 1.0a + media):

```js
import { TwitterApi } from 'twitter-api-v2';

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_KEY_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const mediaId = await client.v1.uploadMedia('./photo.jpg');
const { data } = await client.v2.tweet({
  text: 'Photo of the day',
  media: { media_ids: [mediaId] },
});
console.log(`Posted: https://x.com/i/status/${data.id}`);
```

Useful extras: `client.v2.me()` (verify credentials → `@username`),
`client.v1.uploadMedia(path)`.

---

## 3. AI text generation — provider comparison

**Sources:** [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing.md.txt) ·
[Gemini models](https://ai.google.dev/gemini-api/docs/models) ·
[Gemini text generation](https://ai.google.dev/gemini-api/docs/text-generation) ·
[Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key) ·
[Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) ·
[Groq overview](https://console.groq.com/docs/overview) ·
[Groq billing FAQ](https://console.groq.com/docs/billing-faqs) ·
[OpenRouter pricing](https://openrouter.ai/pricing) ·
[OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) ·
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

| Provider | Free tier? | Card needed? | Notes |
|---|---|---|---|
| **Google Gemini** ✅ | Yes — e.g. **Gemini 3.8 Flash** text is free-tier | No explicit card requirement documented for free tier | **Best all-in-one pick:** free text + same key can do images (paid) |
| **Groq** | Yes, model-specific rate limits | Card only when upgrading Free → Developer | Fast, OpenAI-compatible, **text only** |
| **OpenRouter** | Yes — 25+ free models, **20 req/min, 50/day** (1,000/day after $10 credits) | No for free plan | One OpenAI-compatible gateway, many models |
| **Anthropic** | Small one-time trial credit only | Not verified | Paid afterwards (Haiku ~$0.10/M in, $0.50/M out) |
| **OpenAI** | Treat as paid, usage-based | Not verified (docs page failed to load) | Fine if already paying |

**Gravity Index search** (search_id `b4f76dfd-…`) recommended **OpenLLM**
(https://openllm.sh) — a paid gateway that fronts your own OpenAI/Anthropic
keys behind one endpoint. Useful only if juggling multiple provider keys;
unnecessary for this project since we only need one provider.

### Current Gemini model IDs (confirmed on the models page, Oct 2026)

Text (all usable via REST `POST /v1beta/models/{id}:generateContent`):

- `gemini-3.8-flash` — current stable Flash, **free tier** → default choice
- `gemini-3.6-flash` — previous-gen Flash
- `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite` — cheapest/fastest
- `gemini-4-argon` — flagship
- `gemini-2.5-flash` etc. — still served but access limited to accounts that
  used them before; new projects should use 3.5/3.8

Image:

- `gemini-nano-banana-2.1` — primary image model (recommended for new work)
- `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image`
  (2 Lite), `gemini-3-pro-image` (Pro), `gemini-2.5-flash-image` (legacy)

---

## 4. AI image generation — options

**Sources:** [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation) ·
[Pollinations repo](https://github.com/pollinations/pollinations) ·
[Pollinations legacy-endpoint discussion](https://github.com/pollinations/pollinations/issues/6409) ·
[Stability pricing](https://platform.stability.ai/pricing) ·
[OpenAI images guide](https://developers.openai.com/api/docs/guides/image-generation)

| Option | Free? | Setup | Verdict |
|---|---|---|---|
| **Gemini Nano Banana 2.1** ✅ | No — ~$0.034 / 1K image (paid API; no free image tier) | Same `GEMINI_API_KEY` as text | **Best fit:** one key, square output by default, documented REST call |
| Pollinations (`gen.pollinations.ai`) | Pay-as-you-go "Pollen" credits now; **the old no-key `image.pollinations.ai` endpoint is legacy/deprecated** | API key from enter.pollinations.ai | Don't build on the no-key endpoint; may still work but unsupported |
| OpenAI Images (`gpt-image-1`) | Paid | `POST https://api.openai.com/v1/images/generations` | Reasonable if already paying; docs failed to load during research |
| Stability AI | 25 free trial credits (1 credit = $0.01) | `POST https://v2beta/stable-image/generate/ultra` | Docs pages were JS shells — terms unverified |
| Google Imagen | Unverified | — | Could not confirm current endpoint/pricing |

All generated Gemini images carry a **SynthID watermark**.

### Gemini image REST call (confirmed, works without the SDK)

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-nano-banana-2.1",
    "input": [ { "type": "text", "text": "A clean square illustration of …" } ]
  }'
# response → interaction.output_image.data (base64 PNG)
```

JS equivalent uses `@google/genai`'s `ai.interactions.create({ model, input })`
→ `result.output_image.data`. A plain `fetch` to the REST endpoint avoids the
SDK dependency entirely.

---

## 5. Recommended stack for this project

- **Runtime:** Node.js 20 (already installed), ESM, zero-dep except
  `twitter-api-v2`.
- **Text:** Gemini `gemini-3.8-flash` via REST (`x-goog-api-key` header),
  free tier.
- **Image (optional `--image` flag):** Gemini `gemini-nano-banana-2.1` via
  `/v1beta/interactions` (paid, ~3.4¢/image) — text-only is the default so the
  tool costs nothing to run day-to-day.
- **Posting:** `twitter-api-v2` with OAuth 1.0a, v1.1 `uploadMedia` +
  `v2.tweet`.
- **Activity source:** `git log --since=midnight` in the current (or
  configured) repo(s), filtered by `git config user.email`; if there are no
  commits today, the AI writes an honest tech-industry / off-day post instead
  of inventing work.
- **Approval gate:** interactive terminal prompt —
  `[p]ost / [e]dit / [r]egenerate / [q]uit`, plus a `--dry-run` mode that can
  never reach the X API. Nothing posts without an explicit `p`.

### Credentials needed (to go in `.env`, never committed)

```
X_API_KEY=            X_API_KEY_SECRET=
X_ACCESS_TOKEN=       X_ACCESS_TOKEN_SECRET=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash            # optional override
GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
TWEET_REPOS=          # optional comma-separated repo paths
```

---

## 6. Open questions / could not verify

- Whether **this** developer account still has a Free X tier (or must pay
  $0.015/post) — only visible in the Developer Console.
- OpenAI API current prices / card requirements (official pages failed to load).
- Stability AI live parameters and trial terms (pages were JS shells).
- Whether the legacy Pollinations no-key image endpoint still responds.
- A current Imagen-specific endpoint.
