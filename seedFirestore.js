/**
 * One-time Firestore seed script — Firebase Admin SDK.
 * Usage: node seedFirestore.js
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const KEY_PATH    = path.join(__dirname, 'apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');
const BACKUP_PATH = path.join(os.homedir(), 'Downloads', 'apollonia-backup-2026-05-04.json');

// ── Load files ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(KEY_PATH)) {
  console.error('Service account key not found:', KEY_PATH);
  process.exit(1);
}
if (!fs.existsSync(BACKUP_PATH)) {
  console.error('Backup file not found:', BACKUP_PATH);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const backup         = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));

const JOBS     = Array.isArray(backup.jobs)     ? backup.jobs     : [];
const CREWS    = Array.isArray(backup.crews)    ? backup.crews    : [];
const EXPENSES = Array.isArray(backup.expenses) ? backup.expenses : [];

console.log(`Backup loaded: ${JOBS.length} jobs, ${CREWS.length} crews, ${EXPENSES.length} expenses`);

// ── Init Admin SDK ─────────────────────────────────────────────────────────────

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});

const db = admin.firestore();

// ── Batch write helper ─────────────────────────────────────────────────────────

async function batchWrite(collectionName, items) {
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = db.batch();
    items.slice(i, i + CHUNK).forEach((item) => {
      batch.set(db.collection(collectionName).doc(item.id), item);
    });
    await batch.commit();
    written += items.slice(i, i + CHUNK).length;
  }
  return written;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Project: ${serviceAccount.project_id}\n`);

  console.log(`Writing ${JOBS.length} jobs…`);
  const j = await batchWrite('jobs', JOBS);

  console.log(`Writing ${CREWS.length} crews…`);
  const c = await batchWrite('crews', CREWS);

  console.log(`Writing ${EXPENSES.length} expenses…`);
  const e = await batchWrite('expenses', EXPENSES);

  console.log(`\nSuccess: ${j} jobs, ${c} crews, ${e} expenses written to Firestore.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
