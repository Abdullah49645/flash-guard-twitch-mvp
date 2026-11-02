import http from 'node:http';
import * as fsSync from 'node:fs';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const envFile = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const dataDir = path.join(root, 'data');
const mediaDir = path.join(dataDir, 'media');
const dbFile = path.join(dataDir, 'queue.json');
const MAX_BYTES = Number(process.env.MAX_MEDIA_BYTES || 25_000_000);
const MAX_DURATION = Number(process.env.MAX_DURATION_SECONDS || 120);
const MAX_DIM = Number(process.env.MAX_DIMENSION || 1920);
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 3600);
const VISUAL_SIGNAL_THRESHOLD = Number(process.env.VISUAL_SIGNAL_THRESHOLD || 0.5);
const command = process.env.TWITCH_COMMAND || '!media';
const modelPath = path.join(root, 'models', 'image-safety-classifier-s.onnx');
const modelSha256 = 'fef443ed68ae25ed693b6fef9e456071692ed3963cff4168acb39c3de6f017e7';

let db = { items: [], seen: [], history: [], playback: null };
let twitchState = { connected: false, message: 'Configure Twitch credentials in .env to connect.' };
let socket = null;
let reconnectTimer = null;
let retryMs = 1000;
let ort = null;
let visualSession = null;
let visualStatus = 'Model unavailable. Run npm run setup:model.';
let acoustidQueue = Promise.resolve();

await fs.mkdir(mediaDir, { recursive: true });
try { db = { ...db, ...JSON.parse(await fs.readFile(dbFile, 'utf8')) }; } catch {}
function log(type, item, detail = {}) {
  db.history.unshift({ id: crypto.randomUUID(), type, itemId: item?.id || null, submitter: item?.submitter || 'Flash Guard', at: new Date().toISOString(), detail });
  db.history = db.history.slice(0, 500);
}
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    await fs.rename(tmp, dbFile);
  }).catch(e => console.error('Persistence error:', e.message));
  return writeQueue;
}
function sendJson(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function body(req) {
  let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 16_000) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
function eventStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const timer = setInterval(() => { if (!res.destroyed) res.write(`data: ${JSON.stringify(snapshot())}\n\n`); }, 1500);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  res.on('close', () => clearInterval(timer));
}
function snapshot() { return { items: db.items, history: db.history.slice(0, 100), playback: db.playback, twitch: twitchState, scanner: { flash: 'FFmpeg frame-luma screening', visual: visualStatus, copyright: process.env.ACOUSTID_CLIENT_KEY ? 'AcoustID audio matching configured' : 'AcoustID lookup not configured' } }; }

