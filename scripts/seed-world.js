#!/usr/bin/env node
// =============================================================================
// DRIFT — world seed (operator script).
//
// In the Durable Object architecture the world self-seeds the deterministic
// ~200 objects the first time it is touched, so usually you never need to run
// this. It exists to (a) explicitly ensure a deployed world is seeded, and
// (b) force a clean re-seed during development.
//
//   node scripts/seed-world.js                      # ensure-seeded (idempotent, safe)
//   node scripts/seed-world.js https://your.app     # against a deployed URL
//   ADMIN_KEY=... node scripts/seed-world.js <url> --force   # wipe + re-seed
//
// Idempotent: ensure-seeded only seeds an empty world; the deterministic ids
// mean a forced re-seed always produces the exact same 200 objects.
// =============================================================================
const base = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2]
  : (process.env.DRIFT_URL || 'http://localhost:8787');
const force = process.argv.includes('--force');
const url = base.replace(/\/+$/, '') + '/admin/seed' + (force ? '?force=1' : '');

const headers = {};
if (force) {
  if (!process.env.ADMIN_KEY) {
    console.error('--force requires ADMIN_KEY in the environment (must match the deployed secret).');
    process.exit(1);
  }
  headers['x-admin-key'] = process.env.ADMIN_KEY;
}

try {
  const res = await fetch(url, { method: 'POST', headers });
  const body = await res.json().catch(() => ({}));
  console.log(res.status, JSON.stringify(body));
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('seed request failed:', e.message);
  console.error('(is the dev server running? `npm run dev`)');
  process.exit(1);
}
