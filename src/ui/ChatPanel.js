// ChatPanel.js — Permanent collapsible AI Chat sidebar for ChatDirector.
// DOM presentation layer: thin event wiring, English strings, project state observation.
// Part of Nila Sprint 3.

const $ = (id) => document.getElementById(id);

function limitEmojis(str, max = 1) {
  if (!str) return str;
  let count = 0;
  return str.replace(/\p{Extended_Pictographic}/gu, (match) => {
    count++;
    return count <= max ? match : '';
  });
}

export class ChatPanel {
  constructor(app, director, project) {
    this.app = app;
    this.director = director;
    this.p = project;
    this.sidebar = $('chatSidebar');
    this.messagesEl = $('chatMessages');
    this.statusLineEl = $('chatStatusLine');
    this.tickerEl = $('chatStatusTicker');
    this.suggestionsEl = $('chatSuggestions');
    this.formEl = $('chatForm');
    this.inputEl = $('chatInput');
    this.toggleBtn = $('chatToggleBtn');
    this.closeBtn = $('closeChatSidebarBtn');

    this.isOpen = false;
    this.init();
  }

  init() {
    if (this.toggleBtn) {
      this.toggleBtn.onclick = () => this.toggle();
    }
    if (this.closeBtn) {
      this.closeBtn.onclick = () => this.close();
    }
    if (this.formEl) {
      this.formEl.onsubmit = (e) => {
        e.preventDefault();
        this.submit();
      };
    }
    if (this.inputEl) {
      this.inputEl.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.close();
        }
      };
    }

    // Default suggestions
    this.renderSuggestions([
      '🔍 Analyze this video',
      '⚡ Give me 3 short options',
      '🎯 Focus on keyword',
      '🔪 Make it ruthless',
    ]);

    // Initial render
    this.renderStatusLine();
    this.renderMessages();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.isOpen = true;
    if (this.sidebar) this.sidebar.style.display = 'flex';
    if (this.toggleBtn) this.toggleBtn.classList.add('on');
    this.renderStatusLine();
    this.renderMessages();
    setTimeout(() => this.inputEl?.focus(), 50);
    this.scrollToBottom();
  }

  close() {
    this.isOpen = false;
    if (this.sidebar) this.sidebar.style.display = 'none';
    if (this.toggleBtn) this.toggleBtn.classList.remove('on');
  }

  renderStatusLine() {
    if (!this.statusLineEl) return;
    const fileName = this.p.reg?.items?.find((r) => r.id === this.p.reg?.arollId)?.file?.name || 'No file';
    const dur = this.p.analysis?.duration ? `${this.p.analysis.duration.toFixed(1)}s` : '0s';
    const cuts = this.p.proposals?.filter((x) => x.status === 'accepted')?.length ?? 0;
    const stance = this.p.stance || 'balanced';
    this.statusLineEl.textContent = `${fileName} · ${dur} · ${cuts} cuts · ${stance}`;
  }

  renderSuggestions(suggestions = []) {
    if (!this.suggestionsEl) return;
    this.suggestionsEl.innerHTML = '';
    for (const s of suggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-chip';
      chip.textContent = s;
      chip.onclick = () => {
        // Strip leading icon if any
        const clean = s.replace(/^[\p{Emoji}\s]+/u, '').trim();
        if (this.inputEl) {
          this.inputEl.value = clean;
          this.submit();
        }
      };
      this.suggestionsEl.appendChild(chip);
    }
  }

  renderMessages() {
    if (!this.messagesEl) return;
    this.messagesEl.innerHTML = '';
    const log = this.p.chatLog || [];
    if (!log.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--ink-2);font-style:italic;text-align:center;padding:24px 8px;font-size:12px';
      empty.textContent = 'Welcome to Nila Chat. Ask to analyze, focus on keywords, generate 3 variants, or adjust editorial stance.';
      this.messagesEl.appendChild(empty);
      return;
    }
    for (const msg of log) {
      this.appendMessage(msg, false);
    }
    this.scrollToBottom();
  }

  appendMessage(msg, scroll = true) {
    if (!this.messagesEl) return;
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${msg.role || 'assistant'}`;
    wrap.dataset.id = msg.id || '';

    // Text content (enforce max 1 emoji per message)
    if (msg.text) {
      const textDiv = document.createElement('div');
      textDiv.className = 'chat-msg-text';
      textDiv.textContent = limitEmojis(msg.text, 1);
      wrap.appendChild(textDiv);
    }

    // Plan diff card
    if (msg.type === 'plan-diff' && msg.diff) {
      const diffCard = document.createElement('div');
      diffCard.className = 'chat-diff-box';
      diffCard.innerHTML = `
        <div style="font-weight:600;margin-bottom:3px">${this.escapeHtml(msg.diff.label || 'Plan Diff')}</div>
        <div style="color:var(--ink-2);margin-bottom:6px">${this.escapeHtml(msg.diff.explanation || '')}</div>
      `;
      const actions = document.createElement('div');
      actions.className = 'chat-diff-actions';
      for (const opt of msg.options || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tbtn ${opt.action.includes('apply') ? 'primary' : ''}`;
        btn.style.cssText = 'width:auto;font-size:11px;padding:3px 9px';
        btn.textContent = opt.label;
        btn.onclick = () => this.handleActionClick(opt);
        actions.appendChild(btn);
      }
      diffCard.appendChild(actions);
      wrap.appendChild(diffCard);
    } else if (msg.type === 'options-list' && msg.options?.length) {
      // Options button group
      const optGroup = document.createElement('div');
      optGroup.className = 'chat-options-group';
      for (const opt of msg.options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `chat-opt-btn ${opt.recommended ? 'recommended' : ''}`;
        btn.textContent = opt.label;
        btn.onclick = () => this.handleActionClick(opt);
        optGroup.appendChild(btn);
      }
      wrap.appendChild(optGroup);
    }

    this.messagesEl.appendChild(wrap);
    if (scroll) this.scrollToBottom();
  }

  updateTicker(statusText) {
    if (!this.tickerEl) return;
    if (statusText) {
      this.tickerEl.textContent = `⏳ ${statusText}`;
      this.tickerEl.style.display = 'block';
    } else {
      this.tickerEl.textContent = '';
      this.tickerEl.style.display = 'none';
    }
  }

  scrollToBottom() {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  async submit() {
    const text = this.inputEl?.value.trim();
    if (!text) return;
    if (this.inputEl) this.inputEl.value = '';

    await this.director.processMessage(text, {
      onStatus: (st) => this.updateTicker(st),
      onMessage: (msg) => this.appendMessage(msg),
      onUpdate: () => {
        this.renderStatusLine();
        this.app?.drawAll?.();
      },
    });
  }

  async handleActionClick(opt) {
    this.updateTicker(`Executing: ${opt.label}…`);
    await this.director.handleAction(opt.action, opt, {
      onStatus: (st) => this.updateTicker(st),
      onMessage: (msg) => this.appendMessage(msg),
      onUpdate: () => {
        this.renderStatusLine();
        this.app?.drawAll?.();
      },
    });
    this.updateTicker('');
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
