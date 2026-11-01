// TakeStacks — visible duplicate-take grouping (Gling pattern).
// Adjacent clauses within a 30s window with token-Jaccard >= 0.6 or a shared
// 4+ word stumble-restart prefix group into a TakeGroup; the LAST complete take
// is selected (matches the engine's keep-final-take rule).

const WINDOW = 30;

function sentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    // sentence END, or a stumble marker (em-dash cutoff / trailing "wait", "no—")
    if (/[.!?…—]$/.test(w.w) || /^(wait|no—|sorry)[—.?]*$/i.test(w.w)) {
      out.push({ from: cur[0].i, to: w.i, text: cur.map((x) => x.w).join(' '), start: cur[0].start, end: w.end });
      cur = [];
    }
  }
  if (cur.length) out.push({ from: cur[0].i, to: cur[cur.length - 1].i, text: cur.map((x) => x.w).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
  return out;
}

// containment (overlap relative to the SHORTER clause) — restarts drop/add
// leading fillers, so classic Jaccard under-counts them
const jaccard = (a, b) => {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
};

const sharedPrefix = (a, b) => {
  const A = a.toLowerCase().split(/\W+/).filter(Boolean);
  const B = b.toLowerCase().split(/\W+/).filter(Boolean);
  let n = 0;
  while (n < A.length && n < B.length && A[n] === B[n]) n++;
  return n >= 4;
};

export function groupTakes(words) {
  const sents = sentences(words);
  const groups = [];
  let i = 0;
  while (i < sents.length) {
    let j = i + 1;
    const takes = [sents[i]];
    while (j < sents.length && sents[j].start - takes[takes.length - 1].start < WINDOW) {
      const similar = takes.some((t) => jaccard(t.text, sents[j].text) >= 0.6 || sharedPrefix(t.text, sents[j].text));
      if (similar) takes.push(sents[j]);
      else break;
      j++;
    }
    if (takes.length >= 2) {
      groups.push({
        from: takes[0].from,
        to: takes[takes.length - 1].to,
        takes: takes.map((t) => ({ from: t.from, to: t.to, text: t.text })),
        selected: takes.length - 1, // last complete take
      });
      i = j;
    } else i++;
  }
  return groups;
}

/** overrides.cuts ranges that mute every NON-selected take in a group */
export function cutsForSelection(group, selectedIdx) {
  return group.takes
    .filter((_, i) => i !== selectedIdx)
    .map((t) => ({ from: t.from, to: t.to }));
}
