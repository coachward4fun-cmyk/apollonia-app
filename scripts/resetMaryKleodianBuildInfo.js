/**
 * One-time correction: the earlier backfill (fixNamedUserBuildInfo.js) wrongly
 * stamped Mary and Kleodian onto Build 3 even though they haven't installed it.
 *
 * This resets ONLY Mary and Kleodian: currentBuildNumber -> 0 and clears
 * currentBuildId, so the Admin "USER BUILD VERSIONS" list shows "Needs Update"
 * for them until they actually launch Build 3 (at which point buildUpdate.js
 * writes the real values). Scott's doc is left untouched (he is on Build 3).
 *
 * Usage: node scripts/resetMaryKleodianBuildInfo.js
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

const KEY_PATH = path.join(__dirname, '..', 'apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');

if (!fs.existsSync(KEY_PATH)) {
  console.error('Service account key not found:', KEY_PATH);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});

const db = admin.firestore();

const TARGET_NAMES = ['Mary', 'Kleodian'];

async function main() {
  const usersSnap = await db.collection('users').get();
  const targets = usersSnap.docs.filter((d) =>
    TARGET_NAMES.includes((d.data().name || '').trim())
  );

  if (targets.length === 0) {
    console.log('No matching user docs found for', TARGET_NAMES.join(', '), '— nothing to do.');
    process.exit(0);
  }

  console.log(`Resetting ${targets.length} user doc(s):`);

  const batch = db.batch();
  const nowIso = new Date().toISOString();
  for (const d of targets) {
    const u = d.data();
    console.log(`  - ${u.name} (${d.id}): buildNumber ${u.currentBuildNumber ?? '—'} -> 0, clearing currentBuildId`);
    batch.set(d.ref, {
      currentBuildNumber: 0,
      currentBuildId:     admin.firestore.FieldValue.delete(),
      updatedAt:          nowIso,
    }, { merge: true });
  }
  await batch.commit();

  console.log('\nDone. Verifying…\n');

  // Verify
  for (const d of targets) {
    const snap = await d.ref.get();
    const u = snap.data();
    console.log(`  ${u.name} → currentBuildNumber: ${u.currentBuildNumber}, currentBuildId: ${u.currentBuildId === undefined ? '(cleared)' : u.currentBuildId}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
