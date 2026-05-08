import {
  buildFingerprintCandidatePoolForWorkspace,
  generateLanguageFingerprintForWorkspace,
  generateSoulDraftForWorkspace,
  getPersonaWorkspaceSnapshot,
  savePersonaCacheRows,
  savePersonaWorkspaceState
} from '../../core/persona-workspace-service.js';
import { getWorkbenchCacheSnapshot, saveWorkbenchCacheRows } from '../../core/workbench-cache-service.js';
import { getGrowthContextPacket } from '../../core/growth-context-service.js';
import { buildGrowthTaskPacket } from '../../core/growth-task-service.js';
import { generateGrowthDraft } from '../../core/growth-generate-service.js';
import { clearDraftCardRegistryEntries, getCardRegistrySnapshot, upsertCardRegistryEntry } from '../../core/card-registry-service.js';
import { appendGrowthLedgerEntry, getGrowthLedgerSnapshot } from '../../core/growth-ledger-service.js';
import { commitGrowthDecision } from '../../core/growth-commit-service.js';
import { clearGrowthDraftArtifacts, getGrowthDraftArtifact, listGrowthDraftArtifacts, updateGrowthDraftHumanReview } from '../../core/growth-draft-store.js';
import { exportGrowthDraftToObsidianStaging, exportGrowthScopeBundleToObsidianStaging } from '../../core/obsidian-export-service.js';
import { buildMemoCompactionPacket, exportMemoCompactBundle } from '../../core/memo-compaction-service.js';
import { clearStagingCards, getGrowthDashboardSnapshot, getStagingCardMarkdown } from '../../core/growth-dashboard-service.js';
import { getFrontRuntimeState, saveFrontRuntimeState } from '../../core/front-runtime-state-service.js';
import { getParseRuntimeState, pauseParseRuntime, resumeParseRuntime, startParseRuntime } from '../../core/parse-runtime-service.js';
import { getGrowthRuntimeState, pauseGrowthRuntime, resumeGrowthRuntime, startGrowthRuntime } from '../../core/growth-runtime-service.js';
import { resetLocalRuntimeState } from '../../core/runtime-reset-service.js';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function pickScopeValue(source, snakeKey, camelKey) {
  return String(source?.[snakeKey] ?? source?.[camelKey] ?? '');
}

function readScopeFromQuery(searchParams) {
  return {
    ownerId: String(searchParams.get('owner_id') || searchParams.get('ownerId') || ''),
    realmId: String(searchParams.get('realm_id') || searchParams.get('realmId') || '')
  };
}

function readScopeFromBody(body) {
  return {
    ownerId: pickScopeValue(body, 'owner_id', 'ownerId'),
    realmId: pickScopeValue(body, 'realm_id', 'realmId')
  };
}

