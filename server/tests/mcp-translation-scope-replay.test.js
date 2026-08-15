import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const dataRoot = await mkdtemp(join(tmpdir(), 'driftstone-mcp-translation-'));
process.env.HIPPOCOVE_DATA_ROOT = dataRoot;

const {
  failTranslationTaskForTool,
  inspectPipelineScope,
  prepareHistorySource,
  pullTranslationTaskForTool,
  submitTranslationEntriesForTool
} = await import('../core/mcp-tool-service.js');
const { loadLatestRuntimeReviewedPacket } = await import('../core/runtime-reviewed-store.js');
const { loadTranslationTaskByFile, updateTranslationTaskStatus } = await import('../core/translation-task-store.js');
const { finalizeRuntimeReviewedEntries } = await import('../core/memory-reviewed-service.js');
const { writeMemoryLeafEnvelope } = await import('../core/memory-leaf-service.js');
const { writeMemoryEnvelope } = await import('../core/memory-write-service.js');

function buildEntry(sliceId, canonicalName) {
  return {
    slice_ids: [sliceId],
    anchor_type: 'person',
    canonical_name: canonicalName,
    trunk: '人物',
    secondary_slot: 'synthetic',
    slot_path: `人物/${canonicalName}/synthetic`,
    stable_facts: [`${canonicalName} fact`],
    recent_updates: `${canonicalName} update`
  };
}

function assertNoPrivateSentinel(payload) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes('PRIVATE_BODY'), false);
  assert.equal(text.includes('SENTINEL'), false);
  assert.equal(text.includes('PRIVATE_ROOT_NAME'), false);
  assert.equal(text.includes('PRIVATE_ROOT_BODY'), false);
  assert.equal(text.includes('PRIVATE_SOURCE_REF'), false);
  assert.equal(text.includes('PRIVATE_DISPLAY'), false);
  assert.equal(text.includes('PRIVATE_PERSONA_BODY'), false);
  assert.equal(text.includes('PRIVATE_TASK_BODY'), false);
  assert.equal(text.includes('PRIVATE_SYSTEM_PROMPT'), false);
  assert.equal(text.includes('PRIVATE_SLICE_TEXT'), false);
}

function assertNoFullHome(payload) {
  assert.equal(Object.prototype.hasOwnProperty.call(payload || {}, 'home'), false);
}

function assertReviewedSummaryProjection(summary = {}) {
  assert.deepEqual(Object.keys(summary).sort(), [
    'ambiguous_cluster_count',
    'append_count',
    'cluster_count',
    'item_count',
    'merged_entry_count'
  ]);
  for (const value of Object.values(summary)) {
    assert.equal(Number.isFinite(value), true);
  }
}

function assertTranslationStatusProjection(summary = {}) {
  assert.deepEqual(Object.keys(summary).sort(), [
    'applied',
    'failed',
    'pending',
    'submitted'
  ]);
  for (const value of Object.values(summary)) {
    assert.equal(Number.isFinite(value), true);
  }
}

