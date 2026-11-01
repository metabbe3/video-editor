// DurationBudget — fit the edit to a target length by tiered drops.
// Tier 1 (locked): first keep (hook) + final keep (payoff).
// Tier order for removal: why-matches-tangent/intro/setup first, then ascending GLM score.

const tier = (k, idx, last) => {
  if (idx === 0 || idx === last) return 0; // locked
  if (/tangent|intro|setup|greeting|meta/i.test(k.why ?? '')) return 3;
  return (k.score ?? 50) < 55 ? 2 : 1;
};

export function fitToTarget(keeps, targetSec) {
  const total = keeps.reduce((a, k) => a + k.out - k.in, 0);
  if (total <= targetSec * 1.02) return keeps; // already fits

  const last = keeps.length - 1;
  const removable = keeps
    .map((k, i) => ({ k, i, t: tier(k, i, last) }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t || (a.k.score ?? 50) - (b.k.score ?? 50));

  const drop = new Set();
  let cur = total;
  const floor = targetSec * 0.6; // never hollow the story below 60% of target
  for (const r of removable) {
    if (cur <= targetSec * 1.02) break;
    const len = r.k.out - r.k.in;
    if (cur - len < floor) continue;
    drop.add(r.i);
    cur -= len;
  }
  return keeps.filter((_, i) => !drop.has(i));
}
