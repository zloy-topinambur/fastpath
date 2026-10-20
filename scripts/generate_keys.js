// FastPath Multi-Tier License Key Generator for Lava.top / Gumroad / Direct Sales
// Generates keys for: 1 Month, 3 Months, 6 Months, and 1 Year

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_SALT = "FastPath_Pro_2026_Figma_Secret_Salt_Key!";

function computeChecksum(body) {
  let hash = 0x811c9dc5; // FNV-1a 32-bit hash
  const str = body.toUpperCase() + SECRET_SALT;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = ((hash >>> 0) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  return hex;
}

function generateSingleKey(tier = '1M') {
  // tier: '1M', '3M', '6M', '1Y'
  const tag = tier.toUpperCase();
  const b1 = tag + crypto.randomBytes(1).toString('hex').toUpperCase().slice(0, 4 - tag.length);
  const b2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const body = `${b1}-${b2}-${b3}`;
  const checksum = computeChecksum(body);
  return `FPPRO-${body}-${checksum}`;
}

function getLicensePlanInfo(key) {
  if (!key || typeof key !== 'string') return null;
  const clean = key.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (clean === 'FPPRO-DEV-MASTER-UNLIMITED') {
    return { valid: true, days: 9999, label: 'Master Dev Unlimited', tier: 'DEV' };
  }
  const parts = clean.split('-');
  if (parts.length !== 5 || parts[0] !== 'FPPRO') return null;
  const body = parts[1] + '-' + parts[2] + '-' + parts[3];
  if (parts[4] !== computeChecksum(body)) return null;

  const tag = parts[1];
  if (tag === '3M' || tag.startsWith('3M') || tag === '03M') {
    return { valid: true, days: 93, label: '3 Months Pro', tier: '3M' };
  }
  if (tag === '6M' || tag.startsWith('6M') || tag === '06M') {
    return { valid: true, days: 186, label: '6 Months Pro', tier: '6M' };
  }
  if (tag === '1Y' || tag.startsWith('1Y') || tag === '12M') {
    return { valid: true, days: 366, label: '1 Year Pro', tier: '1Y' };
  }
  return { valid: true, days: 31, label: '1 Month Pro', tier: '1M' };
}

function generatePool(tier, count) {
  const set = new Set();
  while (set.size < count) {
    set.add(generateSingleKey(tier));
  }
  return Array.from(set);
}

const countPerTier = parseInt(process.argv[2], 10) || 50;
console.log(`Generating ${countPerTier} keys for each tier (1M, 3M, 6M, 1Y)...`);

const keys1M = generatePool('1M', countPerTier);
const keys3M = generatePool('3M', countPerTier);
const keys6M = generatePool('6M', countPerTier);
const keys1Y = generatePool('1Y', countPerTier);

const baseDir = path.join(__dirname, '..');

fs.writeFileSync(path.join(baseDir, 'keys_1_month.txt'), keys1M.join('\n'), 'utf8');
fs.writeFileSync(path.join(baseDir, 'keys_3_months.txt'), keys3M.join('\n'), 'utf8');
fs.writeFileSync(path.join(baseDir, 'keys_6_months.txt'), keys6M.join('\n'), 'utf8');
fs.writeFileSync(path.join(baseDir, 'keys_1_year.txt'), keys1Y.join('\n'), 'utf8');

const combinedCatalog = [
  '# ========================================================',
  '# FASTPATH PRO LICENSE KEYS CATALOG FOR LAVA.TOP',
  '# ========================================================',
  '# Master Developer Key (Lifetime): FPPRO-DEV-MASTER-UNLIMITED',
  '',
  '# --------------------------------------------------------',
  `# TIER 1: 1 MONTH PRO (${keys1M.length} keys, +31 days each)`,
  '# --------------------------------------------------------',
  ...keys1M,
  '',
  '# --------------------------------------------------------',
  `# TIER 2: 3 MONTHS PRO (${keys3M.length} keys, +93 days each)`,
  '# --------------------------------------------------------',
  ...keys3M,
  '',
  '# --------------------------------------------------------',
  `# TIER 3: 6 MONTHS PRO (${keys6M.length} keys, +186 days each)`,
  '# --------------------------------------------------------',
  ...keys6M,
  '',
  '# --------------------------------------------------------',
  `# TIER 4: 1 YEAR PRO (${keys1Y.length} keys, +366 days each)`,
  '# --------------------------------------------------------',
  ...keys1Y
].join('\n');

fs.writeFileSync(path.join(baseDir, 'keys_for_lava.txt'), combinedCatalog, 'utf8');

console.log('\n✅ Successfully generated all license keys!');
console.log(`- 1 Month (31d):  keys_1_month.txt (${keys1M.length} keys)`);
console.log(`- 3 Months (93d): keys_3_months.txt (${keys3M.length} keys)`);
console.log(`- 6 Months (186d): keys_6_months.txt (${keys6M.length} keys)`);
console.log(`- 1 Year (366d):   keys_1_year.txt (${keys1Y.length} keys)`);
console.log(`- Combined Catalog: keys_for_lava.txt`);

console.log('\nSample key verification:');
console.log('1M sample:', keys1M[0], '->', getLicensePlanInfo(keys1M[0]));
console.log('3M sample:', keys3M[0], '->', getLicensePlanInfo(keys3M[0]));
console.log('6M sample:', keys6M[0], '->', getLicensePlanInfo(keys6M[0]));
console.log('1Y sample:', keys1Y[0], '->', getLicensePlanInfo(keys1Y[0]));
console.log('DEV Master:', 'FPPRO-DEV-MASTER-UNLIMITED', '->', getLicensePlanInfo('FPPRO-DEV-MASTER-UNLIMITED'));
