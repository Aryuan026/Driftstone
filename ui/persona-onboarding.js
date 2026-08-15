function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countMeaningfulLines(text = '') {
  return safeText(text)
    .split('\n')
    .map((line) => safeText(line))
    .filter(Boolean).length;
}

function prettyChars(count) {
  const num = Number(count || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 字';
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万字`;
  return `${num} 字`;
}

function summarizeRole(charName = '', userName = '') {
  const role = safeText(charName);
  const owner = safeText(userName);
  if (role && owner) return `被整理的 AI/角色：${role} · 与它对话的人：${owner}`;
  if (role) return `已看到被整理的 AI/角色：${role}；还需要确认与它对话的人。`;
  if (owner) return `已看到与它对话的人：${owner}；还需要确认被整理的 AI/角色。`;
  return '还没有确认“被整理的 AI/角色”和“与它对话的人”。';
}

function stripDefaultPlaceholderName(value = '', placeholder = '') {
  const text = safeText(value);
  return text && text !== placeholder ? text : '';
}

export function buildPersonaOnboardingState(workspace = {}) {
  const charName = stripDefaultPlaceholderName(workspace.charName || workspace.char_name, 'Companion');
  const userName = stripDefaultPlaceholderName(workspace.userName || workspace.user_name, 'You');
  const personaCard = safeText(workspace.personaCard || workspace.persona_card);
  const languageFingerprint = safeText(workspace.languageFingerprint || workspace.language_fingerprint);
  const fingerprintCandidatePool = safeText(
    workspace.fingerprintCandidatePool || workspace.fingerprint_candidate_pool
  );
  const personaCacheTotal = Number(workspace.personaCacheTotal || workspace.persona_cache_total || 0);

  const roleReady = Boolean(charName && userName);
  const personaReady = Boolean(personaCard);
  const fingerprintReady = Boolean(languageFingerprint);
  const hasDraftSignals = Boolean(
    roleReady
    || charName
    || userName
    || personaReady
    || fingerprintReady
    || fingerprintCandidatePool
    || personaCacheTotal > 0
  );
  const missing = [];
  if (!roleReady) {
    missing.push({
      key: 'role_relationship',
      label: '角色 / 对话者',
      detail: '分别确认被整理的 AI/角色是谁，以及与它对话的人是谁。'
    });
  }
  if (!personaReady) {
    missing.push({
      key: 'persona_soul',
      label: '人格 / Soul',
      detail: '还没有可作为人格连续性权威的说明。'
    });
  }
  if (!fingerprintReady) {
    missing.push({
      key: 'language_fingerprint',
      label: '语言指纹',
      detail: '还没有用于保持说话方式的语言指纹。'
    });
  }

  const status = roleReady && personaReady && fingerprintReady
    ? 'ready'
    : hasDraftSignals
      ? 'partial'
      : 'none';

  const summary = [
    summarizeRole(charName, userName),
    personaReady ? `人格 / Soul：${prettyChars(personaCard.length)}` : '',
    fingerprintReady ? `语言指纹：${countMeaningfulLines(languageFingerprint)} 行` : '',
    !personaReady && fingerprintCandidatePool ? '已经有语言指纹候选池，可继续整理成正式指纹。' : '',
    !personaReady && personaCacheTotal > 0 ? `已有 ${personaCacheTotal} 条历史信号，可先生成可审草稿。` : ''
  ].filter(Boolean);

  return {
    status,
    tone: status === 'ready' ? 'ready' : status === 'partial' ? 'partial' : 'none',
    roleReady,
    personaReady,
    fingerprintReady,
    missing,
    summary,
    sourcePrepareAllowed: true,
    warmGrowthPersonaReady: status === 'ready',
    impact: status === 'ready'
      ? '温记忆生长可以把这份工作台作为声线权威。'
      : 'source 准备可以继续；依赖人格/声线的温记忆生长需要等权威补齐后再放行。'
  };
}

function renderMissingList(missing = []) {
  if (!missing.length) {
    return '<li>角色/关系、人格 / Soul、语言指纹都已接上。</li>';
  }
  return missing.map((item) => `
    <li>
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </li>
  `).join('');
}

function renderActions(state, legacyHref, historyHref) {
  if (state.status === 'ready') {
    return `
      <a class="btn primary persona-onboarding-action" href="${escapeHtml(historyHref)}">确认无误，继续选择历史</a>
      <a class="btn secondary persona-onboarding-action" href="${escapeHtml(legacyHref)}" target="_blank" rel="noopener noreferrer">编辑角色与声线</a>
    `;
  }
  if (state.status === 'partial') {
    return `
      <a class="btn primary persona-onboarding-action" href="${escapeHtml(legacyHref)}" target="_blank" rel="noopener noreferrer">补齐或生成草稿</a>
      <a class="btn secondary persona-onboarding-action" href="${escapeHtml(historyHref)}">先准备 source history</a>
    `;
  }
  return `
    <a class="btn primary persona-onboarding-action" href="${escapeHtml(legacyHref)}" target="_blank" rel="noopener noreferrer">导入或生成角色/声线草稿</a>
    <a class="btn secondary persona-onboarding-action" href="${escapeHtml(historyHref)}">不确定，先整理历史</a>
  `;
}

export function renderPersonaOnboarding({
  panelEl,
  workspace = {},
  legacyHref = './legacy/index.html?tab=t8&focus=persona-style',
  historyHref = '#workflowControls'
} = {}) {
  const state = buildPersonaOnboardingState(workspace);
  if (!panelEl) return state;

  const statusLabel = state.status === 'ready'
    ? '已就绪'
    : state.status === 'partial'
      ? '还差一点'
      : '尚未设置';
  const summaryHtml = state.summary.map((line) => `<p>${escapeHtml(line)}</p>`).join('');

  panelEl.dataset.personaState = state.status;
  panelEl.innerHTML = `
    <div class="persona-onboarding-main">
      <div class="persona-onboarding-copy">
        <p class="eyebrow">生长前检查</p>
        <h2>你已经有一份想保留的人设 / 说话方式吗？</h2>
        <p class="persona-onboarding-lead">
          Driftstone 会先读取唯一的人格工作台。这里不保存第二份人设，只帮你判断现在适合继续哪一步。
        </p>
      </div>
      <span class="status-pill ${state.tone === 'ready' ? 'ready' : 'stable'}">${escapeHtml(statusLabel)}</span>
    </div>
    <div class="persona-onboarding-grid">
      <div class="persona-onboarding-summary" aria-label="安全的人格工作台摘要">
        ${summaryHtml}
        <p class="persona-onboarding-safe-note">这里只显示角色、计数和就绪状态；不会展示人设正文、原文、API key 或私密文件路径。</p>
      </div>
      <div class="persona-onboarding-missing">
        <strong>还缺什么</strong>
        <ul>${renderMissingList(state.missing)}</ul>
      </div>
    </div>
    <p class="persona-onboarding-impact">${escapeHtml(state.impact)}</p>
    <div class="persona-onboarding-actions">
      ${renderActions(state, legacyHref, historyHref)}
    </div>
  `;
  return state;
}
