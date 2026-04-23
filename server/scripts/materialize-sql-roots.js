import { materializeGrowthTruthSnapshot } from '../core/sql-growth-service.js';

const label = process.argv[2] || '';
const owner_id = process.argv[3] || '';
const realm_id = process.argv[4] || '';

const out = await materializeGrowthTruthSnapshot({ label, owner_id, realm_id });
console.log(JSON.stringify(out, null, 2));
