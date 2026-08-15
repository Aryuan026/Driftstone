import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPersonaOnboardingState,
  renderPersonaOnboarding
} from '../../ui/persona-onboarding.js';

test('persona onboarding classifies an empty canonical workspace without blocking source prep', () => {
  const state = buildPersonaOnboardingState({});

  assert.equal(state.status, 'none');
  assert.equal(state.sourcePrepareAllowed, true);
  assert.equal(state.warmGrowthPersonaReady, false);
  assert.deepEqual(state.missing.map((item) => item.key), [
    'role_relationship',
    'persona_soul',
    'language_fingerprint'
  ]);
});

test('persona onboarding does not treat default placeholder names as confirmed roles', () => {
  const state = buildPersonaOnboardingState({
    charName: 'Companion',
    userName: 'You'
  });

  assert.equal(state.status, 'none');
  assert.equal(state.roleReady, false);
  assert.equal(state.missing[0].key, 'role_relationship');
});

test('persona onboarding reports partial state and exact missing authority', () => {
  const state = buildPersonaOnboardingState({
    charName: 'Starling',
    personaCard: 'A compact persona description',
    personaCacheTotal: 8
  });

  assert.equal(state.status, 'partial');
  assert.equal(state.roleReady, false);
  assert.equal(state.personaReady, true);
  assert.equal(state.fingerprintReady, false);
  assert.deepEqual(state.missing.map((item) => item.key), [
    'role_relationship',
    'language_fingerprint'
  ]);
});

test('persona onboarding treats role, persona, and language fingerprint as ready across reloads', () => {
  const workspace = {
    charName: 'Starling',
    userName: 'Aster',
    personaCard: 'A'.repeat(240),
    languageFingerprint: 'soft line\nworking line\nboundary line'
  };

  const first = buildPersonaOnboardingState(workspace);
  const second = buildPersonaOnboardingState({ ...workspace });

  assert.equal(first.status, 'ready');
  assert.equal(first.warmGrowthPersonaReady, true);
  assert.equal(second.status, first.status);
  assert.deepEqual(second.missing, first.missing);
});

test('persona onboarding render is body-safe and keeps synthetic/private text out of the page', () => {
  const panelEl = { innerHTML: '', dataset: {} };
  const rawBody = [
    'PRIVATE_BODY',
    'sk-DO-NOT-SHOW',
    '/Users/example/private/history.json'
  ].join('\n');

  const state = renderPersonaOnboarding({
    panelEl,
    workspace: {
      charName: 'Starling',
      userName: 'Aster',
      personaCard: rawBody,
      languageFingerprint: rawBody
    }
  });

  assert.equal(state.status, 'ready');
  assert.equal(panelEl.dataset.personaState, 'ready');
  assert.match(panelEl.innerHTML, /被整理的 AI\/角色：Starling/);
  assert.match(panelEl.innerHTML, /与它对话的人：Aster/);
  assert.match(panelEl.innerHTML, /不会展示人设正文/);
  assert.doesNotMatch(panelEl.innerHTML, /PRIVATE_BODY/);
  assert.doesNotMatch(panelEl.innerHTML, /sk-DO-NOT-SHOW/);
  assert.doesNotMatch(panelEl.innerHTML, /\/Users\/example/);
});
