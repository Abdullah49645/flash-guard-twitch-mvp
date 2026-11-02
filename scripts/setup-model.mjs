import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = path.join(root, 'models');
const modelPath = path.join(modelDir, 'image-safety-classifier-s.onnx');
const modelUrl = 'https://huggingface.co/OwenElliott/image-safety-classifier-s/resolve/eb8b0b203952b70db191e990217174af4af39767/onnx/image-safety-classifier-s.onnx';
const expectedSha256 = 'fef443ed68ae25ed693b6fef9e456071692ed3963cff4168acb39c3de6f017e7';

await fs.mkdir(modelDir, { recursive: true });
const response = await fetch(modelUrl, { signal: AbortSignal.timeout(180_000) });
if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
const chunks = []; let total = 0;
for await (const chunk of response.body) {
  total += chunk.length;
  if (total > 50_000_000) throw new Error('Model exceeded the expected 50 MB limit.');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== expectedSha256) throw new Error(`Model integrity check failed. Expected ${expectedSha256}; received ${actualSha256}.`);
const temp = `${modelPath}.tmp`;
await fs.writeFile(temp, bytes, { mode: 0o600 });
await fs.rename(temp, modelPath);

const ort = await import('onnxruntime-node');
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
const input = session.inputNames[0];
const testPixels = new Float32Array(3 * 224 * 224);
const result = await session.run({ [input]: new ort.Tensor('float32', testPixels, [1, 3, 224, 224]) });
const scores = result[session.outputNames[0]]?.data;
if (!scores || scores.length !== 3 || Array.from(scores).some(x => !Number.isFinite(x))) throw new Error('Model smoke inference returned an unexpected output.');
console.log(`Installed and verified OwenElliott/image-safety-classifier-s (${actualSha256}).`);
console.log(`Input: ${session.inputNames.join(', ')}; output shape: ${result[session.outputNames[0]].dims.join('×')}; score order: NSFL, NSFW, SFW.`);
