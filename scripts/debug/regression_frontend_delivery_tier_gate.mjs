#!/usr/bin/env node
import assert from 'assert/strict';
import { resolveFrontendDeliveryTier } from '../../server/core/notion-export-service.js';

const conflictCard = {
  schema: 'driftstone_regression_frontend_delivery_tier_gate_v0.1',
  title: 'Regression: old recall_guard must not override frontend_delivery_tier',
  recall_guard: 'normal_candidate',
  frontend_delivery_tier: 'explicit_context_only',
  review_status: 'ready_for_cold_archive',
  archive_bucket: 'stable'
};

const nestedConflictCard = {
  schema: 'driftstone_regression_frontend_delivery_tier_gate_v0.1',
  title: 'Regression: nested quality tier wins over legacy guard',
  quality: {
    recall_guard: 'normal_candidate',
    frontend_delivery_tier: 'explicit_context_only',
    review_status: 'ready_for_cold_archive',
    archive_bucket: 'stable'
  }
};

const fallbackCard = {
  schema: 'driftstone_regression_frontend_delivery_tier_gate_v0.1',
  title: 'Regression: legacy guard fallback still works when no tier exists',
  recall_guard: 'normal_candidate',
  review_status: 'ready_for_cold_archive',
  archive_bucket: 'stable'
};

const explicitTier = resolveFrontendDeliveryTier(conflictCard);
const nestedExplicitTier = resolveFrontendDeliveryTier(nestedConflictCard);
const fallbackTier = resolveFrontendDeliveryTier(fallbackCard);

assert.equal(explicitTier, 'explicit_context_only');
assert.notEqual(explicitTier, 'default_front');
assert.equal(nestedExplicitTier, 'explicit_context_only');
assert.notEqual(nestedExplicitTier, 'default_front');
assert.equal(fallbackTier, 'default_front');

console.log(JSON.stringify({
  ok: true,
  regression: 'frontend_delivery_tier_overrides_recall_guard',
  conflict_card_effective_tier: explicitTier,
  nested_conflict_card_effective_tier: nestedExplicitTier,
  fallback_without_frontend_delivery_tier: fallbackTier
}, null, 2));
