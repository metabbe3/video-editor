// ChatDirector.js — Orchestration agent for project-wide chat-directed editing.
// Coordinates tools: analyze flow, council iteration rounds, focus draft plans,
// 3-variant generation, stance switching, and export triggers.
// Part of Nila Sprint 3.

import { parseDirectorIntent, planFocusEdit, generate3Variants, detectVideoTypeAndStance } from '../../engine/director-intent.js';
import { runCouncilRound } from '../../engine/council-vote.js';
import { STANCES } from './council.js';

export class ChatDirector {
  constructor(app, project) {
    this.app = app;
    this.p = project;
    this.status = 'idle'; // 'idle' | 'running'
    this.pendingDiff = null;
  }

  /**
   * Process a user instruction string through the director intent router and step runner.
   * @param {string} userText - User prompt
   * @param {object} callbacks - { onStatus(text), onMessage(msg), onUpdate() }
   */
  async processMessage(userText, { onStatus = () => {}, onMessage = () => {}, onUpdate = () => {} } = {}) {
    const text = String(userText || '').trim();
    if (!text) return;

    this.status = 'running';

    // 1. Record user message in project chat log
    const userMsg = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      type: 'text',
      text,
      at: Date.now(),
    };
    this.p.chatLog = this.p.chatLog || [];
    this.p.chatLog.push(userMsg);
    onMessage(userMsg);

