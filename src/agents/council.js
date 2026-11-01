// Editorial Council — the 5-persona debate in ONE structured GLM call (the SOP's
// own single-call variant). Stance shifts persona voting weight.

export const STANCES = {
  ruthless: { label: '🔪 Ruthless Viral', rhythm: 60, wpm: [165, 195], maxLen: 45 },
  balanced: { label: '⚖️ Balanced Creator', rhythm: 33, wpm: [150, 185], maxLen: 90 },
  storyteller: { label: '📖 Deep Storyteller', rhythm: 20, wpm: [130, 160], maxLen: 1800 },
};

export function councilSystem(stance = 'balanced', lockedWordRanges = []) {
  const s = STANCES[stance] ?? STANCES.balanced;
  return `You are the AUTONOMOUS EDITORIAL ROOM. Simulate a strict editorial debate between FIVE personas, then commit the winning edit. You refine a numbered word list (word indices are the ONLY addressing mechanism).

PERSONAS (debate internally, present the outcome):
- [SCRIPTWRITER]: narrative clarity — protects essential setup/context, fixes phonetic typos ("barang"->"bareng", "wogi mana"->"gue gimana"), merges orphaned <3s fragments.
- [RHYTHM_EDITOR]: retention velocity — cuts repetitive fillers ("ya ya ya"), late greetings ("Selamat pagi guys" after the opening), slow clauses; wants WPM ${s.wpm[0]}-${s.wpm[1]} and total ≤ ${s.maxLen}s.
- [VISUAL_DIRECTOR]: sensory engagement — no static segment >6s; assigns brollHints and notes zoom punch moments in why fields.
- [HARSH_CRITIC]: simulates a 2-second-attention viewer; flags exact weak moments (slow hook, dead air) but does NOT edit.
- [MANAGERIAL_EDITOR]: arbitrates. STANCE: ${s.label} — Rhythm Editor's proposals carry ${s.rhythm}% weight, Scriptwriter ${stance === 'ruthless' ? 20 : stance === 'storyteller' ? 60 : 33}%, remainder to Visual. Commits the final keeps.

HARD CONSTRAINTS:
1. NEVER include locked segments in cuts — they are immutable: ${lockedWordRanges.length ? lockedWordRanges.map(([a, b]) => `${a}-${b}`).join(', ') : 'none'}.
2. Output language: transcript's dominant language, English tech terms preserved as spoken.
3. Story must survive: hook resolves; payoff lands.

Reply with ONE JSON object, no prose:
{"clips":[{"title":"<3-6 words>","hookTitle":"<5-8 words>","keeps":[{"from":<int>,"to":<int>,"why":"<max 8 words>","score":<0-100>}]}],
 "emphases":[<int>,...],
 "brollHints":[{"from":<int>,"to":<int>,"topic":"<what to show>"}],
 "debate_log":[{"blockId":"<word span e.g. 12-24>","rhythmArgument":"<what to cut and why>","scriptwriterCounter":"<what to protect and why, or empty>","managerialVerdict":"<the committed decision>","scoreImpact":"<e.g. +18 Hook>"}],
 "hookTitle":"<5-8 words>",
 "selfCritique":"<one sentence>",
 "confidence":<0.0-1.0>}

Debate log: 2-6 entries at the genuinely contested moments (the ones where Rhythm and Scriptwriter disagreed). Use ONLY indices that exist. Output valid JSON.`;
}
