#!/usr/bin/env node
/**
 * Reads an Apollonia web-dashboard backup JSON and writes src/data/seedData.json.
 * Photo base64 dataUrl is stripped — only id, name, and jobId are kept.
 *
 * Usage:  node scripts/convert-backup.js <path-to-backup.json>
 */

const fs = require('fs');
const path = require('path');

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: node scripts/convert-backup.js <path-to-backup.json>');
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(backupPath), 'utf8');
const backup = JSON.parse(raw);

if (!backup.jobs || !Array.isArray(backup.jobs)) {
  console.error('Invalid backup: missing "jobs" array.');
  process.exit(1);
}

// Flatten photos dict {jobId: [{id,name,dataUrl},...]} → [{id,name,jobId}] (no base64)
const photos = [];
if (backup.photos && typeof backup.photos === 'object') {
  for (const [jobId, list] of Object.entries(backup.photos)) {
    if (Array.isArray(list)) {
      for (const p of list) {
        photos.push({ id: p.id, name: p.name, jobId });
      }
    }
  }
}

const seed = {
  exportedAt: backup.exportedAt || null,
  jobs:     backup.jobs     || [],
  crews:    backup.crews    || [],
  expenses: backup.expenses || [],
  photos,
};

const outDir  = path.join(__dirname, '..', 'src', 'data');
const outPath = path.join(outDir, 'seedData.json');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(seed, null, 2), 'utf8');

const bytes = fs.statSync(outPath).size;
console.log(`✓ Wrote ${outPath}`);
console.log(`  ${seed.jobs.length} jobs · ${seed.crews.length} crews · ${seed.expenses.length} expenses · ${photos.length} photo records`);
console.log(`  File size: ${(bytes / 1024).toFixed(1)} KB`);