async function seedPrivateLegacyMemory(scope) {
  await writeMemoryEnvelope({
    scope: {
      owner_id: scope.ownerId,
      realm_id: scope.realmId,
      bot_id: scope.botId
    },
    source: {
      kind: 'legacy_probe',
      label: 'private_legacy_probe'
    },
    entries: [
      {
        anchor_type: 'person',
        canonical_name: 'PRIVATE_ROOT_NAME',
        trunk: '人物',
        secondary_slot: 'private',
        slot_path: '人物/PRIVATE_ROOT_NAME/private',
        stable_facts: ['PRIVATE_ROOT_BODY'],
        source_refs: ['PRIVATE_SOURCE_REF']
      }
    ]
  }, {
    label: 'private_legacy_probe'
  });
  await writeMemoryLeafEnvelope({
    scope: {
      owner_id: scope.ownerId,
      realm_id: scope.realmId,
      bot_id: scope.botId
    },
    source: {
      kind: 'leaf_probe',
      label: 'private_leaf_probe'
    },
    merge_mode: 'replace',
    leaf: {
      display_name: 'PRIVATE_DISPLAY',
      persona_summary: 'PRIVATE_PERSONA_BODY'
    }
  });
}

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test('headless task_file authority, replay, conflict, and resume stay exact', async () => {
  const inputFile = join(dataRoot, 'source.txt');
  await writeFile(inputFile, 'user: first synthetic line\nassistant: second synthetic line\n', 'utf8');

  const prepared = await prepareHistorySource({
    filePaths: [inputFile],
    ownerId: 'owner-original',
    realmId: 'realm-original',
    botId: 'bot-original',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const taskFile = prepared.next_task.task_file;
  const sliceId = prepared.next_task.slices[0].slice_id;

  const submitted = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'FIRST')]
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.scope.owner_id, 'owner-original');
  assert.equal(submitted.scope.realm_id, 'realm-original');

  const reviewed = await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-original',
    realmId: 'realm-original'
  });
  assert.equal(reviewed.packet.items.length, 1);
  assert.equal(reviewed.packet.items[0].entry.canonical_name, 'FIRST');
  assert.equal((await loadTranslationTaskByFile(taskFile)).status, 'applied');

  const replay = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'FIRST')]
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay.status, 'observed_existing');
  assert.equal((await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-original',
    realmId: 'realm-original'
  })).packet.items.length, 1);

  const beforeRawIntentConflictTaskBytes = await readFile(taskFile, 'utf8');
  const rawIntentConflict = await submitTranslationEntriesForTool({
    taskFile,
    rawOutput: 'same normalized entries, changed raw intent',
    entries: [buildEntry(sliceId, 'FIRST')]
  });
  assert.equal(rawIntentConflict.ok, false);
  assert.equal(rawIntentConflict.replay.status, 'conflict');
  assert.equal(await readFile(taskFile, 'utf8'), beforeRawIntentConflictTaskBytes);

  const beforeConflictTaskBytes = await readFile(taskFile, 'utf8');
  const conflict = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'SECOND')]
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.replay.status, 'conflict');
  assert.equal(await readFile(taskFile, 'utf8'), beforeConflictTaskBytes);
  const afterConflictReviewed = await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-original',
    realmId: 'realm-original'
  });
  assert.equal(afterConflictReviewed.packet.items.length, 1);
  assert.equal(afterConflictReviewed.packet.items[0].entry.canonical_name, 'FIRST');

  await assert.rejects(
    () => submitTranslationEntriesForTool({
      taskFile,
      ownerId: 'wrong-owner',
      realmId: 'realm-original',
      entries: [buildEntry(sliceId, 'FIRST')]
    }),
    /task_file scope mismatch/
  );

  const secondInputFile = join(dataRoot, 'source-2.txt');
  await writeFile(secondInputFile, 'user: recoverable synthetic task\n', 'utf8');
  const secondPrepared = await prepareHistorySource({
    filePaths: [secondInputFile],
    ownerId: 'owner-recover',
    realmId: 'realm-recover',
    botId: 'bot-recover',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  await updateTranslationTaskStatus(secondPrepared.next_task.task_file, (task) => ({
    ...task,
    status: 'submitted',
    lifecycle: {
      ...(task.lifecycle || {}),
      submitted_at: '2026-08-15T00:00:00.000Z'
    }
  }));
  const recovered = await pullTranslationTaskForTool({
    ownerId: 'owner-recover',
    realmId: 'realm-recover'
  });
  assert.equal(recovered.next_task.task_file, secondPrepared.next_task.task_file);
  assert.equal(recovered.next_task.status, 'submitted');

  const inspected = await inspectPipelineScope({
    ownerId: 'owner-original',
    realmId: 'realm-original',
    botId: 'bot-original'
  });
  assert.equal(inspected.reviewed.summary.item_count, 1);
});

