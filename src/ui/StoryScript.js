// StoryScript — the readable view of the edit: kept words in PLAY ORDER grouped
// into Story Cards (one per keep segment), cut regions collapsed to pills,
// drag-to-reorder cards = keep-order swap. Raw Map stays in main.js renderTranscript.

import { timelineOf } from '../core/Compositor.js';
import { removedView } from '../../engine/edit-engine.js';

const roleBadge = (why, i, last) => {
  if (i === 0 || /hook/i.test(why ?? '')) return '🔥 Hook';
  if (i === last || /payoff|verdict|final|conclusion/i.test(why ?? '')) return '🎯 Payoff';
  return '💡 Body';
};

export function renderStoryScript(container, app) {
  const p = app.project;
  container.textContent = '';
  if (!p.edl) return;
  const tl = timelineOf(p.edl);

  p.edl.keep.forEach((k, i) => {
    const words = p.words.filter((w) => w.start >= k.in && w.start < k.out);
    if (!words.length) return;
    const t0 = tl.starts[i];
    const t1 = t0 + (k.out - k.in);
    const card = document.createElement('div');
    card.draggable = true;
    card.dataset.idx = i;
    card.style.cssText = 'border:1px solid var(--border-soft);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--bg);cursor:grab';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--ink-2);margin-bottom:4px';
    const badge = document.createElement('span');
    badge.textContent = roleBadge(k.why, i, p.edl.keep.length - 1);
    badge.style.cssText = 'color:var(--clay);font-weight:600';
    const time = document.createElement('span');
    time.style.fontFamily = 'var(--mono)';
    time.textContent = `${fmt(t0)}–${fmt(t1)}`;
    const src = document.createElement('span');
    src.textContent = `src ${fmt(k.in)}`;
    const score = document.createElement('span');
    if (k.score) { score.textContent = `· ${k.score}`; score.style.color = 'var(--clay)'; }
    head.append(badge, time, src, score);
    const body = document.createElement('div');
    body.style.cssText = 'font-size:13.5px;line-height:1.6';
    body.textContent = words.map((w) => w.w).join(' ');
    card.append(head, body);

    card.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(i));
    card.oncontextmenu = (e) => { e.preventDefault(); app.storyMenu(e, i); };
    if (k.locked) { card.style.borderColor = 'var(--kraft, #d4a373)'; badge.textContent = '🔒 ' + badge.textContent; }
    card.ondragover = (e) => { e.preventDefault(); card.style.borderColor = 'var(--clay)'; };
    card.ondragleave = () => { card.style.borderColor = 'var(--border-soft)'; };
    card.ondrop = (e) => {
      e.preventDefault();
      card.style.borderColor = '';
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (from === i || Number.isNaN(from)) return;
      app.pushUndo();
      const keep = [...p.edl.keep];
      const [moved] = keep.splice(from, 1);
      keep.splice(from < i ? i - 1 : i, 0, moved);
      p.edl = { ...p.edl, keep };
      app.refreshDerived();
      app.renderScriptTabs();
      app.toast(from === 0 ? 'New opening — cold open swapped' : 'Story reordered');
    };
    container.appendChild(card);
  });

  // collapsed cut summary at the end
  const removed = removedView(p.edl.keep, p.analysis.duration);
  const totalCut = removed.reduce((a, r) => a + (r.end - r.start), 0);
  if (totalCut > 1) {
    const pill = document.createElement('div');
    pill.style.cssText = 'font-size:11.5px;color:var(--ink-2);padding:4px 6px;border:1px dashed var(--border-soft);border-radius:8px;cursor:pointer';
    pill.textContent = `✂️ ${Math.round(totalCut)}s cut · ${removed.length} regions — switch to Raw Map to rescue`;
    pill.onclick = () => app.switchScriptTab('raw');
    container.appendChild(pill);
  }
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
