import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildPortableWarmBundle } from '../core/portable-warm-bundle-builder.js';
import { exportPortableWarmProjection } from '../core/portable-warm-projection-exporter.js';

function buildGrowthDraftArtifact({ sourceFile = '/tmp/projection-source.json' } = {}) {
  return {
    artifact_id: 'memo_projection_001',
    logical_candidate_id: 'warm_logic_projection_001',
    generated_at: '2026-08-15T00:00:00.000Z',
    scope: {
      owner_id: 'owner',
      realm_id: 'realm'
    },
    task: {},
    draft: {
      decision: 'new',
      frontmatter: {
        title: 'Projection warm memory'
      },
      body: {
        snapshot: 'A portable warm projection keeps the scene readable.',
        context: 'The card stays reviewable while the source span remains separate.',
        follow_up: ['Use this card only as a projection fixture.']
      },
      source_review: {
        primary_evidence: {
          source_scene_snippets: [
            {
              source_bundle_id: 'bundle_projection',
              file: sourceFile,
              source_window_title: 'Projection source window',
              source_msg_range: '4-5',
              speaker: 'assistant',
              excerpt_text: 'This exact source quote is available in the local projection.'
            }
          ]
        }
      }
    }
  };
}

test('projection exporter writes local markdown, obsidian, and notion-ready files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-projection-'));
  try {
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z',
      growthDraftArtifacts: [buildGrowthDraftArtifact()]
    });
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    const outputRoot = join(dir, 'projection-output');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    const result = await exportPortableWarmProjection({
      bundlePath,
      outputRoot
    });

    assert.equal(result.ok, true);
    assert.equal(result.projection_status, 'projection_written');
    assert.equal(result.manifest.canonical_truth, false);
    assert.equal(result.manifest.write_boundary.notion_written, false);
    assert.equal(result.counts.warm_cards, 1);
    assert.equal(result.counts.source_spans, 1);

    const entry = await readFile(result.output.files.chat_human_entry_md, 'utf8');
    assert.match(entry, /review-backflow anchors/);
    assert.match(entry, /Patch validation\/apply is not implemented/);
    assert.match(entry, /not canonical truth/i);

    const warmReview = await readFile(result.output.files.warm_cards_md, 'utf8');
    assert.equal((warmReview.match(/# Projection warm memory/g) || []).length, 0);
    assert.equal((warmReview.match(/## 1\. Projection warm memory/g) || []).length, 1);

    const warmRows = (await readFile(result.output.files.notion_warm_cards_jsonl, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(warmRows.length, 1);
    assert.equal(warmRows[0].target_database, 'portable_warm_cards');
    assert.equal(warmRows[0].notion_page_id, '');
    assert.match(warmRows[0].notion_sync_hash, /^sha256:/);

    const sourceRows = (await readFile(result.output.files.notion_source_spans_jsonl, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(sourceRows[0].source_only, true);
    assert.equal(sourceRows[0].source_file, 'projection-source.json');
    assert.match(sourceRows[0].source_file_digest, /^sha256:/);
    assert.equal(sourceRows[0].excerpt_text, 'This exact source quote is available in the local projection.');

    const roundtrip = JSON.parse(await readFile(result.output.files.roundtrip_map_json, 'utf8'));
    assert.equal(roundtrip[0].candidate_id, warmRows[0].candidate_id);
    assert.equal(roundtrip[0].notion_page_id, '');

    const obsidianIndex = await readFile(result.output.files.obsidian_index_md, 'utf8');
    assert.match(obsidianIndex, /\[\[Warm Cards\//);

    const manifest = JSON.parse(await readFile(result.output.files.projection_manifest_json, 'utf8'));
    assert.equal(manifest.files.chat_human_entry_md, '00_chat_human_entry.md');
    assert.equal(manifest.files.notion_warm_cards_jsonl, 'notion/portable_warm_cards.jsonl');
    assert.equal(JSON.stringify(manifest).includes(outputRoot), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projection exporter blocks invalid bundles before writing projection files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-projection-invalid-'));
  try {
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, `${JSON.stringify({
      schema: 'not_the_contract',
      warm_cards: []
    })}\n`, 'utf8');

    const result = await exportPortableWarmProjection({
      bundlePath,
      outputRoot: join(dir, 'projection-output')
    });

    assert.equal(result.ok, false);
    assert.equal(result.projection_status, 'blocked_by_contract_errors');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projection exporter blocks output roots outside local export boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-projection-boundary-'));
  try {
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z',
      growthDraftArtifacts: [buildGrowthDraftArtifact()]
    });
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    const result = await exportPortableWarmProjection({
      bundlePath,
      outputRoot: '/driftstone-output-root-not-allowed'
    });

    assert.equal(result.ok, false);
    assert.equal(result.projection_status, 'blocked_by_output_boundary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projection exporter blocks obvious private paths in projected text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftstone-projection-privacy-'));
  try {
    const bundle = buildPortableWarmBundle({
      scope: {
        owner_id: 'owner',
        realm_id: 'realm'
      },
      generatedAt: '2026-08-15T00:00:00.000Z',
      growthDraftArtifacts: [buildGrowthDraftArtifact()]
    });
    bundle.warm_cards[0].portable_warm_card.living_fragment = 'Synthetic text mentions /Users/example/private.txt.';
    const bundlePath = join(dir, 'portable_warm_bundle.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

    const result = await exportPortableWarmProjection({
      bundlePath,
      outputRoot: join(dir, 'projection-output')
    });

    assert.equal(result.ok, false);
    assert.equal(result.projection_status, 'blocked_by_privacy_preflight');
    assert.equal(result.privacy_preflight.hits[0].reason, 'absolute_private_path');
    assert.equal(JSON.stringify(result).includes('/Users/example/private.txt'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projection exporter sanitizes source_file paths across host operating systems', async () => {
  const cases = [
    {
      sourceFile: 'C:\\Users\\Alice\\private\\history.json',
      expectedLabel: 'history.json',
      forbidden: ['C:\\Users\\Alice', 'private\\history.json']
    },
    {
      sourceFile: '\\\\server\\share\\private\\history.json',
      expectedLabel: 'history.json',
      forbidden: ['\\\\server\\share', 'private\\history.json']
    },
    {
      sourceFile: '/Users/alice/private/history.json',
      expectedLabel: 'history.json',
      forbidden: ['/Users/alice/private']
    },
    {
      sourceFile: '/home/alice/private/history.json',
      expectedLabel: 'history.json',
      forbidden: ['/home/alice/private']
    }
  ];

  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'driftstone-projection-path-'));
    try {
      const bundle = buildPortableWarmBundle({
        scope: {
          owner_id: 'owner',
          realm_id: 'realm'
        },
        generatedAt: '2026-08-15T00:00:00.000Z',
        growthDraftArtifacts: [buildGrowthDraftArtifact({ sourceFile: item.sourceFile })]
      });
      const bundlePath = join(dir, 'portable_warm_bundle.json');
      const outputRoot = join(dir, 'projection-output');
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

      const result = await exportPortableWarmProjection({
        bundlePath,
        outputRoot
      });

      assert.equal(result.ok, true);
      const text = await readFile(result.output.files.notion_source_spans_jsonl, 'utf8');
      const rows = text.trim().split('\n').map(JSON.parse);
      assert.equal(rows[0].source_file, item.expectedLabel);
      const sourceSpanDir = join(result.output.dir, 'obsidian', 'Source Spans');
      const sourceSpanFiles = await readdir(sourceSpanDir);
      const sourceSpanMarkdown = (await Promise.all(
        sourceSpanFiles.map((file) => readFile(join(sourceSpanDir, file), 'utf8'))
      )).join('\n');
      const allProjectedText = JSON.stringify(result) + text + sourceSpanMarkdown;
      for (const forbidden of item.forbidden) {
        assert.equal(allProjectedText.includes(forbidden), false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
