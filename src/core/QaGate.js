// QaGate — pure pre-render checks. Blockers stop the export (they crash the
// encoder); warnings are advisory.

export function checkEdl(edl, { w = 1080, h = 1920 } = {}) {
  const blockers = [];
  const warnings = [];
  if (!edl?.keep?.length) return { blockers: ['EDL has no keep segments'], warnings };

  // broll entries must reference a real file (round-7 exporter crash)
  for (const b of edl.broll || []) {
    if (!b.src) blockers.push(`B-roll entry at ${(+b.at).toFixed(1)}s has no src`);
  }
  // keeps must be valid
  edl.keep.forEach((k, i) => {
    if (!(k.out > k.in)) blockers.push(`Keep #${i + 1} has out <= in`);
    if (k.speed != null && (!Number.isFinite(k.speed) || k.speed < 0.25 || k.speed > 4)) {
      blockers.push(`Keep #${i + 1} speed ${k.speed} outside 0.25–4`);
    }
    if (k.speedCurve != null) {
      if (!Array.isArray(k.speedCurve) || k.speedCurve.length < 2) {
        blockers.push(`Keep #${i + 1} speedCurve must have at least 2 points`);
      } else {
        for (const pt of k.speedCurve) {
          if (!Number.isFinite(pt.t) || pt.t < 0 || pt.t > 1 || !Number.isFinite(pt.v) || pt.v < 0.25 || pt.v > 4) {
            blockers.push(`Keep #${i + 1} speedCurve point invalid`);
            break;
          }
        }
      }
    }
    if (k.freeze != null && (!Number.isFinite(k.freeze) || k.freeze < 0.2 || k.freeze > 10)) {
      blockers.push(`Keep #${i + 1} freeze ${k.freeze}s outside 0.2–10`);
    }
    if (k.fadeIn != null && (!Number.isFinite(k.fadeIn) || k.fadeIn < 0 || k.fadeIn > 5000)) {
      warnings.push(`Keep #${i + 1} fadeIn ${k.fadeIn}ms outside 0-5000`);
    }
    if (k.fadeOut != null && (!Number.isFinite(k.fadeOut) || k.fadeOut < 0 || k.fadeOut > 5000)) {
      warnings.push(`Keep #${i + 1} fadeOut ${k.fadeOut}ms outside 0-5000`);
    }
  });
  // dims/fps must be even integers
  const st = edl.style ?? {};
  if (st.w % 2 || st.h % 2) blockers.push(`Frame ${st.w}×${st.h} has odd dimensions`);
  if (!Number.isInteger(st.fps) || st.fps < 12) blockers.push(`fps ${st.fps} invalid`);
  // caption style must exist
  const styles = ['hormozi', 'karaoke', 'glass', 'pop', 'clean'];
  if (st.captionsMode !== 'off' && st.captionStyle && !styles.includes(st.captionStyle)) {
    blockers.push(`Unknown caption style "${st.captionStyle}"`);
  }

  // warnings
  const total = edl.keep.reduce((a, k) => a + k.out - k.in, 0);
  if (edl.keep.some((k) => k.out - k.in > 60)) warnings.push('A keep segment exceeds 60s — retention risk');
  for (let i = 1; i < edl.keep.length; i++) {
    const gap = edl.keep[i].in - edl.keep[i - 1].out;
    if (gap < -0.02) warnings.push(`Segments ${i}-${i + 1} overlap in source by ${(-gap).toFixed(2)}s`);
  }
  edl.keep.forEach((k, i) => {
    if (k.speed != null && (k.speed > 1.5 || k.speed < 0.7)) {
      warnings.push(`Clip ${i + 1} at ${k.speed}× — audio pitch shifts (naive resample)`);
    }
    if (k.freeze != null && k.freeze > 3) warnings.push(`Clip ${i + 1} freeze holds ${k.freeze}s — retention risk`);
  });
  for (const p of edl.punches || []) {
    if (p.at > total) warnings.push(`Punch at ${p.at.toFixed(1)}s beyond timeline end`);
  }
  // caption overflow estimate: chars × 0.55 × size > safe width
  if (st.captionsMode !== 'off' && st.captionSize) {
    const maxChars = Math.floor((w * 0.88) / (st.captionSize * 0.55));
    for (const k of edl.keep) {
      const words = (edl.words || []).filter((x) => x.start >= k.in && x.start < k.out);
      const longest = words.map((x) => x.w).sort((a, b) => b.length - a.length)[0] ?? '';
      if (longest.length > maxChars) warnings.push(`Caption word "${longest}" may overflow the safe zone`);
    }
  }
  return { blockers, warnings };
}
