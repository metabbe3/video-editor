// Guides — PREVIEW-ONLY overlays (never exported): platform safe zones,
// thirds grid, TikTok-style UI mock. Drawn via preview.overlay AFTER
// renderFrame, so none of this ever reaches the exporter.
// (Fixes a latent bug: the old SafeZones lived in Compositor.scene and was
// baked into exports when toggled on.)

export const GUIDE_MODES = ['off', 'safe', 'grid', 'tiktok'];

export function drawGuides(ctx, w, h, mode) {
  if (mode === 'off') return;
  ctx.save();
  if (mode === 'safe') {
    ctx.fillStyle = 'rgba(31,111,235,0.18)';
    ctx.strokeStyle = 'rgba(31,111,235,0.8)';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.fillRect(0, 0, w, h * 0.14);
    ctx.fillRect(0, h * 0.65, w, h * 0.35);
    ctx.fillRect(0, 0, w * 0.06, h);
    ctx.fillRect(w * 0.94, 0, w * 0.06, h);
    ctx.strokeRect(w * 0.06, h * 0.14, w * 0.88, h * 0.51);
  } else if (mode === 'grid') {
    ctx.strokeStyle = 'rgba(31,111,235,0.55)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo((w * i) / 3, 0); ctx.lineTo((w * i) / 3, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (h * i) / 3); ctx.lineTo(w, (h * i) / 3); ctx.stroke();
    }
  } else if (mode === 'tiktok') {
    const ink = 'rgba(255,255,255,0.5)';
    ctx.globalAlpha = 0.55;
    // top tabs
    ctx.fillStyle = ink;
    ctx.font = `600 ${h * 0.02}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Following', w * 0.32, h * 0.045);
    ctx.fillText('For You', w * 0.68, h * 0.045);
    // right action rail
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    const railX = w * 0.88;
    ['♥', '💬', '↗', '♪'].forEach((s, i) => {
      const y = h * (0.58 + i * 0.075);
      ctx.beginPath(); ctx.arc(railX, y, h * 0.022, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `${h * 0.022}px system-ui`;
      ctx.fillText(s, railX, y + h * 0.001);
    });
    // bottom caption + music zone
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(w * 0.05, h * 0.78, w * 0.72, h * 0.1);
    ctx.font = `${h * 0.016}px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillText('♪ caption + music zone', w * 0.07, h * 0.905);
  }
  ctx.restore();
}
