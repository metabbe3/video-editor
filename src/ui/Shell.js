// Shell — OpenCut-style layout: left icon rail swaps panel views; splitters
// resize rail | stage | inspector and content | timeline. Sizes persist to LS.

const $ = (id) => document.getElementById(id);
const LS = { get: (k, d) => localStorage.getItem(k) ?? d, set: (k, v) => localStorage.setItem(k, v) };

export function initShell() {
  const rail = $('rail'), panels = $('panelView');

  const show = (key) => {
    const known = [...panels.children].some((s) => s.dataset.panel === key);
    if (!known) return;
    for (const b of rail.children) b.classList.toggle('on', b.dataset.panel === key);
    for (const s of panels.children) s.hidden = s.dataset.panel !== key;
    LS.set('panel.tab', key);
  };
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-panel]');
    if (b) show(b.dataset.panel);
  });
  show(LS.get('panel.tab', 'media'));

  // splitters — one pointer handler each, sizes clamped and persisted
  const dragX = (el, apply) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const move = (ev) => apply(ev.clientX);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
    });
  };
  const dragY = (el, apply) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const move = (ev) => apply(ev.clientY);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
    });
  };
  const left = $('shellTop').getBoundingClientRect().left;
  dragX($('spLeft'), (x) => {
    const w = Math.min(480, Math.max(180, x - left));
    $('railWrap').style.width = `${w}px`; LS.set('panel.leftW', w);
  });
  dragX($('spRight'), (x) => {
    const right = $('shellTop').getBoundingClientRect().right;
    const w = Math.min(520, Math.max(200, right - x));
    $('rightCol').style.width = `${w}px`; LS.set('panel.rightW', w);
  });
  dragY($('spTl'), (y) => {
    const bottom = $('shellTop').getBoundingClientRect().bottom;
    const h = Math.min(500, Math.max(120, y - bottom + $('tlDock').offsetHeight));
    $('tlDock').style.height = `${h}px`; LS.set('panel.tlH', h);
    dispatchEvent(new Event('resize')); // timeline canvas re-layouts on resize
  });
  $('railWrap').style.width = `${LS.get('panel.leftW', 272)}px`;
  $('rightCol').style.width = `${LS.get('panel.rightW', 300)}px`;
  $('tlDock').style.height = `${LS.get('panel.tlH', 176)}px`;

  return { show };
}
