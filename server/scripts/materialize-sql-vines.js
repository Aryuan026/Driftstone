import { materializeVineTruthSnapshot } from '../core/sql-growth-service.js';

const label = process.argv[2] || 'reviewed_13m';
const owner_id = process.argv[3] || '';
const realm_id = process.argv[4] || '';

const result = await materializeVineTruthSnapshot({ label, owner_id, realm_id });
console.log(JSON.stringify(result, null, 2));
