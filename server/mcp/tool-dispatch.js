import {
  buildGrowthTaskForTool,
  generateGrowthDraftForTool,
  listGrowthDraftsForTool,
  getGrowthDraftForTool,
  exportGrowthDraftToObsidianForTool,
  exportPortableWarmBundleForTool,
  commitGrowthDecisionForTool,
  appendGrowthLedgerEntryForTool,
  buildFingerprintCandidatePoolForTool,
  failTranslationTaskForTool,
  finalizeReviewedEntriesForTool,
  generateLanguageFingerprintForTool,
  generateSoulDraftForTool,
  getCardRegistryForTool,
  getGrowthContextForTool,
  getGrowthLedgerForTool,
  getPortableWarmBundleContractForTool,
  getMemoryContextForTool,
  getPersonaWorkspaceStateForTool,
  inspectPipelineScope,
  listReviewedClustersForTool,
  listRuntimeApiProfilesForTool,
  prepareHistorySource,
  pullTranslationTaskForTool,
  runHistoryPipeline,
  savePersonaWorkspaceStateForTool,
  upsertCardRegistryEntryForTool,
  submitTranslationEntriesForTool
} from '../core/mcp-tool-service.js';

export async function callTool(name, args = {}) {
  if (name === 'list_api_profiles') {
    return listRuntimeApiProfilesForTool();
  }
  if (name === 'get_portable_warm_bundle_contract') {
    return getPortableWarmBundleContractForTool();
  }
  if (name === 'export_portable_warm_bundle') {
    return exportPortableWarmBundleForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      cardType: args.card_type || 'memo',
      limit: args.limit,
      outputRoot: args.output_root,
      writeFiles: args.write_files !== false
    });
  }
  if (name === 'run_history_pipeline') {
    return runHistoryPipeline({
      filePaths: args.file_paths,
      mode: args.mode,
      apiProfileName: args.api_profile_name,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      targetChars: args.target_chars,
      maxSlices: args.max_slices,
      maxChars: args.max_chars,
      entryLimit: args.entry_limit
    });
  }
  if (name === 'get_persona_workspace_state') {
    return getPersonaWorkspaceStateForTool({
      includePersonaRows: Boolean(args.include_persona_rows),
      rowLimit: args.row_limit
    });
  }
  if (name === 'get_growth_context') {
    return getGrowthContextForTool({
      key: args.key,
      query: args.query,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      userId: args.user_id,
      charId: args.char_id,
      includePersonaRows: args.include_persona_rows !== false,
      rowLimit: args.row_limit
    });
  }
  if (name === 'build_growth_task') {
    return buildGrowthTaskForTool({
      key: args.key,
      query: args.query,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      userId: args.user_id,
      charId: args.char_id,
      familyId: args.family_id,
      cardType: args.card_type || 'memo',
      packetId: args.packet_id,
      includePersonaRows: Boolean(args.include_persona_rows),
      rowLimit: args.row_limit
    });
  }
  if (name === 'generate_growth_draft') {
    return generateGrowthDraftForTool({
      key: args.key,
      query: args.query,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      userId: args.user_id,
      charId: args.char_id,
      familyId: args.family_id,
      cardType: args.card_type || 'memo',
      packetId: args.packet_id,
      includePersonaRows: args.include_persona_rows !== false,
      rowLimit: args.row_limit,
      apiProfileName: args.api_profile_name,
      mode: args.mode,
      commit: Boolean(args.commit),
      exportToObsidian: Boolean(args.export_to_obsidian),
      exportRoot: args.export_root,
      overwriteExport: Boolean(args.overwrite_export)
    });
  }
  if (name === 'list_growth_drafts') {
    return listGrowthDraftsForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      cardType: args.card_type,
      limit: args.limit
    });
  }
  if (name === 'get_growth_draft') {
    return getGrowthDraftForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      cardType: args.card_type || 'memo',
      artifactId: args.artifact_id
    });
  }
  if (name === 'export_growth_draft_to_obsidian') {
    return exportGrowthDraftToObsidianForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      cardType: args.card_type || 'memo',
      artifactId: args.artifact_id,
      rootDir: args.root_dir,
      overwrite: Boolean(args.overwrite)
    });
  }
  if (name === 'get_card_registry') {
    return getCardRegistryForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      limit: args.limit
    });
  }
  if (name === 'upsert_card_registry_entry') {
    return upsertCardRegistryEntryForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      entry: args.entry || {}
    });
  }
  if (name === 'get_growth_ledger') {
    return getGrowthLedgerForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      limit: args.limit
    });
  }
  if (name === 'append_growth_ledger_entry') {
    return appendGrowthLedgerEntryForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      entry: args.entry || {}
    });
  }
  if (name === 'commit_growth_decision') {
    return commitGrowthDecisionForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      decision: args.decision,
      packetId: args.packet_id,
      reason: args.reason,
      nextHint: args.next_hint,
      actor: args.actor,
      source: args.source,
      cardEntry: args.card_entry || {},
      ledgerEntry: args.ledger_entry || {}
    });
  }
  if (name === 'save_persona_workspace_state') {
    return savePersonaWorkspaceStateForTool({
      charName: args.char_name,
      userName: args.user_name,
      personaCard: args.persona_card,
      languageFingerprint: args.language_fingerprint,
      fingerprintCandidatePool: args.fingerprint_candidate_pool
    });
  }
  if (name === 'build_language_fingerprint_candidates') {
    return buildFingerprintCandidatePoolForTool({
      save: args.save !== false
    });
  }
  if (name === 'generate_soul_draft') {
    return generateSoulDraftForTool({
      apiProfileName: args.api_profile_name,
      save: args.save !== false
    });
  }
  if (name === 'generate_language_fingerprint') {
    return generateLanguageFingerprintForTool({
      apiProfileName: args.api_profile_name,
      save: args.save !== false,
      candidatePool: args.candidate_pool
    });
  }
  if (name === 'prepare_history_source') {
    return prepareHistorySource({
      filePaths: args.file_paths,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      targetChars: args.target_chars,
      maxSlices: args.max_slices,
      maxChars: args.max_chars,
      entryLimit: args.entry_limit
    });
  }
  if (name === 'pull_translation_task') {
    return pullTranslationTaskForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      taskFile: args.task_file
    });
  }
  if (name === 'submit_translation_entries') {
    return submitTranslationEntriesForTool({
      taskFile: args.task_file,
      entries: args.entries,
      rawOutput: args.raw_output,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      sourceLabel: args.source_label
    });
  }
  if (name === 'fail_translation_task') {
    return failTranslationTaskForTool({
      taskFile: args.task_file,
      error: args.error,
      rawOutput: args.raw_output,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      sourceLabel: args.source_label
    });
  }
  if (name === 'list_reviewed_clusters') {
    return listReviewedClustersForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id
    });
  }
  if (name === 'finalize_reviewed_entries') {
    return finalizeReviewedEntriesForTool({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      aiMerges: args.ai_merges
    });
  }
  if (name === 'inspect_pipeline_scope') {
    return inspectPipelineScope({
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id
    });
  }
  if (name === 'get_memory_context') {
    return getMemoryContextForTool({
      key: args.key,
      query: args.query,
      ownerId: args.owner_id,
      realmId: args.realm_id,
      botId: args.bot_id,
      mode: args.mode || 'mcp'
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}
