// GLM — the edit brain (senior-editor persona, Story SOP). BYOK direct browser
// call (CORS verified, ANALYSIS §5). The model picks WHAT (keep-ranges as word
// indices, in PLAY ORDER — cold opens allowed); the engine owns WHEN (times,
// snaps, pads). json_object mode only — schema rides in the system prompt,
// validation lives in edit-engine.applyGlm.

const DEFAULTS = {
  baseUrl: 'https://api.z.ai/api/paas/v4',
  model: 'glm-5.3-flash',
  maxTokens: 8192,
};

export const PLATFORMS = {
  shorts: {
    id: 'shorts', label: 'Shorts / Reels', targetLen: [21, 34], hookSec: 3,
    cadence: '2.5-3.5s average between cuts', joinPunches: true, transition: { minRemoved: 1.0, ms: 120 },
    pacing: { minSilence: 0.45, residualPause: 0.2, pauseGapTrigger: 0.6 }, noTrim: false, longForm: false, maxTokens: 8192,
    framework: 'HOOK-RETAIN-PAYOFF: hook ≤3s (pattern interrupt / bold claim / open loop), body = every sentence advances or adds new information, payoff resolves the loop then STOPS. End on a cadence that flows back into the opening hook (seamless loop).',
  },
  tiktok: {
    id: 'tiktok', label: 'TikTok', targetLen: [15, 30], hookSec: 2,
    cadence: '1.5-3s average — tighter than Shorts', joinPunches: true, transition: { minRemoved: 1.0, ms: 120 },
    pacing: { minSilence: 0.18, residualPause: 0.08, pauseGapTrigger: 0.3 }, noTrim: false, longForm: false, maxTokens: 8192,
    framework: 'HOOK-RETAIN-PAYOFF, compressed: hook ≤2s, near-zero dead air, re-hook every segment. End on a cadence that loops seamlessly back into the hook.',
  },
  youtube: {
    id: 'youtube', label: 'YouTube long-form (4-30 min)', targetLen: [240, 1800], hookSec: 15,
    cadence: 'natural, chapter-paced', joinPunches: false, transition: { minRemoved: Infinity, ms: 0 },
    pacing: { minSilence: 0.6, residualPause: 0.35, pauseGapTrigger: 0.8 }, noTrim: true, longForm: true, maxTokens: 32768,
    framework: '5-STAGE LONG-FORM SOP: (1) teaser cold open 0-15s = highest-stakes moment from later in the video; (2) title validation — immediately confirm the premise, CUT generic intros/channel plugs/subscribe begging; (3) escalating body in chapters of 2-5 min; (4) re-hook: note a visual-reset cue every ~4 min in the why field; (5) abrupt outro — end the moment the final point lands, cut winding goodbyes.',
  },
};

function systemPrompt(platform) {
  const p = PLATFORMS[platform] ?? PLATFORMS.shorts;
  const base = `You are a senior video editor with 10 years of retention analytics experience.

PLATFORM: ${p.label}. Target edited length: ${p.targetLen[0]}-${p.targetLen[1]}s. Hook lands within ${p.hookSec}s. Pacing: ${p.cadence}.
NARRATIVE FRAMEWORK: ${p.framework}

SELECTION SOP (in order):
1. Deduplicate takes: keep the final COMPLETE take.
2. Prune filler (um, uh, like-as-filler, you know, I mean), false starts, and meta-commentary ("can you hear me", "let me share my screen").
3. Cold open: you MAY list the highest-tension sentence FIRST even if it occurs later.
4. Score every keep 0-100: hook 35% + standalone completeness 25% + pacing/density 20% + peak 20%.

You receive a numbered list of transcribed words. Word indices are the ONLY addressing mechanism; there are no timestamps.

OUTPUT LANGUAGE: write titles, hookTitle, why, and suggestions in the transcript's dominant language, preserving English technical/gadget terms exactly as spoken (code-switching is correct, do not translate them).
Cut rules: never open with greetings/intros/setup; re-hook every keep; KEEP meaningful words, numbers, names, outcomes, contrasts, emotion; cut the abstract, keep the concrete.`;

  if (p.longForm) {
    return base + `

Reply with a SINGLE JSON object, no prose, matching exactly:
{"keeps":[{"from":<int>,"to":<int>,"why":"<max 8 words>","score":<0-100>}],
 "chapters":[{"title":"<2-5 word chapter title>","from":<int>,"to":<int>}],
 "suggestedCuts":[{"from":<int>,"to":<int>,"why":"<off-topic tangent: max 8 words>"}],
 "emphases":[<int>,...],
 "hookTitle":"<5-8 word cold-open text>",
 "selfCritique":"<one sentence>",
 "confidence":<0.0-1.0>}

Rules:
- keeps: inclusive word-index ranges in PLAY ORDER (cold open first). Together ${p.targetLen[0]}-${p.targetLen[1]}s — do NOT over-cut; this is assembly, not extraction.
- chapters: 3-10 spans covering the kept material in play order, titles fit a YouTube chapter list.
- suggestedCuts: 0-6 SUSPECTED tangents within your keeps — flagged for the user to approve, NOT auto-removed (never list ranges you already excluded).
- Use ONLY indices that exist. Output valid JSON.`;
  }

  return base + `

Reply with a SINGLE JSON object, no prose, matching exactly:
{"clips":[{"title":"<3-6 word clip name>","hookTitle":"<5-8 word on-screen hook>","keeps":[{"from":<int>,"to":<int>,"why":"<max 8 words>","score":<0-100>}]}],
 "emphases":[<int>,...],
 "brollHints":[{"from":<int>,"to":<int>,"topic":"<what to show>"}],
 "selfCritique":"<one sentence: weakest part of THE CURRENT CLIP and what you'd fix>",
 "confidence":<0.0-1.0>}

Rules:
- clips: 3-6 STANDALONE options from this source, each ${p.targetLen[0]}-${p.targetLen[1]}s, each independently watchable (different moments, not one cut sliced up).
- Each clip's keeps: word-index ranges in PLAY ORDER (cold opens allowed); end on a cadence that loops back to its hook.
- If a CURRENT CUT is provided you are REVISING that one clip — return all clips but change only the revised one.
- emphases: 2-5 indices for the CURRENT clip. brollHints: 0-4 for the CURRENT clip.
- Use ONLY indices that exist. Output valid JSON.`;
}

