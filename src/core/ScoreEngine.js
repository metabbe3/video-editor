// ScoreEngine — live virality diagnostics. Pure: reads the EDL + transcript,
// returns 4 meters (0-100) + weighted total. Recomputed on every rebuild.

import { FILLER_RE } from '../../engine/edit-engine.js';
import { PLATFORMS } from '../../engine/glm.js';

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

export function evaluate(edl, tl, words, { platform = 'shorts' } = {}) {
  const p = PLATFORMS[platform] ?? PLATFORMS.shorts;
  const keeps = edl.keep ?? [];

  // 1. Hook (35%) — filler/greeting openers are heavily penalized; else GLM's score
  const firstWords = keeps[0] ? words.filter((w) => w.start >= keeps[0].in && w.end <= keeps[0].out).slice(0, 4).map((w) => w.w) : [];
  const opensWithFiller = firstWords.some((t) => FILLER_RE.test(t) || /^(hey|hi|hello|so|today|welcome|guys)$/i.test(t));
  const hookScore = clamp(opensWithFiller ? 25 + Math.round((keeps[0]?.score || 0) * 0.2) : (keeps[0]?.score || 50));

  // 2. Pacing (25%) — WPM window per platform + silence ratio
  const keptWords = words.filter((w) => keeps.some((k) => w.start >= k.in && w.start < k.out));
  const durMin = tl.duration / 60;
  const wpm = durMin > 0 ? Math.round(keptWords.length / durMin) : 0;
  const [lo, hi] = p.longForm ? [130, 155] : [150, 185];
  const mid = (lo + hi) / 2;
  const wpmScore = wpm >= lo && wpm <= hi ? 95 : clamp(95 - Math.abs(mid - wpm) * 1.6, 30);
  const speechSec = keptWords.reduce((a, w) => a + (w.end - w.start), 0);
  const silenceRatio = tl.duration > 0 ? clamp(1 - speechSec / tl.duration, 0, 1) : 1;
  const pacingScore = clamp(wpmScore - silenceRatio * 45);

  // 3. Visual density (20%) — seconds between visual events
  const events = (edl.punches || []).length + (edl.broll || []).length + (edl.steps || []).length + Math.max(0, keeps.length - 1);
  const avgSecPerEvent = tl.duration / Math.max(1, events);
  const maxGap = p.longForm ? 35 : 7;
  const visualScore = clamp(avgSecPerEvent <= maxGap * 0.6 ? 95 : 95 - (avgSecPerEvent - maxGap * 0.6) * (100 / (maxGap * 1.2)), 30);

  // 4. Story completeness (20%) — hook + payoff roles present
  const hasHook = /hook/i.test(keeps[0]?.why ?? '') || keeps.length > 0;
  const hasPayoff = keeps.length > 1 && /payoff|conclusion|verdict|final/i.test(keeps[keeps.length - 1]?.why ?? '') || keeps.length >= 2;
  const storyScore = hasHook && hasPayoff ? 95 : hasHook || hasPayoff ? 70 : 55;

  return {
    total: Math.round(hookScore * 0.35 + pacingScore * 0.25 + visualScore * 0.2 + storyScore * 0.2),
    hook: Math.round(hookScore),
    pacing: Math.round(pacingScore),
    visual: Math.round(visualScore),
    story: Math.round(storyScore),
    wpm,
  };
}
