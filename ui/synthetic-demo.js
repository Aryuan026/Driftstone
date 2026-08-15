const DEMO_UPDATED_AT = '2026-08-15T00:00:00.000Z';

const DEMO_CARDS = [
  ['harbor-lantern', 'Harbor lantern ritual', 'memo', 'major'],
  ['atlas-room', 'Atlas room research habit', 'fact', 'major'],
  ['rain-market', 'Rain market source episode', 'case', 'normal'],
  ['blue-bridge', 'Blue bridge promise', 'family', 'major'],
  ['workbench-maps', 'Workbench mapmaking preference', 'fact', 'normal'],
  ['garden-radio', 'Garden radio recovery cue', 'memo', 'normal'],
  ['paper-moon', 'Paper moon writing motif', 'family', 'normal'],
  ['train-platform', 'Train platform goodbye pattern', 'case', 'normal'],
  ['lamp-repair', 'Lamp repair project decision', 'fact', 'normal'],
  ['salt-wind', 'Salt wind sensory anchor', 'memo', 'normal'],
  ['library-door', 'Library door boundary rule', 'family', 'major'],
  ['morning-ledger', 'Morning ledger review habit', 'fact', 'normal']
];

const DEMO_DRAFTS = [
  ['proto-comet', 'Comet draft awaiting review', 'memo'],
  ['silver-archive', 'Silver archive source check', 'case']
];

export function buildSyntheticDemoSnapshot() {
  return {
    demo: {
      synthetic: true,
      label: 'Demo / Synthetic data',
      description: 'Fictional Warm cards, sources, review items, and explicit relations for UI review.'
    },
    active_scope: {
      owner_id: 'demo-owner',
      realm_id: 'synthetic-showcase',
      bot_id: 'driftstone-demo'
    },
    growth_drafts: {
      total: DEMO_DRAFTS.length,
      drafts: DEMO_DRAFTS.map(([id, title, cardType], index) => ({
        artifact_id: `demo://draft/${id}`,
        title,
        card_type: cardType,
        importance: 'draft',
        generated_at: new Date(Date.parse(DEMO_UPDATED_AT) + index * 1000).toISOString()
      }))
    },
    staging_cards: {
      total: DEMO_CARDS.length,
      cards: DEMO_CARDS.map(([id, title, cardType, importance], index) => ({
        file_path: `demo://warm/${id}`,
        title,
        card_type: cardType,
        importance,
        updated_at: new Date(Date.parse(DEMO_UPDATED_AT) + index * 1000).toISOString()
      }))
    },
    explicit_relationships: {
      edges: [
        { from_id: 'demo://warm/harbor-lantern', to_id: 'demo://warm/blue-bridge', kind: 'explicit_relationship' },
        { from_id: 'demo://warm/atlas-room', to_id: 'demo://warm/workbench-maps', kind: 'source_backed_project_link' },
        { from_id: 'demo://warm/library-door', to_id: 'demo://warm/morning-ledger', kind: 'reviewed_boundary_rule' }
      ]
    },
    review_queue: {
      hold_count: 2,
      rejected_count: 1
    },
    source_summary: {
      occurrences: 32,
      spans: 18
    }
  };
}
