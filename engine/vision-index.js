// Vision context — samples ~6 frames across the CANDIDATE keep spans and asks
// GLM (multimodal) what's on screen, giving the Story SOP visual awareness
// ("don't cut away during the demo"). Runs ONCE per Refine action (never inside
// the self-critique loop). Frames leave the machine ONLY when the user turns
// this on in Settings — the app's privacy copy says so explicitly.

import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.64.0/+esm';
import { glmChat, GLM_DEFAULTS } from './glm.js';
import { salvageJsonArrays } from './edit-engine.js';

const W = 480;

/**
 * Sample frames over the keep candidates + a few context points across the file.
 * getFile(srcId) -> File. Returns [{t, visual}] (t = source seconds).
 */
export async function visionIndex({ apiKey, baseUrl = GLM_DEFAULTS.baseUrl, model = GLM_DEFAULTS.model },
                                  { arollId, getFile, duration, candidateKeeps = [], maxFrames = 6 }) {
  // sample times: prefer candidate spans (their midpoints), fill from the whole file
  const times = new Set();
  for (const k of candidateKeeps.slice(0, maxFrames)) times.add(+((k.in + k.out) / 2).toFixed(2));
  let step = duration / Math.max(1, maxFrames - times.size + times.size);
  for (let t = step / 2; times.size < maxFrames && t < duration; t += step) times.add(+t.toFixed(2));
  const stamps = [...times].sort((a, b) => a - b).slice(0, maxFrames);

  // decode + jpeg-encode each sampled frame (same pattern as face-track)
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(getFile(arollId)) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return [];
  const sink = new VideoSampleSink(track);
  const canvas = document.createElement('canvas');
  const c2 = canvas.getContext('2d');
  const images = [];
  for (const t of stamps) {
    const sample = await sink.getSample(t);
    if (!sample) continue;
    const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
    const sw = vf.displayWidth || vf.codedWidth || 1920, sh = vf.displayHeight || vf.codedHeight || 1080;
    const h = Math.max(2, Math.round((W * sh) / sw));
    canvas.width = W; canvas.height = h;
    c2.drawImage(vf, 0, 0, W, h);
    vf.close?.();
    images.push({ t, url: canvas.toDataURL('image/jpeg', 0.72) });
  }
  if (!images.length) return [];

  const system = 'You describe video frames for an editor AI. Reply with a SINGLE JSON object: {"frames":[{"t":<number>,"visual":"<what is on screen in <=12 words: demo, chart, face, product, b-roll, talking head...>"}]}. Use the t values given. No prose.';
  const userText = `Describe each frame (video about which the editor is choosing cuts). Frames:\n${images.map((im) => `t=${im.t}s`).join('\n')}`;
  const content = [];
  for (const im of images) content.push({ type: 'image_url', image_url: { url: im.url } });
  content.push({ type: 'text', text: userText });

  let out;
  try {
    out = await glmChat({ apiKey, baseUrl, model, maxTokens: 2048 }, [
      { role: 'system', content: system }, { role: 'user', content },
    ]);
  } catch (e) {
    // coding endpoint may not accept multimodal + json_object together — retry without json mode
    if (!/API 4\d\d/.test(e.message)) throw e;
    out = await glmChat({ apiKey, baseUrl, model, maxTokens: 2048 }, [
      { role: 'system', content: system + ' (Return ONLY the JSON object.)' }, { role: 'user', content },
    ], { jsonMode: false });
  }
  let parsed;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    parsed = JSON.parse(salvageJsonArrays(out.content));
  }
  const valid = new Set(stamps);
  return (parsed.frames || [])
    .filter((f) => Number.isFinite(f.t) && valid.has(+Number(f.t).toFixed(2)) && f.visual)
    .map((f) => ({ t: +f.t, visual: String(f.visual).slice(0, 90) }));
}

/** VISUAL CONTEXT block for the refine payload */
export function visionContextLines(entries) {
  return entries.map((e) => `${e.t.toFixed(1)}s: ${e.visual}`).join('\n');
}
