import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const dataRoot = await mkdtemp(join(tmpdir(), 'driftstone-obsidian-export-'));
process.env.DRIFTSTONE_DATA_ROOT = dataRoot;
process.env.DRIFTSTONE_OUTPUT_ROOT = join(dataRoot, 'output');
process.env.DRIFTSTONE_OBSIDIAN_ROOT = join(dataRoot, 'obsidian');

const { saveGrowthDraftArtifact } = await import('../core/growth-draft-store.js');
const { exportGrowthDraftToObsidianStaging } = await import('../core/obsidian-export-service.js');
const { callTool } = await import('../mcp/tool-dispatch.js');

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const privateLiteralPatterns = [
  '\u963f\u9701',
  '\u963f\u9e22',
  '\u5979\u4e3a\u4ec0\u4e48',
  '\u5979\u8bf4\u8bdd',
  '\u5973\u6027'
];

function assertNoPrivatePersonaLiterals(text = '') {
  for (const pattern of privateLiteralPatterns) {
    assert.equal(String(text).includes(pattern), false, `unexpected private literal: ${pattern}`);
  }
}

function publicDraft({
  title = 'Identity continuity',
  shapeLabel = '自我定义',
  memoryShape = 'self_definition',
  charName = 'Nimbus',
  userName = 'Rowan',
  memoId = 'memo_public_identity'
} = {}) {
  return {
    frontmatter: {
      memo_id: memoId,
      title,
      family: `${charName || 'subject'}-${userName || 'counterpart'}`,
      memory_shape: memoryShape,
      shape_label: shapeLabel,
      char_name: charName,
      user_name: userName,
      inject_short: 'A public synthetic card keeps continuity source-backed.',
      activation_triggers: ['identity continuity', 'source-backed review'],
      voice_fingerprint: ['steady and concise']
    },
    body: {
      snapshot: 'The synthetic subject keeps source-backed continuity without copying private runtime identity.',
      context: 'source-backed import review',
      scene_handles: ['public synthetic source'],
      recall_facts: ['persona authority comes from explicit input fields'],
      follow_up: ['Use as a public regression fixture only.']
    },
    card_entry: {
      card_id: `${memoId}_card`,
      char_name: charName,
      user_name: userName,
      source_packet_id: `${memoId}_packet`
    },
    markdown: '# Public synthetic memory draft\n'
  };
}

test('Obsidian export uses explicit public subject labels instead of private defaults', async () => {
  const ownerId = 'public-owner';
  const realmId = 'public-obsidian-service';
  const saved = await saveGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: 'memo',
    familyId: 'public-family',
    task: {
      task_id: 'task-public-identity',
      runtime_pack: {
        char_name: 'Nimbus',
        user_name: 'Rowan'
      }
    },
    draft: publicDraft(),
    generatedAt: '2026-08-20T00:00:00.000Z'
  });

  const result = await exportGrowthDraftToObsidianStaging({
    ownerId,
    realmId,
    artifactId: saved.artifact_id,
    cardType: 'memo',
    rootDir: join(dataRoot, 'obsidian-direct'),
    overwrite: true,
    includeContent: true
  });

  assert.equal(result.ok, true);
  const memo = result.files.find((item) => item.kind === 'memo');
  assert.ok(memo?.markdown);
  assert.match(memo.markdown, /subject_name: "Nimbus"/);
  assert.match(memo.markdown, /counterpart_name: "Rowan"/);
  assert.match(memo.markdown, /讨论“Nimbus是谁”/);
  assertNoPrivatePersonaLiterals(memo.markdown);
  assert.equal(memo.markdown.includes('\u5979'), false);
});

test('Obsidian export stays neutral when no subject labels are provided', async () => {
  const ownerId = 'public-owner';
  const realmId = 'public-obsidian-neutral';
  const draft = publicDraft({
    title: 'Interaction protocol',
    shapeLabel: '方法协议',
    memoryShape: 'method_protocol',
    charName: '',
    userName: '',
    memoId: 'memo_public_neutral'
  });
  const saved = await saveGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: 'memo',
    familyId: 'public-family',
    task: { task_id: 'task-public-neutral' },
    draft,
    generatedAt: '2026-08-20T00:01:00.000Z'
  });

  const result = await exportGrowthDraftToObsidianStaging({
    ownerId,
    realmId,
    artifactId: saved.artifact_id,
    cardType: 'memo',
    rootDir: join(dataRoot, 'obsidian-neutral'),
    overwrite: true,
    includeContent: true
  });

  assert.equal(result.ok, true);
  const memo = result.files.find((item) => item.kind === 'memo');
  assert.ok(memo?.markdown);
  assert.match(memo.markdown, /记忆主体与对话对象/);
  assertNoPrivatePersonaLiterals(memo.markdown);
  assert.equal(memo.markdown.includes('\u5979'), false);
});

test('MCP Obsidian export shares the same neutral projection service', async () => {
  const ownerId = 'public-owner';
  const realmId = 'public-obsidian-mcp';
  const saved = await saveGrowthDraftArtifact({
    ownerId,
    realmId,
    cardType: 'memo',
    familyId: 'public-family',
    task: {
      task_id: 'task-public-mcp',
      runtime_pack: {
        char_name: 'Nimbus',
        user_name: 'Rowan'
      }
    },
    draft: publicDraft({ memoId: 'memo_public_mcp' }),
    generatedAt: '2026-08-20T00:02:00.000Z'
  });

  const result = await callTool('export_growth_draft_to_obsidian', {
    owner_id: ownerId,
    realm_id: realmId,
    artifact_id: saved.artifact_id,
    card_type: 'memo',
    root_dir: join(dataRoot, 'obsidian-mcp'),
    overwrite: true
  });

  assert.equal(result.ok, true);
  const markdown = await readFile(result.export_file, 'utf8');
  assert.match(markdown, /subject_name: "Nimbus"/);
  assert.match(markdown, /讨论“Nimbus是谁”/);
  assertNoPrivatePersonaLiterals(markdown);
});

test('Obsidian exporter source has no private persona literals in public rules', () => {
  const source = readFileSync(join(repoRoot, 'server', 'core', 'obsidian-export-service.js'), 'utf8');
  assertNoPrivatePersonaLiterals(source);
});