    try {
      // 2. Parse intent plan
      const plan = parseDirectorIntent(text, {
        words: this.p.words,
        analysis: this.p.analysis,
        reg: this.p.reg,
        edl: this.p.edl,
        proposals: this.p.proposals,
        baseKeeps: this.p.baseKeeps,
        stance: this.p.stance || 'balanced',
        variants: this.p.variants,
        hasMedia: Boolean(this.p.reg?.arollId),
      });

      // 3. Handle ambiguous queries requiring clarification
      if (plan.needsClarification) {
        const agentMsg = {
          id: `msg_${Date.now()}_a`,
          role: 'assistant',
          type: 'options-list',
          text: plan.question || 'How would you like to proceed?',
          options: plan.options || [],
          at: Date.now(),
        };
        this.p.chatLog.push(agentMsg);
        onMessage(agentMsg);
        this.status = 'idle';
        return;
      }

      // 4. Sequential Step Runner for parsed intents
      const intents = plan.intents || [];
      if (!intents.length) {
        const fallbackMsg = {
          id: `msg_${Date.now()}_a`,
          role: 'assistant',
          type: 'options-list',
          text: plan.message || 'I could not determine the exact command. Here are options:',
          options: plan.options || [
            { label: 'Analyze this video', action: 'analyze' },
            { label: 'Give 3 style options', action: 'variants' },
            { label: 'Project status', action: 'status' },
          ],
          at: Date.now(),
        };
        this.p.chatLog.push(fallbackMsg);
        onMessage(fallbackMsg);
        this.status = 'idle';
        return;
      }

      for (let i = 0; i < intents.length; i++) {
        const it = intents[i];
        if (intents.length > 1) {
          onStatus(`Step ${i + 1}/${intents.length}: ${it.type}…`);
        }
        await this.runStep(it, { onStatus, onMessage, onUpdate });
      }
    } catch (err) {
      console.error('ChatDirector process error:', err);
      const errMsg = {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        type: 'text',
        text: `Error processing request: ${err.message || 'Unknown error'}. Try rephrasing or asking for "status".`,
        at: Date.now(),
      };
      this.p.chatLog.push(errMsg);
      onMessage(errMsg);
    } finally {
      this.status = 'idle';
      onStatus('');
      onUpdate();
      this.app?.saveCurrentProject?.();
    }
  }

  /**
   * Execute a single intent step.
   */
  async runStep(intent, { onStatus, onMessage, onUpdate }) {
    const p = this.p;
    const app = this.app;

    switch (intent.type) {
      case 'analyze': {
        const hasWords = Boolean(p.words && p.words.length);
        const hasAroll = Boolean(p.reg?.arollId);

        if (!hasAroll && !hasWords) {
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'options-list',
            text: 'No video folder loaded yet. Please pick a folder containing your A-roll video file to begin.',
            options: [
              { label: '📂 Choose Folder', action: 'pick_folder' },
            ],
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          return;
        }

        if (hasWords) {
          onStatus(`Analyzing ${p.words.length} words & proposals…`);
          p.computeProposals();
          const classifier = detectVideoTypeAndStance(p.words);

          const count = p.proposals?.length || 0;
          const durSec = p.analysis?.duration ? (p.analysis.duration).toFixed(1) : '0';
          const text = `Analyzed ${p.words.length} words (${durSec}s). Generated ${count} candidate cut proposals. ${classifier.message}`;

          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'options-list',
            text,
            options: [
              { label: `Apply all ${count} proposals`, action: 'apply_proposals' },
              { label: 'Debate with Council ⚖', action: 'debate' },
              { label: `Adopt ${STANCES[classifier.recommendedStance]?.label || classifier.recommendedStance}`, action: 'set_stance', stance: classifier.recommendedStance },
              { label: 'Generate 3 variants', action: 'variants' },
            ],
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          app?.refreshDerived?.();
          return;
        }

        // Trigger ingest analyze flow in app
        if (app?.analyze) {
          onStatus('Transcribing & analyzing A-roll audio…');
          await app.analyze();
          const count = p.proposals?.length || 0;
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'options-list',
            text: `Analysis complete: ${p.words?.length || 0} words transcribed, ${count} cut proposals ready.`,
            options: [
              { label: 'Apply proposals', action: 'apply_proposals' },
              { label: 'Debate with Council ⚖', action: 'debate' },
              { label: 'Generate 3 variants', action: 'variants' },
            ],
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
        }
        break;
      }

      case 'focus': {
        const term = intent.params?.term || '';
        if (!p.words || !p.words.length) {
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'text',
            text: `Cannot focus on "${term}" because the video has not been transcribed yet. Run "analyze" first.`,
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          return;
        }

        const plan = intent.params?.plan || planFocusEdit(term, p.words, p.analysis?.duration || 0);
        if (!plan.matched) {
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'options-list',
            text: `No mention of "${term}" found in the transcript words. Try another keyword or phrase.`,
            options: [
              { label: 'Show status', action: 'status' },
              { label: 'Generate 3 variants', action: 'variants' },
            ],
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          return;
        }

        // Store pending focus diff plan
        this.pendingDiff = {
          type: 'focus',
          term,
          plan,
          wordIndices: plan.wordIndices || [],
          cuts: plan.cuts || [],
        };

        // Highlight matched words in transcript
        this.highlightDiffWords(plan.wordIndices);

        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'plan-diff',
          text: `Focus plan for "${term}": keeping ${plan.keepWordCount} words, cutting ${plan.cutWordCount} other words.`,
          diff: {
            label: `Focus on "${term}"`,
            explanation: plan.explanation,
            wordCount: plan.keepWordCount,
          },
          options: [
            { label: `Apply focus on "${term}"`, action: 'apply_focus' },
            { label: 'Revert / Cancel', action: 'revert_diff' },
          ],
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        break;
      }

      case 'variants': {
        const count = intent.params?.count || 3;
        onStatus(`Generating ${count} video variants…`);

        const variants = generate3Variants(p.words || [], p.analysis?.duration || 0, {
          proposals: p.proposals || [],
          baseKeeps: p.baseKeeps || [],
        });
        p.variants = variants;
        p.activeVariant = 0;

        const options = variants.map((v, idx) => ({
          label: `${v.title} (~${Math.round(v.targetLen)}s)`,
          action: 'select_variant',
          index: idx,
        }));

        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text: `Generated 3 distinct short-form variants. Click an option to preview:`,
          options,
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        app?.renderVariants?.();
        break;
      }

      case 'refine': {
        const feedback = intent.params?.feedback || '';
        onStatus(`Council debating iteration: "${feedback}"…`);

        if (!p.proposals || !p.proposals.length) {
          p.computeProposals();
        }

        const councilRound = runCouncilRound(p.proposals, {
          stance: p.stance || 'balanced',
          userFeedback: feedback,
          energy: p.analysis?.energy,
          words: p.words,
          hopSec: p.analysis?.hopSec || 0.02,
        });

        p.proposals = councilRound.proposals;
        p.debateSummary = councilRound.summary;

        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text: `${councilRound.summary.text}. Apply these cut recommendations?`,
          options: councilRound.options,
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        app?.renderProposalsBar?.();
        app?.refreshDerived?.();
        break;
      }

      case 'stance': {
        const stance = intent.params?.stance || 'balanced';
        p.stance = stance;
        onStatus(`Switching stance to ${STANCES[stance]?.label || stance}…`);

        if (p.proposals && p.proposals.length) {
          const councilRound = runCouncilRound(p.proposals, {
            stance,
            energy: p.analysis?.energy,
            words: p.words,
            hopSec: p.analysis?.hopSec || 0.02,
          });
          p.proposals = councilRound.proposals;
          p.debateSummary = councilRound.summary;
        }

        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text: `Stance set to ${STANCES[stance]?.label || stance}. Persona weights updated.`,
          options: [
            { label: 'Apply stance cuts', action: 'apply_council' },
            { label: 'Generate 3 variants', action: 'variants' },
            { label: 'Dismiss cuts', action: 'dismiss_council' },
          ],
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        app?.renderProposalsBar?.();
        app?.refreshDerived?.();
        break;
      }

      case 'export': {
        const target = intent.params?.targetOption;
        if (target && p.variants?.length) {
          const idx = /^[abc]/i.test(target)
            ? target.toLowerCase().charCodeAt(0) - 97
            : parseInt(target, 10) - 1;
          if (idx >= 0 && idx < p.variants.length) {
            p.activeVariant = idx;
            app?.selectVariant?.(idx);
          }
        }

        if (!p.edl) {
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'text',
            text: 'No active edit to export yet. Please analyze and apply cuts first.',
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          return;
        }

        const dur = (p.edl.keep || []).reduce((acc, k) => acc + (k.out - k.in), 0).toFixed(1);
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text: `Ready to export MP4 (${dur}s, platform: ${p.settings.platform || 'shorts'}). Confirm to render:`,
          options: [
            { label: '🚀 Confirm & Export MP4', action: 'confirm_export' },
            { label: '⚙️ Export Settings', action: 'open_settings' },
          ],
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        break;
      }

      case 'status': {
        const fileName = p.reg?.items?.find((r) => r.id === p.reg?.arollId)?.file?.name || 'None';
        const dur = p.analysis?.duration ? `${p.analysis.duration.toFixed(1)}s` : '0s';
        const wordsCount = p.words?.length || 0;
        const cutsCount = p.edl?.keep ? (p.proposals?.filter((x) => x.status === 'accepted')?.length || 0) : 0;
        const stanceLabel = STANCES[p.stance]?.label || p.stance || 'balanced';

        const text = `📊 Project Status:\n• File: ${fileName}\n• Duration: ${dur} (${wordsCount} words)\n• Active Stance: ${stanceLabel}\n• Proposals: ${p.proposals?.length || 0} (${cutsCount} accepted)\n• Variants: ${p.variants?.length || 0}`;

        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text,
          options: [
            { label: '3 Style Variants', action: 'variants' },
            { label: 'Debate Council ⚖', action: 'debate' },
            { label: 'Export MP4', action: 'confirm_export' },
          ],
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        break;
      }

      case 'help':
      default: {
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'options-list',
          text: 'You can chat in English or Indonesian. Things I can do:\n• "analyze" — transcribe and propose cuts\n• "focus on <topic>" — draft cut around keywords\n• "give 3 options" — generate 3 variant styles\n• "make it ruthless" / "calm storytelling" — adjust council stance\n• "export" — render MP4',
          options: [
            { label: '🔍 Analyze this video', action: 'analyze' },
            { label: '⚡ Give 3 options', action: 'variants' },
            { label: '🔪 Make it ruthless', action: 'stance_ruthless' },
          ],
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        break;
      }
    }
  }

  /**
   * Handle user action clicked from options-list or plan-diff.
   */
  async handleAction(action, data = {}, callbacks = {}) {
    const { onStatus = () => {}, onMessage = () => {}, onUpdate = () => {} } = callbacks;
    const p = this.p;
    const app = this.app;

    switch (action) {
      case 'pick_folder':
        document.getElementById('pickBtn')?.click();
        break;

      case 'analyze':
        if (!p.words && app?.analyze) {
          await app.analyze();
        } else {
          await this.runStep({ type: 'analyze', params: {} }, callbacks);
        }
        break;

      case 'apply_proposals':
      case 'apply_council': {
        if (app?.applyAllProposals) {
          app.applyAllProposals();
        } else {
          app?.pushUndo?.();
          p.applyProposals();
          app?.rebuild?.();
          app?.renderProposalBar?.();
        }
        const appliedCount = p.proposals?.filter((x) => x.status === 'accepted')?.length || 0;
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'text',
          text: `Applied ${appliedCount} cuts to EDL. Timeline updated.`,
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        onUpdate();
        break;
      }

      case 'dismiss_council': {
        if (app?.dismissAllProposals) {
          app.dismissAllProposals();
        } else {
          app?.pushUndo?.();
          for (const pr of p.proposals || []) pr.status = 'rejected';
          app?.rebuild?.();
          app?.renderProposalBar?.();
        }
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'text',
          text: 'Dismissed all council cuts. Video remains un-cut.',
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        onUpdate();
        break;
      }

      case 'debate': {
        if (app?.debateProposals) {
          await app.debateProposals();
        } else {
          await this.runStep({ type: 'refine', params: { feedback: 'debate' } }, callbacks);
        }
        break;
      }

      case 'variants': {
        await this.runStep({ type: 'variants', params: { count: 3 } }, callbacks);
        break;
      }

      case 'select_variant': {
        const idx = data.index ?? 0;
        p.switchVariant(idx);
        app?.rebuild?.();
        const v = p.variants?.[idx];
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'text',
          text: `Switched to ${v?.title || `Variant ${idx + 1}`}.`,
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        onUpdate();
        break;
      }

      case 'stance_ruthless':
        await this.runStep({ type: 'stance', params: { stance: 'ruthless' } }, callbacks);
        break;

      case 'stance_storyteller':
        await this.runStep({ type: 'stance', params: { stance: 'storyteller' } }, callbacks);
        break;

      case 'stance_balanced':
        await this.runStep({ type: 'stance', params: { stance: 'balanced' } }, callbacks);
        break;

      case 'set_stance': {
        const stance = data.stance || 'balanced';
        await this.runStep({ type: 'stance', params: { stance } }, callbacks);
        break;
      }

      case 'apply_focus': {
        if (this.pendingDiff?.cuts) {
          app?.pushUndo?.();
          const ov = p.activeOverrides || p.overrides;
          const cutsSet = new Set(ov.cuts.filter((c) => typeof c === 'number'));
          for (const c of this.pendingDiff.cuts) cutsSet.add(c);
          ov.cuts = [...cutsSet];
          this.clearDiffHighlight();
          app?.rebuild?.();
          const msg = {
            id: `msg_${Date.now()}`,
            role: 'assistant',
            type: 'text',
            text: `Applied focus edit on "${this.pendingDiff.term}". Cut ${this.pendingDiff.cuts.length} words.`,
            at: Date.now(),
          };
          p.chatLog.push(msg);
          onMessage(msg);
          this.pendingDiff = null;
          onUpdate();
        }
        break;
      }

      case 'revert_diff': {
        this.clearDiffHighlight();
        this.pendingDiff = null;
        const msg = {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          type: 'text',
          text: 'Diff plan cancelled.',
          at: Date.now(),
        };
        p.chatLog.push(msg);
        onMessage(msg);
        onUpdate();
        break;
      }

      case 'confirm_export':
        document.getElementById('exportBtn')?.click();
        break;

      case 'open_settings': {
        const settingsTab = document.querySelector('#rail button[data-panel="settings"]');
        if (settingsTab) settingsTab.click();
        break;
      }

      case 'status':
        await this.runStep({ type: 'status', params: {} }, callbacks);
        break;

      default:
        break;
    }

    app?.saveCurrentProject?.();
  }

  highlightDiffWords(wordIndices = []) {
    const transcript = document.getElementById('transcript');
    if (!transcript) return;
    this.clearDiffHighlight();
    for (const idx of wordIndices) {
      const span = transcript.querySelector(`.w[data-idx="${idx}"]`);
      if (span) span.classList.add('chat-diff-highlight');
    }
  }

  clearDiffHighlight() {
    const transcript = document.getElementById('transcript');
    if (!transcript) return;
    transcript.querySelectorAll('.chat-diff-highlight').forEach((el) => {
      el.classList.remove('chat-diff-highlight');
    });
  }
}
