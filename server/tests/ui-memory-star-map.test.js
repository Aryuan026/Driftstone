import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryStarMapModel, renderMemoryStarMap } from '../../ui/memory-star-map.js';

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
  assert.doesNotMatch(visualEl.innerHTML, /canonical relationship line/);
});
