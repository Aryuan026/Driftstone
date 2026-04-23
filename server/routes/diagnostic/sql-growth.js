import {
  getBackendHealth,
  getReviewedCatalog,
  getReviewedDeepSummary,
  getGrowthWritebackPreview,
  getSqlGrowthFixtures,
  getSqlGrowthSummary
} from '../../core/sql-growth-service.js';

const DEV_PREFIX = '/api/dev/sql-growth';
const SQL_GROWTH_PATHS = new Set([
  '/api/health',
  `${DEV_PREFIX}/summary`,
  `${DEV_PREFIX}/fixtures`,
  `${DEV_PREFIX}/reviewed`,
  `${DEV_PREFIX}/reviewed-summary`,
  `${DEV_PREFIX}/writeback-preview`
]);

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

export async function handleSqlGrowthRoute(req, res, url) {
  if (!SQL_GROWTH_PATHS.has(url.pathname)) return false;

  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  if (url.pathname === '/api/health') {
    json(res, 200, await getBackendHealth());
    return true;
  }

  if (url.pathname === `${DEV_PREFIX}/summary`) {
    json(res, 200, await getSqlGrowthSummary());
    return true;
  }

  if (url.pathname === `${DEV_PREFIX}/fixtures`) {
    json(res, 200, await getSqlGrowthFixtures());
    return true;
  }

  if (url.pathname === `${DEV_PREFIX}/reviewed`) {
    json(res, 200, await getReviewedCatalog());
    return true;
  }

  if (url.pathname === `${DEV_PREFIX}/reviewed-summary`) {
    json(res, 200, await getReviewedDeepSummary());
    return true;
  }

  if (url.pathname === `${DEV_PREFIX}/writeback-preview`) {
    json(res, 200, await getGrowthWritebackPreview());
    return true;
  }

  return false;
}
