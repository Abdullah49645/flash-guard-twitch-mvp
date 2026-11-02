# Flash Guard

Flash Guard is a local moderator desk for viewer-submitted Twitch media. A submission stays out of OBS until a moderator explicitly approves it. Automated results are screening signals; the tool does not establish that a clip is safe, legal, Twitch-compliant, or authorized by a rights holder.

The included walkthrough uses synthetic local test media and demonstrates local scanning, moderator approval, and the OBS browser overlay. It does not show a live Twitch connection; Twitch chat intake requires the optional credentials below. The sample has no audio track, so it does not demonstrate audio matching.

## What the MVP checks

| Check | Implementation | What a result means |
|---|---|---|
| Rapid flashes | FFmpeg samples frame-average luma at 12 fps and counts opposing transitions. | A coarse, WCAG-inspired signal. It does not measure flash area, saturated-red flashes, or every WCAG threshold. It can miss brief events and is not medical certification. |
| Sexual / graphic visual content | Local ONNX model `OwenElliott/image-safety-classifier-s`; one 224×224 RGB frame per second, CPU inference. It returns NSFW (sexual), NSFL (graphic/gore), and SFW scores. | Scores at or above `VISUAL_SIGNAL_THRESHOLD` (default `0.5`) are shown as a signal for moderator review. The threshold is an MVP setting, not a calibrated boundary. NSFL training data is underrepresented; false positives and false negatives are expected. One frame per second can miss brief events. |
| Possible audio recording match | `fpcalc`/Chromaprint creates an audio fingerprint; an optional registered AcoustID application key sends that fingerprint and duration to AcoustID lookup. | A match identifies a possible recording in AcoustID/MusicBrainz metadata. It cannot decide ownership, licensing, fair use, or permission. No match does not mean copyright-free: the database is incomplete and covers audio only. |

The visual model is pinned to Hugging Face commit `eb8b0b203952b70db191e990217174af4af39767`; the setup command verifies its SHA-256 before loading it. The upstream model card declares MIT licensing and describes the dataset and NSFL limitation. Flash Guard keeps model inference local; the original clip and extracted frames are temporary and deleted after analysis. The AcoustID lookup is a separate, optional third-party network request. The public AcoustID web service is for non-commercial use and is rate-limited; use an appropriate service/account for other use.

An unavailable check remains visible in the scan details and keeps the item out of automatic playback. A “no signal” result is not clearance. A moderator must review and approve each item.

## Supported media and handling

- Public HTTPS direct `.mp4` links only. Twitch Clips, YouTube, social links, playlists, and arbitrary media pages are not supported.
- DNS results are checked and pinned, private/restricted IPs and redirects are rejected, and download bytes are capped.
- Defaults: 25 MB, 120 seconds, 1920 px per dimension, 3600 source-frame estimate. Settings are in `.env.example`.
- The dashboard preview is user-controlled and does not autoplay. The OBS route serves the exact downloaded bytes that were screened, only after moderator approval, and has a clear control. It does not re-fetch the source URL at playback time.
- Local MP4 uploads make the complete scan/review/OBS path usable without Twitch credentials or a public media host. The bytes are kept in `data/media` while awaiting review and while approved for playback; Reject and Clear delete them. Held items remain available for later review. Queue decisions, scan outcomes, Twitch replies/events, and playback events are written to `data/queue.json`; names and source URLs are retained in the audit history.

## Requirements and setup

- Node.js 22 or newer.
- FFmpeg with `ffprobe`; Chromaprint `fpcalc` for the audio check.
- Internet access once to download the pinned model. Inference itself runs locally.
- A registered AcoustID application key to run database lookups. Without it, that check is explicitly unavailable.

Install the media tools on macOS with Homebrew:

```sh
brew install ffmpeg chromaprint
```

Install JavaScript dependencies, download and verify the model, and configure the service:

```sh
npm run setup
cp .env.example .env
# Edit .env; Twitch and AcoustID configuration are described below.
npm start
```

Open <http://127.0.0.1:4173>. Add an OBS Browser Source at <http://127.0.0.1:4173/overlay>. Keep `HOST=127.0.0.1` for a same-machine setup.

To try the real scan without Twitch or external hosting, choose an MP4 in **Local intake → Scan MP4**. It goes through the same FFprobe limits, flash measurement, local visual model and optional audio lookup as a Twitch submission. Select the item, wait for the checks to finish, inspect the paused preview, and explicitly approve it to make it available in OBS. Use Clear in OBS to dismiss it. Unsupported or over-limit uploads remain blocked and show the reason.

## Optional audio match setup