function withTimeout(p, ms, label) { return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]); }
function run(bin, args, options = {}) {
  const { timeoutMs = 30_000, maxStdout = 65_000_000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let chunks = [], stdoutLength = 0, stderr = '', settled = false;
    child.stdout.on('data', d => { chunks.push(d); stdoutLength += d.length; if (stdoutLength > maxStdout) child.kill(); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 10000) stderr = stderr.slice(-10000); });
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    child.on('close', code => { if (settled) return; settled = true; code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr.trim() || `${bin} exited ${code}`)); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); if (!settled) { settled = true; reject(new Error(`${bin} timed out`)); } }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
  });
}
async function initializeVisualModel() {
  if (visualSession && ort) return;
  try {
    const bytes = await fs.readFile(modelPath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== modelSha256) throw Error('Local model checksum does not match the pinned model. Run npm run setup:model again.');
    ort = await import('onnxruntime-node');
    visualSession = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    visualStatus = 'Ready: OwenElliott image-safety-classifier-s (CPU, local inference).';
  } catch (e) { visualStatus = e.code === 'ENOENT' ? 'Model unavailable. Run npm run setup:model.' : `Model unavailable: ${e.message}`; }
}
async function scanVisualVideo(file, duration) {
  await initializeVisualModel();
  if (!visualSession || !ort) return { name: 'Visual content-risk model', status: 'Unavailable', scores: null, risk: null, measured: null, explanation: `${visualStatus} No media is sent to a cloud classifier.` };
  const frames = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=224:224,fps=1,format=rgb24', '-frames:v', String(Math.min(MAX_DURATION, Math.ceil(duration))), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeoutMs: 120_000, maxStdout: 42_000_000 });
  const framePixels = 224 * 224, frameBytes = framePixels * 3, count = Math.floor(frames.length / frameBytes);
  if (!count) throw Error('Visual model received no decoded sample frames.');
  let maxSexual = 0, maxGraphic = 0, maxSfw = 0, sexualAt = null, graphicAt = null, sexualSignals = 0, graphicSignals = 0;
  const inputName = visualSession.inputNames[0], outputName = visualSession.outputNames[0];
  for (let frame = 0; frame < count; frame++) {
    const start = frame * frameBytes, input = new Float32Array(3 * framePixels);
    for (let pixel = 0; pixel < framePixels; pixel++) {
      const src = start + pixel * 3;
      input[pixel] = frames[src]; input[framePixels + pixel] = frames[src + 1]; input[2 * framePixels + pixel] = frames[src + 2];
    }
    const output = await visualSession.run({ [inputName]: new ort.Tensor('float32', input, [1, 3, 224, 224]) });
    const scores = output[outputName]?.data;
    if (!scores || scores.length !== 3 || Array.from(scores).some(x => !Number.isFinite(x))) throw Error('Visual model returned unexpected scores.');
    const graphic = Number(scores[0]), sexual = Number(scores[1]), sfw = Number(scores[2]);
    if (sexual > maxSexual) { maxSexual = sexual; sexualAt = frame; }
    if (graphic > maxGraphic) { maxGraphic = graphic; graphicAt = frame; }
    if (sfw > maxSfw) maxSfw = sfw;
    if (sexual >= VISUAL_SIGNAL_THRESHOLD) sexualSignals++;
    if (graphic >= VISUAL_SIGNAL_THRESHOLD) graphicSignals++;
  }
  const risks = [];
  if (maxSexual >= VISUAL_SIGNAL_THRESHOLD) risks.push('Potential sexual-content signal');
  if (maxGraphic >= VISUAL_SIGNAL_THRESHOLD) risks.push('Potential graphic-content signal');
  return {
    name: 'Visual content-risk model', status: 'Ran',
    scores: { sexual: Number(maxSexual.toFixed(4)), graphic: Number(maxGraphic.toFixed(4)), sfw: Number(maxSfw.toFixed(4)) },
    measured: { model: 'OwenElliott/image-safety-classifier-s', sampledFrames: count, sampleRateFps: 1, sampleIntervalSeconds: 1, signalThreshold: VISUAL_SIGNAL_THRESHOLD, sexualSignalFrames: sexualSignals, graphicSignalFrames: graphicSignals, highestSexualScoreAtSeconds: sexualAt, highestGraphicScoreAtSeconds: graphicAt },
    risk: risks.length ? risks.join('; ') : null,
    explanation: `Local frame classifier scores NSFW (sexual) and NSFL (graphic/gore). Highest sample scores are advisory model outputs, not probabilities of policy violation. Samples one frame per second, so brief content may be missed. The model card reports an underrepresented NSFL training class; false positives and false negatives are expected.`
  };
}
function fingerprintLookup(duration, fingerprint) {
  const client = process.env.ACOUSTID_CLIENT_KEY;
  if (!client) return Promise.resolve({ name: 'Possible copyrighted-audio match', status: 'Unavailable', scores: null, risk: null, measured: null, explanation: 'Set ACOUSTID_CLIENT_KEY to enable a fingerprint lookup. No rights conclusion can be made without a match.' });
  const job = acoustidQueue.then(async () => {
    const wait = Math.max(0, 450 - (Date.now() - (fingerprintLookup.lastAt || 0)));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    fingerprintLookup.lastAt = Date.now();
    const form = new URLSearchParams({ client, duration: String(duration), fingerprint, meta: 'recordings' });
    const response = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw Error(`AcoustID returned HTTP ${response.status}.`);
    const data = await response.json();
    if (data.status !== 'ok') throw Error('AcoustID lookup did not complete successfully.');
    const matches = (data.results || []).map(result => ({ score: Number(result.score), id: result.id, recording: result.recordings?.[0] })).filter(x => x.recording).sort((a, b) => b.score - a.score).slice(0, 5);
    if (!matches.length) return { name: 'Possible copyrighted-audio match', status: 'Ran', scores: null, risk: null, measured: { databaseMatches: 0 }, explanation: 'No recording match was returned from AcoustID. The database is incomplete; this is not evidence that the audio is copyright-free or authorized.' };
    const best = matches[0], recording = best.recording, artists = (recording.artists || []).map(x => x.name).join(', ');
    return { name: 'Possible copyrighted-audio match', status: 'Ran', scores: null, risk: 'Audio recording match found; review rights and context', measured: { databaseMatches: matches.length, bestMatchScore: Number(best.score.toFixed(3)), title: recording.title || 'Unknown title', artist: artists || 'Unknown artist', musicBrainzRecordingId: recording.id }, matches: matches.map(x => ({ score: Number(x.score.toFixed(3)), title: x.recording.title || null, artist: (x.recording.artists || []).map(a => a.name).join(', ') || null, musicBrainzRecordingId: x.recording.id })), explanation: 'Chromaprint audio fingerprint matched a recording in AcoustID/MusicBrainz metadata. This identifies a possible recording only; it cannot establish copyright ownership, licensing, fair use, or permission.' };
  });
  acoustidQueue = job.catch(() => {});
  return job;
}
function allowedIp(ip) {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (v === 'localhost' || v === '::1' || v === '::' || v === '0.0.0.0') return false;
  if (v.includes(':')) return !/^(fc|fd|fe[89ab])/.test(v);
  const n = v.split('.').map(Number);
  if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = n;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}
