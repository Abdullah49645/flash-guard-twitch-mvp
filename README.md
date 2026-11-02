# Flash Guard

**A moderator-controlled review gate for viewer-submitted Twitch media.**

Built for the [Codex x TwitchCon Hackathon](https://twitchcon-codex.devpost.com/), Flash Guard screens submitted MP4s and keeps them out of an OBS browser overlay until a moderator explicitly approves playback.

## Project status

The recorded walkthrough demonstrates the local upload, screening, moderator approval, and OBS overlay flow using synthetic test media. It does not demonstrate a live Twitch connection. Twitch chat intake is implemented as an optional EventSub integration and requires the broadcaster's Twitch app credentials. Audio matching also requires an AcoustID application key; the synthetic walkthrough sample contains no audio track.

## How it works

1. A viewer submits a direct MP4 URL in Twitch chat with `!media`, or a moderator uploads an MP4 through the local dashboard.
2. Flash Guard retrieves the media within configured limits and runs the available screening checks.
3. A moderator reviews the results and paused preview, then approves, rejects, or holds the submission.
4. Only an approved submission is made available to the OBS browser overlay. The moderator can clear playback from the overlay.

## Screening checks

| Check | Implementation | What the result means |
| --- | --- | --- |
| Rapid flashes | FFmpeg samples frame-average luminance at 12 fps and counts opposing transitions. | A coarse screening signal. It does not evaluate every WCAG threshold or replace medical assessment. |
| Sexual or graphic imagery | A local ONNX image-safety model scores one sampled frame per second. | Advisory model scores for moderator review, not a policy verdict. Sampling can miss brief content; false positives and false negatives are expected. |
| Possible audio recording match | Optional Chromaprint fingerprint lookup through AcoustID. | A database match may identify a recording. It cannot determine copyright ownership, permission, licensing, or fair use. No match is not copyright clearance. |

Unavailable checks remain visible. A missing signal is not a safety or rights clearance; the moderator remains responsible for the playback decision.

## Run locally

### Requirements

- Node.js 22 or newer
- FFmpeg with `ffprobe`
- Chromaprint `fpcalc` for audio fingerprinting
- macOS users can install the media tools with Homebrew:

```sh
brew install ffmpeg chromaprint
```

### Install and start

```sh
npm ci
npm run setup:model
cp .env.example .env
npm start
```

The setup script downloads the pinned ONNX model and verifies its checksum. Open the dashboard at <http://127.0.0.1:4173>. The OBS browser source is <http://127.0.0.1:4173/overlay>.

To try the local workflow without Twitch credentials, upload an MP4 under **Local intake**. The same screening and moderator-review flow is used. Keep `HOST=127.0.0.1` for a same-machine setup.

## Optional integrations

### Twitch chat

Configure a Twitch developer application and a user access token with the chat scopes required by Twitch. Set the corresponding `TWITCH_*` values in the server-only `.env` file; see [.env.example](.env.example) and [Twitch's chat documentation](https://dev.twitch.tv/docs/chat/send-receive-messages/). Once connected, send `!media <public-direct-mp4-url>` in the configured channel. The URL must be directly reachable over HTTPS and point to an MP4; Twitch Clips, YouTube, and arbitrary media pages are not supported.

### Audio matching

Set `ACOUSTID_CLIENT_KEY` in `.env` to enable the optional AcoustID lookup. The service sends the audio fingerprint and duration, not the MP4. The public AcoustID web service is rate-limited and intended for non-commercial use; see [AcoustID's terms](https://acoustid.org/webservice).

## Media handling and limitations

- Default retrieval limits are 25 MB, 120 seconds, 1920 pixels per dimension, and 3600 estimated source frames. Configure these in `.env`.
- Public URL retrieval validates DNS results, rejects private or restricted IPs and redirects, and enforces a byte limit.
- Visual inference runs locally. The video is sampled at one frame per second for the image model, so brief events can be missed.
- Possible audio matches cover only the AcoustID/MusicBrainz catalog. The catalog is incomplete and a match is not a legal determination.
- Review history is stored locally in `data/`. Uploaded media is retained while pending or approved; Reject and Clear remove it.
- Automated results are advisory. Flash Guard does not certify content as safe, Twitch-compliant, licensed, or authorized.

## Project files

- `server.mjs` — local dashboard server, screening pipeline, Twitch EventSub integration, and API routes
- `app.js`, `index.html`, `styles.css` — moderator dashboard
- `overlay.html` — OBS browser overlay
- `scripts/setup-model.mjs` — pinned model download and checksum verification
- `.env.example` — configuration template with empty credential fields

## Built with Codex

Codex was used to build and refine the application, local screening pipeline, Twitch integration, and documentation.

**Codex session ID:** `01a19372-07ea-7340-96d6-80ea3e139df8`

## License

Released under the MIT License. See [LICENSE](LICENSE).