Register an application with [AcoustID](https://acoustid.org/webservice) and put its application key in the server-only `.env` file:

```dotenv
ACOUSTID_CLIENT_KEY=your_registered_application_key
```

The service sends AcoustID the Chromaprint fingerprint and duration, not the MP4. The lookup returns possible track metadata and a match score. An empty result is not a copyright clearance. This check does not fingerprint video frames or compare against every label, publisher, or rights-holder catalog.

## Optional Twitch setup

You do **not** need to stream, be Affiliate, or be Partner. A Twitch account/channel is only needed to exercise the chat connector. You can build and demo scanning with the local upload above without signing in to Twitch.

For the real chat path, create or use a regular Twitch account, verify its email, enable 2FA, and register a Twitch developer application. Set its OAuth redirect URL to `http://localhost:3000`. Install the official Twitch CLI and configure it with the app's Client ID and Client Secret. Generate a user token for the account whose channel chat you want to test:

```sh
brew install twitchdev/twitch/twitch-cli
twitch configure
twitch token --user-token --scopes "user:read:chat user:write:chat"
```

The CLI opens a browser authorization page and prints an access token, refresh token, expiry, and granted scopes. Put the access token in `TWITCH_USER_ACCESS_TOKEN` in `.env`. Query `https://api.twitch.tv/helix/users` with `Client-Id: <your client id>` and `Authorization: Bearer <your access token>` to get the account's `id` and `login`; for a simple single-account test, use that same ID for `TWITCH_BROADCASTER_ID` and `TWITCH_BOT_USER_ID`, and the login for `TWITCH_CHANNEL_LOGIN`. The app creates the EventSub WebSocket subscription on connection. Keep all tokens and the client secret private; do not paste them into chat or commit `.env`.

- `user:read:chat` for EventSub `channel.chat.message` over WebSocket.
- `user:write:chat` for Helix Send Chat Message replies.

Set the server-only `.env` values `TWITCH_CLIENT_ID`, `TWITCH_USER_ACCESS_TOKEN`, `TWITCH_BROADCASTER_ID`, `TWITCH_BOT_USER_ID`, and `TWITCH_CHANNEL_LOGIN`. On a fresh WebSocket session the service creates the subscription; on Twitch's session-reconnect message it transfers the existing session without creating a duplicate subscription. Duplicate chat message IDs are ignored. Send `!media <public-direct-mp4-url>` in the configured channel. The dashboard distinguishes an unconfigured or failed Twitch connection from a connected one. A chat submission URL must be reachable by this computer and be a direct public HTTPS `.mp4` URL.

## Real Twitch demo

1. Install the requirements, run `npm install`, and `npm run setup:model`.
2. Put Twitch credentials and, if using audio matching, your AcoustID app key in `.env`; run `npm start`.
3. Confirm the dashboard reports the intended Twitch channel connected and shows the visual model ready locally. If the AcoustID key is absent, the dashboard reports that audio lookup needs a key.
4. In Twitch chat, send `!media https://your-host.example/sample.mp4` using a public direct MP4 within configured limits.
5. Review the scan’s flash measurements, per-category model scores, frame sample count, and audio match result or unavailable reason. Use the paused dashboard preview for human review.
6. Approve, reject, or hold the submission. Only Approve makes the current item available to the OBS Browser Source. Verify the “Moderator approved” label and use Clear to dismiss it.
7. Record the Twitch submission, actual scan details, moderator decision, and overlay state. Do not describe dashboard-only intake as a live Twitch demo or describe a no-match result as copyright clearance.

## Official references and model provenance

- [Twitch EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) and [chat send/receive](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [Register a Twitch app](https://dev.twitch.tv/docs/authentication/register-app), [Twitch CLI install](https://dev.twitch.tv/docs/cli/), and [CLI user-token command](https://dev.twitch.tv/docs/cli/token-command/)
- [W3C WCAG 2.2, Three Flashes or Below Threshold](https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold)
- [Image safety model card: classes, ONNX input, training-data notes, and license](https://huggingface.co/OwenElliott/image-safety-classifier-s)
- [AcoustID lookup API and usage terms](https://acoustid.org/webservice)
- [Chromaprint scope and design tradeoffs](https://github.com/acoustid/chromaprint)

## Current verification limits

The model file and local ONNX inference were verified during setup on this Apple Silicon Mac. FFmpeg and Chromaprint were installed. A live Twitch flow still requires the user's Twitch credentials and a real direct MP4 URL. The AcoustID branch requires a registered application key and a network lookup. Results remain advisory, and the visual classifier only sees one sampled frame per second.

Main Codex build session ID: `01a19372-07ea-7340-96d6-80ea3e139df8`.
