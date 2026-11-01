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
    card.style.cssText = 'border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg-raise);cursor:grab';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:baseline;font-size:var(--fs-small);color:var(--ink-2);margin-bottom:4px';
    const badge = document.createElement('span');
    badge.textContent = roleBadge(k.why, i, p.edl.keep.length - 1);
    badge.style.cssText = 'color:var(--accent);font-weight:600';
    const time = document.createElement('span');
    time.style.fontFamily = 'var(--mono)';
    time.textContent = `${fmt(t0)}–${fmt(t1)}`;
    const src = document.createElement('span');
    src.textContent = `src ${fmt(k.in)}`;
    const score = document.createElement('span');
    if (k.score) { score.textContent = `· ${k.score}`; score.style.color = 'var(--accent)'; }
    head.append(badge, time, src, score);
    const body = document.createElement('div');
    body.style.cssText = 'font-size:var(--fs-hero);line-height:1.7;color:var(--ink)';
    body.textContent = words.map((w) => w.w).join(' ');
    card.append(head, body);

    card.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(i));
    card.oncontextmenu = (e) => { e.preventDefault(); app.storyMenu(e, i); };
    if (k.locked) { card.style.boxShadow = '0 0 0 1px var(--accent)'; badge.textContent = '🔒 ' + badge.textContent; }
    card.ondragover = (e) => { e.preventDefault(); card.style.boxShadow = '0 0 0 2px var(--accent)'; };
    card.ondragleave = () => { card.style.boxShadow = ''; };
    card.ondrop = (e) => {
      e.preventDefault();
      card.style.boxShadow = '';
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
    pill.style.cssText = 'font-size:var(--fs-small);color:var(--ink-2);padding:6px 10px;border-radius:8px;background:var(--bg-raise);cursor:pointer';
    pill.textContent = `✂️ ${Math.round(totalCut)}s cut · ${removed.length} regions — switch to Raw Map to rescue`;
    pill.onclick = () => app.switchScriptTab('raw');
    container.appendChild(pill);
  }
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
