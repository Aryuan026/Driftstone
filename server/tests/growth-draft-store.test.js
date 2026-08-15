import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = await mkdtemp(join(tmpdir(), 'driftstone-growth-draft-store-'));
process.env.HIPPOCOVE_DATA_ROOT = dataRoot;

const {
  getGrowthDraftArtifact,
  saveGrowthDraftArtifact
} = await import('../core/growth-draft-store.js');
const { buildPortableWarmBundle } = await import('../core/portable-warm-bundle-builder.js');
const { validatePortableWarmBundle } = await import('../core/portable-warm-bundle-contract.js');

function buildDraft(snapshot, snippetOverrides = {}) {
  return {
    decision: 'new',
    frontmatter: {
      title: 'Same logical warm card',
      family: 'synthetic-family'
    },
    body: {
      snapshot,
      context: 'The synthetic card has a stable upstream task identity.',
      follow_up: ['Use only for identity regression tests.']
    },
    markdown: `# Same logical warm card\n\n${snapshot}`,
    source_review: {
      primary_evidence: {
        source_scene_snippets: [
          {
            source_bundle_id: 'bundle_001',
            file: '/Users/alice/private/history.jsonl',
            source_window_id: 'window_001',
            source_window_title: 'Synthetic window',
            source_msg_range: '1-2',
            message_ids: ['msg_001', 'msg_002'],
            speaker: 'assistant',
            excerpt_text: 'This is a bounded quote for the same logical warm card.',
            ...snippetOverrides
          }
        ]
      }
    }
  };
}

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test('growth draft saves use distinct revision ids but stable logical candidate ids', async () => {
  const ownerId = 'owner-growth';
  const realmId = 'realm-growth';
  const generatedAt = '2026-08-15T00:00:00.000Z';
  const common = {
    ownerId,
    realmId,
    cardType: 'memo',
    familyId: 'synthetic-family',
    generatedAt
  };

  const first = await saveGrowthDraftArtifact({
    ...common,
    task: {
      task_id: 'run_specific_task_one'
    },
    draft: buildDraft('First revision body.', {
      file: '/Users/alice/private/history.jsonl'
    })
  });
  const second = await saveGrowthDraftArtifact({
    ...common,
    task: {
      task_id: 'run_specific_task_two'
    },
    draft: buildDraft('Second revision body.', {
      file: '/data/imports/history.jsonl'
    })
  });

  assert.notEqual(first.artifact_id, second.artifact_id);
  assert.equal(first.logical_candidate_id, second.logical_candidate_id);

  const firstArtifact = await getGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: 'memo',
    artifactId: first.artifact_id
  });
  const secondArtifact = await getGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: 'memo',
    artifactId: second.artifact_id
  });
  assert.equal(firstArtifact.logical_candidate_id, secondArtifact.logical_candidate_id);

  const firstBundle = buildPortableWarmBundle({
    scope: {
      owner_id: ownerId,
      realm_id: realmId
    },
    generatedAt,
    growthDraftArtifacts: [firstArtifact]
  });
  const secondBundle = buildPortableWarmBundle({
    scope: {
      owner_id: ownerId,
      realm_id: realmId
    },
    generatedAt,
    growthDraftArtifacts: [secondArtifact]
  });

  assert.equal(validatePortableWarmBundle(firstBundle).ok, true);
  assert.equal(validatePortableWarmBundle(secondBundle).ok, true);
  assert.equal(firstBundle.warm_cards[0].candidate_id, secondBundle.warm_cards[0].candidate_id);
  assert.notEqual(firstBundle.manifest.manifest_digest, secondBundle.manifest.manifest_digest);
  assert.equal(JSON.stringify(firstBundle).includes('/Users/alice'), false);
  assert.equal(JSON.stringify(secondBundle).includes('/Users/alice'), false);
});