/** build the user payload — pure, testable */
export function buildUserPayload({ words, duration, brollNames = [], targetLen = [21, 34], instructions = '', feedback = [], currentKeeps = null, pacingLine = '', visionContext = '' }) {
  const list = words.map((w) => `${w.i}:${w.w}`).join(' ');
  const parts = [
    `Duration of source: ${duration.toFixed(1)}s. Target edited length: ${targetLen[0]}-${targetLen[1]}s.`,
    brollNames.length ? `B-roll pool (filenames): ${brollNames.join(', ')}` : 'No B-roll available.',
  ];
  if (pacingLine) parts.push(pacingLine);
  if (visionContext) parts.push(`VISUAL CONTEXT (what is on screen at these source times):\n${visionContext}`);
  if (instructions.trim()) parts.push(`EDITOR'S INSTRUCTIONS (highest priority — override defaults): ${instructions.trim()}`);
  if (currentKeeps?.length) parts.push(`CURRENT CUT (your previous keep-ranges as word indices — revise these): ${currentKeeps.map((k) => `${k.words?.[0] ?? '?'}-${k.words?.[1] ?? '?'}`).join(', ')}`);
  if (feedback.length) parts.push(`FEEDBACK HISTORY (newest last — honor all of it):\n${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);
  parts.push('Words:');
  parts.push(list);
  return parts.filter(Boolean).join('\n');
}

/** shared GLM chat call — text or multimodal content, same error/usage handling */
export async function glmChat({ apiKey, baseUrl = DEFAULTS.baseUrl, model = DEFAULTS.model, maxTokens = DEFAULTS.maxTokens },
                              messages, { jsonMode = true, temperature = 0.6 } = {}) {
  if (!apiKey) throw new Error('No GLM API key set (Settings).');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      max_tokens: maxTokens,
      temperature,
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GLM API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('GLM returned no content.');
  return { content, truncated: choice?.finish_reason === 'length', usage: data.usage || null };
}

export async function glmRefine(opts,
                                { words, duration, brollNames = [], instructions = '', feedback = [], currentKeeps = null, platform = 'shorts', visionContext = '', systemOverride = null }) {
  const p = PLATFORMS[platform] ?? PLATFORMS.shorts;
  const user = buildUserPayload({
    words, duration, brollNames, targetLen: p.targetLen, instructions, feedback, currentKeeps,
    pacingLine: `PACING: ${p.cadence}. Silence handling: ${p.pacing.minSilence}s+ pauses trimmed to ~${p.pacing.residualPause}s residual.`,
    visionContext,
  });
  const { content, truncated, usage } = await glmChat(
    { apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, maxTokens: opts.maxTokens ?? p.maxTokens },
    [{ role: 'system', content: systemOverride ?? systemPrompt(platform) }, { role: 'user', content: user }],
  );
  // long-form responses are big; a length-finish there is a half-finished edit,
  // not something to salvage — surface it and let the caller retry
  return { raw: content, truncated, usage, targetLen: p.targetLen, longForm: !!p.longForm };
}

export const GLM_DEFAULTS = DEFAULTS;
