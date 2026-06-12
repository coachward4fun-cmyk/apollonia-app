/**
 * One-time backfill: stamp the current published build onto every NAMED user doc.
 *
 * Why: build info (currentBuildId/currentBuildNumber/currentVersion) is written
 * by the app keyed on the anonymous-auth UID. After a fresh install the build
 * info lands on a new, unnamed UID doc, leaving the named doc (Scott, Kleodian,
 * Mary) with stale build fields so the Admin "USER BUILD VERSIONS" list shows
 * "Needs Update" forever. Going forward SelfClaimModal stamps build info on
 * claim; this script fixes the docs that were claimed before that change.
 *
 * Reads meta/buildInfo and updates each users/* doc that has a non-empty `name`.
 *
 * Usage: node scripts/fixNamedUserBuildInfo.js
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

async function main() {
  // 1) Read the current published build.
  const biSnap = await db.collection('meta').doc('buildInfo').get();
  if (!biSnap.exists) {
    console.error('meta/buildInfo not found — nothing to backfill. Run updateBuildExpiry.js first.');
    process.exit(1);
  }
  const info = biSnap.data();
  const currentBuildId     = info.buildId || '';
  const currentVersion     = info.version || '';
  const currentBuildNumber = parseInt(info.buildNumber, 10) || 0;

  console.log('Published build:');
  console.log('  buildId:    ', currentBuildId);
  console.log('  buildNumber:', currentBuildNumber);
  console.log('  version:    ', currentVersion);

  if (!currentBuildId || !currentBuildNumber) {
    console.error('\nmeta/buildInfo is missing buildId or buildNumber — aborting.');
    process.exit(1);
  }

  // 2) Find every named user doc.
  const usersSnap = await db.collection('users').get();
  const named = usersSnap.docs.filter((d) => (d.data().name || '').trim());

  if (named.length === 0) {
    console.log('\nNo named user docs found — nothing to update.');
    process.exit(0);
  }

  console.log(`\nUpdating ${named.length} named user doc(s):`);

  // 3) Stamp the current build onto each, in one batch.
  const batch = db.batch();
  const nowIso = new Date().toISOString();
  for (const d of named) {
    const u = d.data();
    console.log(`  - ${u.name} (${d.id}): ${u.currentBuildNumber ?? '—'} -> ${currentBuildNumber}`);
    batch.set(d.ref, {
      currentBuildId,
      currentBuildNumber,
      currentVersion,
      updatedAt: nowIso,
    }, { merge: true });
  }
  await batch.commit();

  console.log('\nDone — named user docs updated to the current published build.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