test('public task_file rejects non-canonical task paths without reading private body', async () => {
  const forgedTaskFile = join(dataRoot, 'untrusted.json');
  await writeFile(forgedTaskFile, JSON.stringify({
    schema: 'hippocove_translation_task_v0.1',
    scope: {
      owner_id: 'owner-forged',
      realm_id: 'realm-forged',
      bot_id: 'bot-forged'
    },
    translator_contract: {
      PRIVATE_BODY: 'PRIVATE_TASK_BODY'
    },
    ai_contract: {
      system_prompt: 'PRIVATE_SYSTEM_PROMPT'
    },
    task: {
      slices: [
        {
          slice_id: 'forged_slice',
          text: 'PRIVATE_SLICE_TEXT'
        }
      ]
    }
  }, null, 2), 'utf8');

  await assert.rejects(
    () => pullTranslationTaskForTool({ taskFile: forgedTaskFile }),
    (error) => {
      assertNoPrivateSentinel(error);
      return /canonical translation task/.test(String(error?.message || ''));
    }
  );
  await assert.rejects(
    () => submitTranslationEntriesForTool({
      taskFile: forgedTaskFile,
      entries: [buildEntry('forged_slice', 'FORGED')]
    }),
    (error) => {
      assertNoPrivateSentinel(error);
      return /canonical translation task/.test(String(error?.message || ''));
    }
  );
  await assert.rejects(
    () => failTranslationTaskForTool({
      taskFile: forgedTaskFile,
      error: 'synthetic forged fail'
    }),
    (error) => {
      assertNoPrivateSentinel(error);
      return /canonical translation task/.test(String(error?.message || ''));
    }
  );
});

