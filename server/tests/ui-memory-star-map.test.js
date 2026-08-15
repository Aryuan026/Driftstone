import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryStarMapModel, renderMemoryRunDock, renderMemoryStarMap } from '../../ui/memory-star-map.js';
import { buildSyntheticDemoSnapshot } from '../../ui/synthetic-demo.js';

test('memory star map model projects drafts and committed cards without inventing canonical edges', () => {
  const model = buildMemoryStarMapModel({
    growth_drafts: {
      drafts: [
        { artifact_id: 'draft-a', title: 'Draft A', card_type: 'memo', generated_at: '2026-01-01T00:00:00.000Z' },
        { artifact_id: 'draft-b', title: 'Draft B', card_type: 'unknown', generated_at: '2026-01-02T00:00:00.000Z' }
      ]
    },
    staging_cards: {
      cards: [
        { file_path: 'stable-fact.md', title: 'Stable fact', card_type: 'fact', updated_at: '2026-01-03T00:00:00.000Z' }
      ]
    }
  });

  assert.equal(model.total, 3);
  assert.equal(model.counts.draft, 2);
  assert.equal(model.counts.committed, 1);
  assert.equal(model.counts.memo, 2);
  assert.equal(model.counts.fact, 1);
  assert.equal(model.hubs.every((hub) => !hub.canonical), true);
  assert.equal(model.stars.every((star) => star.parent.endsWith('-hub')), true);
});

test('memory star map keeps explicit relation lines separate from visual affinity', () => {
  const model = buildMemoryStarMapModel(buildSyntheticDemoSnapshot());

  assert.equal(model.total, 14);
  assert.equal(model.counts.committed, 12);
  assert.equal(model.counts.draft, 2);
  assert.equal(model.explicitEdges.length, 3);
  assert.equal(model.explicitEdges.every((edge) => edge.from && edge.to), true);
});

test('memory star map render keeps visual affinity boundary visible', () => {
  const visualEl = { innerHTML: '' };
  const statusEl = { textContent: '', className: '' };

  renderMemoryStarMap({
    visualEl,
    statusEl,
    snapshot: {
      active_scope: { owner_id: 'owner', realm_id: 'realm' },
      growth_drafts: {
        drafts: [
          { artifact_id: 'draft-a', title: 'Draft A', card_type: 'memo', generated_at: '2026-01-01T00:00:00.000Z' }
        ]
      }
    },
    workspace: { charName: 'Demo' }
  });

  assert.equal(statusEl.textContent, 'Live map');
  assert.match(statusEl.className, /live/);
  assert.match(visualEl.innerHTML, /Memory Star Map/);
  assert.match(visualEl.innerHTML, /visual affinity, not canonical edges/);
  assert.doesNotMatch(visualEl.innerHTML, /front-growth-link canonical/);
  assert.doesNotMatch(visualEl.innerHTML, /canonical relationship line/);
});

test('synthetic demo renders explicit demo lines and no private local path shape', () => {
  const snapshot = buildSyntheticDemoSnapshot();
  const visualEl = { innerHTML: '' };
  const statusEl = { textContent: '', className: '' };

  renderMemoryStarMap({ visualEl, statusEl, snapshot });

  assert.equal(snapshot.demo.synthetic, true);
  assert.equal(statusEl.textContent, 'Demo map');
  assert.match(visualEl.innerHTML, /front-growth-link canonical/);
  assert.match(visualEl.innerHTML, /Synthetic showcase memory field/);
  assert.doesNotMatch(JSON.stringify(snapshot), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-[A-Za-z0-9]/);
});

test('memory run dock renders human workflow state without adding pipeline truth', () => {
  const dockEl = { innerHTML: '', dataset: {} };
  renderMemoryRunDock({
    dockEl,
    run: {
      tone: 'live',
      phaseLabel: 'Growing Warm cards',
      headline: 'Organizing 2/5 cards.',
      detail: 'Card growth is following durable runtime state.',
      progress: 43,
      steps: [
        { label: 'Choose history', state: 'done' },
        { label: 'Organize', state: 'done' },
        { label: 'Review', state: 'current' },
        { label: 'Export', state: 'pending' }
      ],
      metrics: [
        { label: 'Warm cards', value: '5' },
        { label: 'tasks', value: '2' }
      ]
    }
  });

  assert.equal(dockEl.dataset.tone, 'live');
  assert.match(dockEl.innerHTML, /Growing Warm cards/);
  assert.match(dockEl.innerHTML, /width: 43%;/);
  assert.match(dockEl.innerHTML, /Choose history/);
  assert.match(dockEl.innerHTML, /Warm cards/);
  assert.doesNotMatch(dockEl.innerHTML, /source span ledger packet/);
});