async function safeUrl(value) {
  let u; try { u = new URL(value); } catch { throw Error('Malformed URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Only public HTTPS direct MP4 links are supported.');
  if (!u.pathname.toLowerCase().endsWith('.mp4')) throw Error('Unsupported link: provide a direct .mp4 file. Twitch clips and social links are not retrieved.');
  const addresses = await (await import('node:dns/promises')).lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(x => !allowedIp(x.address))) throw Error('Link resolves to a private or restricted network address.');
  return { url: u, address: addresses[0].address };
}
function safeFetch(target, timeoutMs = 15_000) {
  const { url, address } = target;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'FlashGuard/0.1' }, lookup: (_host, _opts, cb) => cb(null, address, address.includes(':') ? 6 : 4) }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Media host timed out.')));
    req.on('error', reject);
  });
}
async function retrieveAndScan(item) {
  let temp, removeTemp = true, mediaValidated = false;
  try {
    if (item.source === 'upload') {
      temp = mediaPath(item.id);
      removeTemp = false;
    } else {
      const target = await safeUrl(item.url);
      const response = await withTimeout(safeFetch(target), 16_000, 'Download timed out.');
      if (response.statusCode !== 200) throw Error(`Media host returned HTTP ${response.statusCode}.`);
      const ct = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && !['video/mp4', 'application/octet-stream'].includes(ct)) throw Error(`Unsupported content type: ${ct}.`);
      const len = Number(response.headers['content-length'] || 0);
      if (len > MAX_BYTES) throw Error(`File exceeds ${MAX_BYTES} byte limit.`);
      const parts = []; let total = 0;
      for await (const chunk of response) { total += chunk.length; if (total > MAX_BYTES) { response.destroy(); throw Error(`File exceeds ${MAX_BYTES} byte limit.`); } parts.push(chunk); }
      if (!total) throw Error('The downloaded file is empty.');
      temp = path.join(os.tmpdir(), `flashguard-${crypto.randomUUID()}.mp4`);
      await fs.writeFile(temp, Buffer.concat(parts), { mode: 0o600 });
    }
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temp])).toString('utf8'));
    const video = probe.streams?.find(s => s.codec_type === 'video');
    if (!video) throw Error('No video stream was found.');
    const width = Number(video.width), height = Number(video.height), duration = Number(probe.format?.duration || video.duration || 0), fpsParts = String(video.r_frame_rate || '0/1').split('/').map(Number), fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : 0;
    if (!width || !height || width > MAX_DIM || height > MAX_DIM) throw Error(`Video dimensions exceed ${MAX_DIM}px limit or could not be read.`);
    if (!duration || duration > MAX_DURATION) throw Error(`Video duration exceeds ${MAX_DURATION}s limit or could not be read.`);
    const frames = Math.ceil(duration * fps);
    if (frames > MAX_FRAMES) throw Error(`Estimated frame count (${frames}) exceeds ${MAX_FRAMES} limit.`);
    mediaValidated = true;
    if (item.source !== 'upload') await fs.copyFile(temp, mediaPath(item.id));
    const raw = await run('ffmpeg', ['-v', 'error', '-i', temp, '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,fps=12,format=gray', '-frames:v', String(Math.min(MAX_FRAMES, Math.ceil(duration * 12))), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
    const frameBytes = 160 * 90, count = Math.floor(raw.length / frameBytes), luminance = [];
    for (let i = 0; i < count; i++) { let sum = 0; const start = i * frameBytes; for (let j = 0; j < frameBytes; j++) sum += raw[start + j]; luminance.push(sum / frameBytes); }
    const reversals = [];
    let priorDirection = 0;
    for (let i = 1; i < luminance.length; i++) {
      const before = luminance[i - 1], after = luminance[i], delta = after - before;
      if (Math.abs(delta) >= 26 && Math.min(before, after) < 204) {
        const direction = Math.sign(delta);
        if (priorDirection && direction !== priorDirection) reversals.push(i);
        priorDirection = direction;
      }
    }
    let maxFlashesInOneSecond = 0;
    for (let i = 0; i < reversals.length; i++) { let j = i; while (j < reversals.length && reversals[j] - reversals[i] < 12) j++; maxFlashesInOneSecond = Math.max(maxFlashesInOneSecond, j - i); }
    const flagged = maxFlashesInOneSecond > 3;
    const flashCheck = { name: 'Photosensitivity screening', status: count ? 'Ran' : 'Unavailable', measured: count ? { sampledFrames: count, sampleRateFps: 12, opposingLuminanceTransitions: reversals.length, maxFlashPairsInOneSecond: maxFlashesInOneSecond } : null, risk: flagged ? 'Rapid luminance flashes detected' : null, explanation: 'WCAG-inspired coarse screen: sampled frame-average luma at 12 frames per second and looked for opposing transitions. It does not measure flash area, saturated-red flashes, or all WCAG thresholds; short events may be missed. Screening signal only, not medical assessment.' };
    let visualCheck;
    try { visualCheck = await scanVisualVideo(temp, duration); }
    catch (e) { visualCheck = { name: 'Visual content-risk model', status: 'Failed / unavailable', scores: null, risk: null, measured: null, explanation: `Local classifier failed: ${e.message}. Keep this item for manual review.` }; }
    const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
    let copyrightCheck;
    if (!audioStream) copyrightCheck = { name: 'Possible copyrighted-audio match', status: 'Ran', scores: null, risk: null, measured: { audioTrack: false }, explanation: 'No audio track was present to fingerprint. This says nothing about video or other rights.' };
    else if (!process.env.ACOUSTID_CLIENT_KEY) copyrightCheck = await fingerprintLookup(0, '');
    else {
      try {
        const fpOutput = (await run('fpcalc', ['-length', String(Math.min(MAX_DURATION, Math.ceil(duration))), temp])).toString('utf8');
        const fpDuration = Number(fpOutput.match(/^DURATION=(\d+)/m)?.[1] || 0), fingerprint = fpOutput.match(/^FINGERPRINT=(.+)$/m)?.[1]?.trim();
        if (!fpDuration || !fingerprint) throw Error('Chromaprint did not produce a usable fingerprint.');
        copyrightCheck = await fingerprintLookup(fpDuration, fingerprint);
      } catch (e) { copyrightCheck = { name: 'Possible copyrighted-audio match', status: 'Failed / unavailable', scores: null, risk: null, measured: null, explanation: `Audio fingerprint lookup failed: ${e.message}. This does not indicate that the audio is free of rights restrictions.` }; }
    }
    const checks = [flashCheck, visualCheck, copyrightCheck];
    const visualFlagged = Boolean(visualCheck.risk);
    const copyrightFlagged = Boolean(copyrightCheck.risk);
    const hasFlag = flagged || visualFlagged || copyrightFlagged;
    item.scan = {
      state: hasFlag ? 'Flagged' : 'Needs review', playbackBlocked: true, checks,
      summary: hasFlag ? 'One or more screening signals need moderator review. They do not determine policy compliance or rights.' : 'Checks ran without a listed signal, but moderator review is still required; automated results are not a clearance.',
      metadata: { width, height, durationSeconds: Number(duration.toFixed(2)), flashSampledFrames: count, contentSampleRateFps: 1 }
    };
    if (!['Held', 'Rejected'].includes(item.status)) item.status = hasFlag ? 'Flagged' : 'Needs review';
    log('scan_completed', item, { state: item.scan.state, checks: item.scan.checks.map(c => ({ name: c.name, status: c.status, risk: c.risk, measured: c.measured })) });
  } catch (e) {
    const reason = e.code === 'ENOENT' ? 'ffmpeg and ffprobe are required but are not installed or not available on PATH.' : e.message;
    if (!['Held', 'Rejected'].includes(item.status)) item.status = 'Needs review';
    item.scan = { state: 'Scan failed', playbackBlocked: true, checks: [{ name: 'Media retrieval and flash screening', status: 'Failed / unavailable', measured: null, risk: null, explanation: reason }, { name: 'Visual content-risk model', status: 'Unavailable', scores: null, risk: null, measured: null, explanation: visualStatus }, { name: 'Possible copyrighted-audio match', status: 'Unavailable', scores: null, risk: null, measured: null, explanation: 'Media retrieval failed, so no audio fingerprint lookup could run.' }], summary: reason };
    log('scan_failed', item, { reason });
  } finally {
    if (temp && removeTemp) await fs.rm(temp, { force: true }).catch(() => {});
    if (item.source === 'upload' && !mediaValidated) await fs.rm(mediaPath(item.id), { force: true }).catch(() => {});
    if (item.scan?.state === 'Scan failed') await fs.rm(mediaPath(item.id), { force: true }).catch(() => {});
    item.updatedAt = new Date().toISOString(); await persist();
  }
}
function mediaPath(id) { if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error('Invalid media id.'); return path.join(mediaDir, `${id}.mp4`); }
async function addSubmission({ id, url, submitter, source, messageId }) {
  if (!id || db.seen.includes(id)) return null;
  db.seen.push(id); db.seen = db.seen.slice(-5000);
  const item = { id: crypto.randomUUID(), eventId: id, url, submitter: submitter || 'unknown', source: source || 'dashboard', status: 'Needs review', createdAt: new Date().toISOString(), messageId, scan: { state: 'Needs review', playbackBlocked: true, checks: [], summary: 'Checking supported media source.' } };
  db.items.unshift(item); log('submission_received', item, { source: item.source }); await persist();
  retrieveAndScan(item).catch(e => { item.status = 'Needs review'; item.scan.summary = e.message; persist(); });
  return item;
}
function getTwitchConfig() {
  const { TWITCH_CLIENT_ID: clientId, TWITCH_USER_ACCESS_TOKEN: token, TWITCH_BROADCASTER_ID: broadcasterId, TWITCH_BOT_USER_ID: botId, TWITCH_CHANNEL_LOGIN: channel } = process.env;
  return clientId && token && broadcasterId && botId && channel ? { clientId, token: token.replace(/^oauth:/, ''), broadcasterId, botId, channel } : null;
}
async function helix(url, config, payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'Client-Id': config.clientId, Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  const data = await res.json().catch(() => ({})); if (!res.ok) throw Error(`Twitch API ${res.status}: ${JSON.stringify(data)}`); return data;
}
async function reply(message, parentId) {
  const c = getTwitchConfig(); if (!c) return false;
  try { const data = await helix('https://api.twitch.tv/helix/chat/messages', c, { broadcaster_id: c.broadcasterId, sender_id: c.botId, message, ...(parentId ? { reply_parent_message_id: parentId } : {}) }); return data.data?.[0]?.is_sent === true; }
  catch (e) { twitchState.replyError = e.message; return false; }
}
async function onChat(event) {
  if (event.broadcaster_user_id !== process.env.TWITCH_BROADCASTER_ID) return;
  const text = event.message?.text || '';
  if (!text.toLowerCase().startsWith(`${command.toLowerCase()} `)) return;
  const raw = text.slice(command.length).trim().split(/\s+/)[0];
  const id = event.message_id;
  if (db.seen.includes(id)) return;
  const item = await addSubmission({ id, url: raw, submitter: event.chatter_user_name || event.chatter_user_login, source: 'twitch', messageId: id });
  if (item) await reply('Received. This media is held for moderator review.', id);
}
function connectTwitch() {
  const c = getTwitchConfig();
  if (!c) { twitchState = { connected: false, message: 'Twitch is not configured. Add the required values in .env and restart.' }; return; }
  twitchState = { connected: false, message: 'Connecting to Twitch EventSub…' };
  try {
    socket = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
    socket.onmessage = async ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg.metadata?.message_type, payload = msg.payload || {};
      if (type === 'session_welcome') {
        retryMs = 1000;
        if (socket.transferred) { twitchState = { connected: true, message: `Reconnected to #${c.channel} using the existing EventSub session.` }; socket.transferred = false; }
        else {
          const sessionId = payload.session?.id;
          try {
            await helix('https://api.twitch.tv/helix/eventsub/subscriptions', c, { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: c.broadcasterId, user_id: c.botId }, transport: { method: 'websocket', session_id: sessionId } });
            twitchState = { connected: true, message: `Connected to #${c.channel} using EventSub WebSocket.` };
          } catch (e) { twitchState = { connected: false, message: `EventSub subscription failed: ${e.message}` }; }
        }
      } else if (type === 'notification' && payload.subscription?.type === 'channel.chat.message') { await onChat(payload.event || {}); }
      else if (type === 'session_reconnect') {
        const reconnectUrl = payload.session?.reconnect_url;
        if (reconnectUrl) { const old = socket; old.onclose = null; socket = new WebSocket(reconnectUrl); socket.transferred = true; socket.onmessage = old.onmessage; socket.onclose = old.onclose; socket.onerror = old.onerror; }
      } else if (type === 'session_keepalive_timeout') { socket?.close(); }
    };
    socket.onclose = () => { twitchState = { connected: false, message: 'EventSub disconnected; reconnecting and recreating subscription.' }; scheduleReconnect(); };
    socket.onerror = () => { twitchState = { connected: false, message: 'EventSub connection error; retrying.' }; };
  } catch (e) { twitchState = { connected: false, message: e.message }; scheduleReconnect(); }
}
function scheduleReconnect() { if (reconnectTimer) return; reconnectTimer = setTimeout(() => { reconnectTimer = null; connectTwitch(); retryMs = Math.min(retryMs * 2, 30000); }, retryMs); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      const allowed = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
      if (origin && !allowed.has(origin)) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/events') return eventStream(res);
    if (req.method === 'POST' && url.pathname === '/api/submissions') {
      const input = await body(req); const item = await addSubmission({ id: crypto.randomUUID(), url: input.url, submitter: 'Local moderator', source: 'dashboard' });
      return sendJson(res, 201, item);
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads') {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_BYTES) return sendJson(res, 413, { error: `File exceeds ${MAX_BYTES} byte limit.` });
      const chunks = []; let total = 0;
      for await (const chunk of req) { total += chunk.length; if (total > MAX_BYTES) return sendJson(res, 413, { error: `File exceeds ${MAX_BYTES} byte limit.` }); chunks.push(chunk); }
      if (!total) return sendJson(res, 400, { error: 'Choose a non-empty MP4 file.' });
      const id = crypto.randomUUID(), file = mediaPath(id);
      await fs.writeFile(file, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
      const item = { id, eventId: id, url: `Local MP4 upload (${(req.headers['x-file-name'] || 'video.mp4').toString().replace(/[\r\n]/g, '').slice(0, 100)})`, submitter: 'Local moderator', source: 'upload', status: 'Needs review', createdAt: new Date().toISOString(), scan: { state: 'Needs review', playbackBlocked: true, checks: [], summary: 'Checking uploaded MP4.' } };
      db.items.unshift(item); log('submission_received', item, { source: 'upload', bytes: total }); await persist();
      retrieveAndScan(item).catch(e => console.error('Uploaded media scan:', e.message));
      return sendJson(res, 201, item);
    }
    const decision = url.pathname.match(/^\/api\/items\/([^/]+)\/(approve|reject|hold)$/);
    if (req.method === 'POST' && decision) {
      const item = db.items.find(x => x.id === decision[1]); if (!item) return sendJson(res, 404, { error: 'Submission not found.' });
      const action = decision[2];
      if (action === 'approve' && (!['Needs review', 'Flagged'].includes(item.status) || !item.scan?.checks?.some(c => c.status === 'Ran'))) return sendJson(res, 409, { error: 'This item has no completed screening check or is no longer in an approvable state.' });
      if (action === 'approve') { item.status = 'Approved'; item.scan.playbackBlocked = false; }
      if (action === 'reject') { item.status = 'Rejected'; item.scan.playbackBlocked = true; if (db.playback?.itemId === item.id) db.playback = null; await fs.rm(mediaPath(item.id), { force: true }); }
      if (action === 'hold') { item.status = 'Held'; item.scan.playbackBlocked = true; if (db.playback?.itemId === item.id) db.playback = null; }
      item.decidedAt = new Date().toISOString(); log(`moderator_${action}`, item);
      if (action === 'approve') db.playback = { itemId: item.id, url: item.url, submitter: item.submitter, approvedAt: item.decidedAt };
      await persist(); await reply(action === 'approve' ? 'A submitted item was approved by a moderator.' : action === 'reject' ? 'A submitted item was not approved.' : 'A submitted item is being held for review.');
      return sendJson(res, 200, item);
    }
    if (req.method === 'POST' && url.pathname === '/api/playback/clear') { const prior = db.playback; db.playback = null; log('playback_cleared', prior ? db.items.find(x => x.id === prior.itemId) : null); if (prior?.itemId) await fs.rm(mediaPath(prior.itemId), { force: true }); await persist(); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/overlay') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(await fs.readFile(path.join(root, 'overlay.html'))); }
    if (req.method === 'GET' && url.pathname === '/media') {
      const item = db.items.find(x => x.id === url.searchParams.get('id'));
      const reviewPreview = url.searchParams.get('review') === '1' && item && !['Rejected', 'Scan failed'].includes(item.status) && item.scan?.checks?.some(c => c.status === 'Ran');
      if (!item || (!reviewPreview && (item.status !== 'Approved' || db.playback?.itemId !== item.id))) return sendJson(res, 403, { error: 'Playback is not approved.' });
      if (!reviewPreview) { log('playback_started', item); await persist(); }
      const file = mediaPath(item.id), stat = await fs.stat(file), range = req.headers.range;
      res.setHeader('content-type', 'video/mp4'); res.setHeader('accept-ranges', 'bytes'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
        let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        let end = match[1] ? (match[2] ? Number(match[2]) : stat.size - 1) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
        end = Math.min(end, stat.size - 1); res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 }); fsSync.createReadStream(file, { start, end }).pipe(res); return;
      }
      res.writeHead(200, { 'content-length': stat.size }); fsSync.createReadStream(file).pipe(res); return;
    }
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(await fs.readFile(path.join(root, 'index.html'))); }
    if (req.method === 'GET' && url.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(await fs.readFile(path.join(root, 'app.js'))); }
    if (req.method === 'GET' && url.pathname === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(await fs.readFile(path.join(root, 'styles.css'))); }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) { if (!res.headersSent) sendJson(res, 400, { error: e.message }); else res.destroy(); }
});
await initializeVisualModel();
server.listen(PORT, HOST, () => {
  console.log(`Flash Guard dashboard: http://${HOST}:${PORT}`);
  connectTwitch();
  for (const item of db.items) if (!item.scan?.checks?.length) retrieveAndScan(item).catch(e => console.error('Resume scan:', e.message));
});