test('public task_file rejects unregistered and symlinked canonical-looking files', async () => {
  const inputFile = join(dataRoot, 'canonical-source.txt');
  await writeFile(inputFile, 'user: canonical synthetic line\n', 'utf8');
  const prepared = await prepareHistorySource({
    filePaths: [inputFile],
    ownerId: 'owner-canonical',
    realmId: 'realm-canonical',
    botId: 'bot-canonical',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const taskFile = prepared.next_task.task_file;
  const unregisteredFile = join(dirname(taskFile), 'unregistered.json');
  await writeFile(unregisteredFile, JSON.stringify({
    schema: 'hippocove_translation_task_v0.1',
    scope: prepared.next_task.scope,
    task_packet_file: prepared.next_task.task_packet_file,
    translator_contract: {
      PRIVATE_BODY: 'PRIVATE_TASK_BODY'
    }
  }, null, 2), 'utf8');
  const symlinkFile = join(dirname(taskFile), 'symlink-task.json');
  await symlink(taskFile, symlinkFile);

  await assert.rejects(
    () => pullTranslationTaskForTool({ taskFile: unregisteredFile }),
    /canonical translation task/
  );
  await assert.rejects(
    () => pullTranslationTaskForTool({ taskFile: `${dirname(taskFile)}/../tasks/task_0001.json` }),
    /canonical translation task/
  );
  await assert.rejects(
    () => pullTranslationTaskForTool({ taskFile: symlinkFile }),
    /canonical translation task/
  );
});

test('public lifecycle projections do not leak legacy root or leaf bodies', async () => {
  const scope = {
    ownerId: 'owner-private-projection',
    realmId: 'realm-private-projection',
    botId: 'bot-private-projection'
  };
  await seedPrivateLegacyMemory(scope);

  const inputFile = join(dataRoot, 'private-projection-source.txt');
  await writeFile(inputFile, 'user: private projection synthetic line\n', 'utf8');
  const prepared = await prepareHistorySource({
    filePaths: [inputFile],
    ...scope,
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  assertNoPrivateSentinel(prepared);
  assertNoFullHome(prepared);
  assertTranslationStatusProjection(prepared.status_summary);

  const pulled = await pullTranslationTaskForTool({
    taskFile: prepared.next_task.task_file
  });
  assertNoPrivateSentinel(pulled);
  assertNoFullHome(pulled);

  const sliceId = prepared.next_task.slices[0].slice_id;
  const submitted = await submitTranslationEntriesForTool({
    taskFile: prepared.next_task.task_file,
    entries: [buildEntry(sliceId, 'PUBLIC_SUBMIT')]
  });
  assert.equal(submitted.ok, true);
  assertNoPrivateSentinel(submitted);
  assertNoFullHome(submitted);
  assertReviewedSummaryProjection(submitted.reviewed.summary);
  assertTranslationStatusProjection(submitted.status_summary);
  assert.equal(typeof submitted.home_summary.current_bot_leaf_exists, 'boolean');
  assert.equal(Object.prototype.hasOwnProperty.call(submitted.home_summary, 'current_bot_leaf_display_name'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(submitted.home_summary, 'current_bot_leaf_persona_summary'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(submitted.home_summary, 'read_root_key'), false);

  const reviewedPacket = await loadLatestRuntimeReviewedPacket({
    ownerId: scope.ownerId,
    realmId: scope.realmId
  });
  reviewedPacket.packet.summary = {
    ...(reviewedPacket.packet.summary || {}),
    PRIVATE_BODY: 'SENTINEL'
  };
  await writeFile(reviewedPacket.packetFile, `${JSON.stringify(reviewedPacket.packet, null, 2)}\n`, 'utf8');
  const taskDoc = await loadTranslationTaskByFile(prepared.next_task.task_file);
  const taskPacket = JSON.parse(await readFile(taskDoc.task_packet_file, 'utf8'));
  taskPacket.status_summary = {
    ...(taskPacket.status_summary || {}),
    PRIVATE_BODY: 'SENTINEL'
  };
  await writeFile(taskDoc.task_packet_file, `${JSON.stringify(taskPacket, null, 2)}\n`, 'utf8');

  const replay = await submitTranslationEntriesForTool({
    taskFile: prepared.next_task.task_file,
    entries: [buildEntry(sliceId, 'PUBLIC_SUBMIT')]
  });
  assert.equal(replay.replay.status, 'observed_existing');
  assertNoPrivateSentinel(replay);
  assertNoFullHome(replay);
  assertReviewedSummaryProjection(replay.reviewed.summary);
  assertTranslationStatusProjection(replay.status_summary);

  const nextPulled = await pullTranslationTaskForTool(scope);
  assertNoPrivateSentinel(nextPulled);
  assertTranslationStatusProjection(nextPulled.status_summary);

  const conflict = await submitTranslationEntriesForTool({
    taskFile: prepared.next_task.task_file,
    entries: [buildEntry(sliceId, 'PUBLIC_CONFLICT')]
  });
  assert.equal(conflict.ok, false);
  assertNoPrivateSentinel(conflict);
  assertNoFullHome(conflict);
  assertReviewedSummaryProjection(conflict.reviewed.summary);
  assertTranslationStatusProjection(conflict.status_summary);

  const invalidInputFile = join(dataRoot, 'private-invalid-source.txt');
  await writeFile(invalidInputFile, 'user: invalid projection synthetic line\n', 'utf8');
  const invalidPrepared = await prepareHistorySource({
    filePaths: [invalidInputFile],
    ...scope,
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const parseFail = await submitTranslationEntriesForTool({
    taskFile: invalidPrepared.next_task.task_file,
    entries: [
      {
        slice_ids: [invalidPrepared.next_task.slices[0].slice_id],
        anchor_type: 'topic',
        canonical_name: 'Invalid topic'
      }
    ]
  });
  assert.equal(parseFail.ok, false);
  assertNoPrivateSentinel(parseFail);
  assertNoFullHome(parseFail);

  const failInputFile = join(dataRoot, 'private-fail-source.txt');
  await writeFile(failInputFile, 'user: fail projection synthetic line\n', 'utf8');
  const failPrepared = await prepareHistorySource({
    filePaths: [failInputFile],
    ...scope,
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const failed = await failTranslationTaskForTool({
    taskFile: failPrepared.next_task.task_file,
    error: 'synthetic failure'
  });
  assert.equal(failed.ok, true);
  assertNoPrivateSentinel(failed);
  assertNoFullHome(failed);

  const inspected = await inspectPipelineScope(scope);
  assertNoPrivateSentinel(inspected);
  assertReviewedSummaryProjection(inspected.reviewed.summary);
  assertTranslationStatusProjection(inspected.tasks.status_summary);
  assert.equal(Object.prototype.hasOwnProperty.call(inspected.home, 'current_bot_leaf_display_name'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(inspected.home, 'current_bot_leaf_persona_summary'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(inspected.home, 'read_root_key'), false);
  assert.equal(inspected.home.current_bot_leaf_exists, true);
});

test('finalized reviewed packet remains immutable on same-task replay', async () => {
  const inputFile = join(dataRoot, 'finalized-replay-source.txt');
  await writeFile(inputFile, 'user: finalized replay synthetic line\n', 'utf8');
  const prepared = await prepareHistorySource({
    filePaths: [inputFile],
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized',
    botId: 'bot-finalized',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const taskFile = prepared.next_task.task_file;
  const sliceId = prepared.next_task.slices[0].slice_id;
  const submitted = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'FINALIZED')]
  });
  assert.equal(submitted.ok, true);

  const beforeFinalizeTask = await loadTranslationTaskByFile(taskFile);
  assert.ok(beforeFinalizeTask.writeback.reviewed_packet_file);
  assert.ok(beforeFinalizeTask.writeback.reviewed_submission_digest);
  await finalizeRuntimeReviewedEntries({
    scope: {
      owner_id: 'owner-finalized',
      realm_id: 'realm-finalized',
      bot_id: 'bot-finalized'
    },
    source: {
      label: 'finalized_replay_probe'
    }
  });
  const afterFinalizeTask = await loadTranslationTaskByFile(taskFile);
  assert.equal(afterFinalizeTask.writeback.reviewed_packet_file, beforeFinalizeTask.writeback.reviewed_packet_file);
  assert.equal(afterFinalizeTask.writeback.reviewed_submission_digest, beforeFinalizeTask.writeback.reviewed_submission_digest);

  const finalized = await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized'
  });
  const finalizedPointer = finalized.pointer.latest_packet;
  const finalizedBytes = await readFile(finalized.packetFile, 'utf8');
  const replay = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'FINALIZED')]
  });
  const afterReplay = await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized'
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay.status, 'observed_existing');
  assert.equal(afterReplay.pointer.latest_packet, finalizedPointer);
  assert.equal(await readFile(finalized.packetFile, 'utf8'), finalizedBytes);

  const changed = await submitTranslationEntriesForTool({
    taskFile,
    entries: [buildEntry(sliceId, 'FINALIZED_CHANGED')]
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.replay.status, 'conflict');
  assert.equal((await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized'
  })).pointer.latest_packet, finalizedPointer);

  const newInputFile = join(dataRoot, 'finalized-new-source.txt');
  await writeFile(newInputFile, 'user: new finalized synthetic line\n', 'utf8');
  const newPrepared = await prepareHistorySource({
    filePaths: [newInputFile],
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized',
    botId: 'bot-finalized',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });
  const newSubmit = await submitTranslationEntriesForTool({
    taskFile: newPrepared.next_task.task_file,
    entries: [buildEntry(newPrepared.next_task.slices[0].slice_id, 'AFTER_FINALIZE')]
  });
  const afterNew = await loadLatestRuntimeReviewedPacket({
    ownerId: 'owner-finalized',
    realmId: 'realm-finalized'
  });
  assert.equal(newSubmit.ok, true);
  assert.notEqual(afterNew.pointer.latest_packet, finalizedPointer);
  assert.equal(await readFile(finalized.packetFile, 'utf8'), finalizedBytes);
});

test('headless submit fails when entries normalize to zero', async () => {
  const inputFile = join(dataRoot, 'invalid-source.txt');
  await writeFile(inputFile, 'user: invalid synthetic line\n', 'utf8');
  const prepared = await prepareHistorySource({
    filePaths: [inputFile],
    ownerId: 'owner-invalid',
    realmId: 'realm-invalid',
    botId: 'bot-invalid',
    targetChars: 1200,
    maxSlices: 1,
    entryLimit: 2
  });

  const submitted = await submitTranslationEntriesForTool({
    taskFile: prepared.next_task.task_file,
    entries: [
      {
        slice_ids: [prepared.next_task.slices[0].slice_id],
        anchor_type: 'topic',
        canonical_name: 'Invalid topic'
      }
    ]
  });

  assert.equal(submitted.ok, false);
  assert.match(submitted.error, /No valid translation entries/);
  assert.equal((await loadTranslationTaskByFile(prepared.next_task.task_file)).status, 'failed');
  await assert.rejects(
    () => loadLatestRuntimeReviewedPacket({
      ownerId: 'owner-invalid',
      realmId: 'realm-invalid'
    }),
    /ENOENT/
  );
});