async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export async function handleRuntimePersonaWorkspaceRoute(req, res, url) {
  if (
    url.pathname !== '/api/runtime/persona-workspace'
    && url.pathname !== '/api/runtime/persona-workspace/candidate-pool'
    && url.pathname !== '/api/runtime/persona-workspace/generate-soul'
    && url.pathname !== '/api/runtime/persona-workspace/generate-language-fingerprint'
    && url.pathname !== '/api/runtime/persona-workspace/cache'
    && url.pathname !== '/api/runtime/workbench-cache'
    && url.pathname !== '/api/runtime/growth-context'
    && url.pathname !== '/api/runtime/card-registry'
    && url.pathname !== '/api/runtime/growth-ledger'
    && url.pathname !== '/api/runtime/growth-commit'
    && url.pathname !== '/api/runtime/growth-task'
    && url.pathname !== '/api/runtime/growth-generate'
    && url.pathname !== '/api/runtime/growth-drafts'
    && url.pathname !== '/api/runtime/growth-drafts/clear'
    && url.pathname !== '/api/runtime/growth-draft'
    && url.pathname !== '/api/runtime/growth-draft/review'
    && url.pathname !== '/api/runtime/growth-dashboard'
    && url.pathname !== '/api/runtime/front-runtime-state'
    && url.pathname !== '/api/runtime/growth-runtime'
    && url.pathname !== '/api/runtime/growth-runtime/start'
    && url.pathname !== '/api/runtime/growth-runtime/pause'
    && url.pathname !== '/api/runtime/growth-runtime/resume'
    && url.pathname !== '/api/runtime/parse-runtime'
    && url.pathname !== '/api/runtime/parse-runtime/start'
    && url.pathname !== '/api/runtime/parse-runtime/pause'
    && url.pathname !== '/api/runtime/parse-runtime/resume'
    && url.pathname !== '/api/runtime/staging-card'
    && url.pathname !== '/api/runtime/staging-cards/clear'
    && url.pathname !== '/api/runtime/obsidian-export'
    && url.pathname !== '/api/runtime/obsidian-export/bundle'
    && url.pathname !== '/api/runtime/memo-compact'
    && url.pathname !== '/api/runtime/memo-compact/export'
    && url.pathname !== '/api/runtime/local-reset'
  ) return false;

  if (req.method === 'GET') {
    if (url.pathname === '/api/runtime/growth-task') {
      const scope = readScopeFromQuery(url.searchParams);
      const packet = await buildGrowthTaskPacket({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        botId: String(url.searchParams.get('bot_id') || ''),
        userId: String(url.searchParams.get('user_id') || ''),
        charId: String(url.searchParams.get('char_id') || ''),
        key: String(url.searchParams.get('key') || ''),
        query: String(url.searchParams.get('query') || ''),
        familyId: String(url.searchParams.get('family_id') || ''),
        cardType: String(url.searchParams.get('card_type') || 'memo'),
        packetId: String(url.searchParams.get('packet_id') || ''),
        includePersonaRows: String(url.searchParams.get('include_persona_rows') || '').toLowerCase() === 'true',
        rowLimit: Number(url.searchParams.get('row_limit') || 8)
      });
      json(res, 200, packet);
      return true;
    }
    if (url.pathname === '/api/runtime/card-registry') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getCardRegistrySnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        limit: Number(url.searchParams.get('limit') || 12)
      });
      json(res, 200, snapshot);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-ledger') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getGrowthLedgerSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        limit: Number(url.searchParams.get('limit') || 20)
      });
      json(res, 200, snapshot);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-drafts') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await listGrowthDraftArtifacts({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        cardType: String(url.searchParams.get('card_type') || ''),
        limit: Number(url.searchParams.get('limit') || 12)
      });
      json(res, 200, snapshot);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-draft') {
      const scope = readScopeFromQuery(url.searchParams);
      const artifact = await getGrowthDraftArtifact({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        cardType: String(url.searchParams.get('card_type') || 'memo'),
        artifactId: String(url.searchParams.get('artifact_id') || '')
      });
      json(res, artifact.ok ? 200 : 404, artifact);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-dashboard') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getGrowthDashboardSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        draftLimit: Number(url.searchParams.get('draft_limit') || 10),
        ledgerLimit: Number(url.searchParams.get('ledger_limit') || 10),
        registryLimit: Number(url.searchParams.get('registry_limit') || 12)
      });
      json(res, 200, snapshot);
      return true;
    }
    if (url.pathname === '/api/runtime/front-runtime-state') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getFrontRuntimeState({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...(snapshot || { saved_at: '', active_scope: null, state: null })
      });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-runtime') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getGrowthRuntimeState({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...(snapshot || { saved_at: '', active_scope: null, state: null })
      });
      return true;
    }
    if (url.pathname === '/api/runtime/parse-runtime') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getParseRuntimeState({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...(snapshot || {
          saved_at: '',
          active_scope: null,
          state: null,
          runtime_config: {}
        })
      });
      return true;
    }
    if (url.pathname === '/api/runtime/staging-card') {
      const result = await getStagingCardMarkdown({
        relativePath: String(url.searchParams.get('relative_path') || url.searchParams.get('relativePath') || '')
      });
      json(res, result.ok ? 200 : 404, result);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-context') {
      const scope = readScopeFromQuery(url.searchParams);
      const packet = await getGrowthContextPacket({
        key: String(url.searchParams.get('key') || ''),
        query: String(url.searchParams.get('query') || ''),
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        botId: String(url.searchParams.get('bot_id') || ''),
        userId: String(url.searchParams.get('user_id') || ''),
        charId: String(url.searchParams.get('char_id') || ''),
        includePersonaRows: String(url.searchParams.get('include_persona_rows') || '').toLowerCase() !== 'false',
        rowLimit: Number(url.searchParams.get('row_limit') || 12)
      });
      json(res, 200, packet);
      return true;
    }
    if (url.pathname === '/api/runtime/memo-compact') {
      const scope = readScopeFromQuery(url.searchParams);
      const packet = await buildMemoCompactionPacket({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        rootDir: String(url.searchParams.get('root_dir') || url.searchParams.get('rootDir') || '')
      });
      json(res, packet.ok ? 200 : 409, packet);
      return true;
    }
    if (url.pathname === '/api/runtime/workbench-cache') {
      const scope = readScopeFromQuery(url.searchParams);
      const snapshot = await getWorkbenchCacheSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        layers: String(url.searchParams.get('layers') || '')
          .split(',')
          .map((item) => String(item || '').trim())
          .filter(Boolean),
        limit: Number(url.searchParams.get('limit') || 24),
        preferRuntimeReviewed: Boolean(scope.ownerId && scope.realmId)
      });
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname !== '/api/runtime/persona-workspace') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    const scope = readScopeFromQuery(url.searchParams);
    const snapshot = await getPersonaWorkspaceSnapshot({
      ownerId: scope.ownerId,
      realmId: scope.realmId,
      includePersonaRows: String(url.searchParams.get('include_persona_rows') || '').toLowerCase() === 'true',
      rowLimit: Number(url.searchParams.get('row_limit') || 12)
    });
    json(res, 200, { ok: true, ...snapshot });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(
      req,
      (
        url.pathname === '/api/runtime/persona-workspace/cache'
        || url.pathname === '/api/runtime/workbench-cache'
        || url.pathname === '/api/runtime/parse-runtime/start'
        || url.pathname === '/api/runtime/parse-runtime/resume'
      )
        ? 32 * 1024 * 1024
        : 2 * 1024 * 1024
    );
    const scope = readScopeFromBody(body);
    if (url.pathname === '/api/runtime/parse-runtime/start') {
      const snapshot = await startParseRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-runtime/start') {
      const snapshot = await startGrowthRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-runtime/pause') {
      const snapshot = await pauseGrowthRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-runtime/resume') {
      const snapshot = await resumeGrowthRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/parse-runtime/pause') {
      const snapshot = await pauseParseRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/parse-runtime/resume') {
      const snapshot = await resumeParseRuntime(body || {});
      json(res, 200, { ok: true, ...snapshot });
      return true;
    }
    if (url.pathname === '/api/runtime/card-registry') {
      const result = await upsertCardRegistryEntry({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        entry: body?.entry || {}
      });
      json(res, 200, {
        ok: true,
        entry: result.entry,
        summary: result.registry?.summary || {}
      });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-ledger') {
      const result = await appendGrowthLedgerEntry({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        entry: body?.entry || {}
      });
      json(res, 200, {
        ok: true,
        entry: result.entry,
        summary: result.ledger?.summary || {}
      });
      return true;
    }
    if (url.pathname === '/api/runtime/growth-commit') {
      const result = await commitGrowthDecision({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        decision: String(body?.decision || ''),
        packetId: String(body?.packet_id || ''),
        reason: String(body?.reason || ''),
        nextHint: String(body?.next_hint || ''),
        actor: String(body?.actor || ''),
        source: String(body?.source || ''),
        cardEntry: body?.card_entry || {},
        ledgerEntry: body?.ledger_entry || {}
      });
      json(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-generate') {
      const result = await generateGrowthDraft({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        botId: String(body?.bot_id || ''),
        userId: String(body?.user_id || ''),
        charId: String(body?.char_id || ''),
        key: String(body?.key || ''),
        query: String(body?.query || ''),
        familyId: String(body?.family_id || ''),
        cardType: String(body?.card_type || 'memo'),
        packetId: String(body?.packet_id || ''),
        includePersonaRows: body?.include_persona_rows !== false,
        rowLimit: Number(body?.row_limit || 8),
        apiProfileName: String(body?.api_profile_name || ''),
        mode: String(body?.mode || ''),
        commit: Boolean(body?.commit),
        saveArtifact: body?.save_artifact !== false,
        exportToObsidian: Boolean(body?.export_to_obsidian || body?.exportToObsidian),
        exportRoot: String(body?.export_root || body?.exportRoot || ''),
        overwriteExport: Boolean(body?.overwrite_export || body?.overwriteExport)
      });
      json(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/runtime/obsidian-export') {
      const result = await exportGrowthDraftToObsidianStaging({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        artifactId: String(body?.artifact_id || body?.artifactId || ''),
        cardType: String(body?.card_type || body?.cardType || 'memo'),
        rootDir: String(body?.root_dir || body?.rootDir || ''),
        overwrite: Boolean(body?.overwrite),
        includeContent: Boolean(body?.include_content || body?.includeContent)
      });
      json(res, result.ok ? 200 : 409, result);
      return true;
    }
    if (url.pathname === '/api/runtime/obsidian-export/bundle') {
      const result = await exportGrowthScopeBundleToObsidianStaging({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        cardType: String(body?.card_type || body?.cardType || 'memo'),
        rootDir: String(body?.root_dir || body?.rootDir || ''),
        overwrite: body?.overwrite !== false,
        includeContent: Boolean(body?.include_content || body?.includeContent)
      });
      json(res, result.ok ? 200 : 409, result);
      return true;
    }
    if (url.pathname === '/api/runtime/memo-compact/export') {
      const result = await exportMemoCompactBundle({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        rootDir: String(body?.root_dir || body?.rootDir || ''),
        overwrite: body?.overwrite !== false,
        includeContent: Boolean(body?.include_content || body?.includeContent)
      });
      json(res, result.ok ? 200 : 409, result);
      return true;
    }
    if (url.pathname === '/api/runtime/local-reset') {
      const result = await resetLocalRuntimeState();
      json(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-drafts/clear') {
      const [draftArtifacts, cardRegistry] = await Promise.all([
        clearGrowthDraftArtifacts({
          ownerId: scope.ownerId,
          realmId: scope.realmId,
          cardType: String(body?.card_type || body?.cardType || '')
        }),
        clearDraftCardRegistryEntries({
          ownerId: scope.ownerId,
          realmId: scope.realmId,
          cardType: String(body?.card_type || body?.cardType || '')
        })
      ]);
      const result = {
        ok: true,
        scope: draftArtifacts?.scope || cardRegistry?.registry?.scope || {
          owner_id: scope.ownerId,
          realm_id: scope.realmId
        },
        card_type: String(body?.card_type || body?.cardType || ''),
        draft_artifact_count: Number(draftArtifacts?.cleared_count || 0),
        registry_draft_count: Number(cardRegistry?.cleared_count || 0),
        cleared_count: Math.max(
          Number(draftArtifacts?.cleared_count || 0),
          Number(cardRegistry?.cleared_count || 0)
        )
      };
      json(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/runtime/growth-draft/review') {
      const result = await updateGrowthDraftHumanReview({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        cardType: String(body?.card_type || body?.cardType || 'memo'),
        artifactId: String(body?.artifact_id || body?.artifactId || ''),
        review: body?.review || {}
      });
      json(res, result.ok ? 200 : 404, result);
      return true;
    }
    if (url.pathname === '/api/runtime/staging-cards/clear') {
      const result = await clearStagingCards({
        ownerId: scope.ownerId,
        realmId: scope.realmId,
        cardType: String(body?.card_type || body?.cardType || '')
      });
      json(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/runtime/front-runtime-state') {
      const state = await saveFrontRuntimeState(body || {});
      json(res, 200, {
        ok: true,
        ...state
      });
      return true;
    }
    if (url.pathname === '/api/runtime/persona-workspace/candidate-pool') {
      const result = await buildFingerprintCandidatePoolForWorkspace({
        save: body?.save !== false,
        translationPacketFile: String(body?.translation_packet_file || body?.translationPacketFile || ''),
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      const snapshot = await getPersonaWorkspaceSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...result,
        persona_cache: snapshot.persona_cache,
        api: snapshot.api
      });
      return true;
    }
    if (url.pathname === '/api/runtime/workbench-cache') {
      const saved = await saveWorkbenchCacheRows(body?.rows || [], {
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, { ok: true, ...saved });
      return true;
    }
    if (url.pathname === '/api/runtime/persona-workspace/cache') {
      const cache = await savePersonaCacheRows(Array.isArray(body?.rows) ? body.rows : [], {
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      const snapshot = await getPersonaWorkspaceSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        cache,
        state: snapshot.state,
        persona_cache: snapshot.persona_cache,
        api: snapshot.api
      });
      return true;
    }
    if (url.pathname === '/api/runtime/persona-workspace/generate-soul') {
      const result = await generateSoulDraftForWorkspace({
        apiProfileName: typeof body?.api_profile_name === 'string' ? body.api_profile_name : '',
        save: body?.save !== false,
        translationPacketFile: String(body?.translation_packet_file || body?.translationPacketFile || ''),
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      const snapshot = await getPersonaWorkspaceSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...result,
        persona_cache: snapshot.persona_cache,
        api: snapshot.api
      });
      return true;
    }
    if (url.pathname === '/api/runtime/persona-workspace/generate-language-fingerprint') {
      const result = await generateLanguageFingerprintForWorkspace({
        apiProfileName: typeof body?.api_profile_name === 'string' ? body.api_profile_name : '',
        save: body?.save !== false,
        candidatePool: typeof body?.candidate_pool === 'string' ? body.candidate_pool : '',
        translationPacketFile: String(body?.translation_packet_file || body?.translationPacketFile || ''),
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      const snapshot = await getPersonaWorkspaceSnapshot({
        ownerId: scope.ownerId,
        realmId: scope.realmId
      });
      json(res, 200, {
        ok: true,
        ...result,
        persona_cache: snapshot.persona_cache,
        api: snapshot.api
      });
      return true;
    }
    if (url.pathname !== '/api/runtime/persona-workspace') {
      json(res, 404, { ok: false, error: 'Not found' });
      return true;
    }
    const state = await savePersonaWorkspaceState(body || {});
    const snapshot = await getPersonaWorkspaceSnapshot({
      ownerId: scope.ownerId,
      realmId: scope.realmId
    });
    json(res, 200, {
      ok: true,
      state,
      persona_cache: snapshot.persona_cache,
      api: snapshot.api
    });
    return true;
  }

  json(res, 405, { ok: false, error: 'Method not allowed' });
  return true;
}
