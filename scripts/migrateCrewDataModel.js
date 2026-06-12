// Crew data-model migration (#3 / #4).
//
// For each crew doc:
//   1. crewSize = members.length + 1   (lead + all members)
//   2. Add default daily rates: leadDailyRate 300, helperDailyRate 150, workerDailyRate 250
//   3. Keep the existing `lead` field untouched
//   4. Keep the `members` array as a backup; add `migrated: true`
//   5. Use update() so existing fields are preserved (no full overwrite)
//
// Idempotent: re-running recomputes crewSize from members.length and only sets
// rate defaults if they are missing, so it won't clobber rates edited later.
const admin = require('firebase-admin');
const serviceAccount = require('../apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const DEFAULTS = { leadDailyRate: 300, helperDailyRate: 150, workerDailyRate: 250 };

(async () => {
  const db = admin.firestore();
  const snap = await db.collection('crews').get();
  console.log('Found', snap.size, 'crew docs.\n');

  for (const doc of snap.docs) {
    const d = doc.data();
    const memberCount = Array.isArray(d.members) ? d.members.length : 0;
    const crewSize = memberCount + 1; // lead + all members

    const update = {
      crewSize,
      // Only fill rate defaults that aren't already present — preserves any
      // rates a user may have set on a prior run.
      leadDailyRate:   d.leadDailyRate   != null ? d.leadDailyRate   : DEFAULTS.leadDailyRate,
      helperDailyRate: d.helperDailyRate != null ? d.helperDailyRate : DEFAULTS.helperDailyRate,
      workerDailyRate: d.workerDailyRate != null ? d.workerDailyRate : DEFAULTS.workerDailyRate,
      migrated: true,
    };

    await doc.ref.update(update);
    console.log(`Updated ${doc.id} (${d.name}): members=${memberCount} -> crewSize=${crewSize}`);
  }

  // Verify by reading every doc back.
  console.log('\n--- Verification (read-back) ---');
  const after = await db.collection('crews').get();
  const rows = [];
  after.forEach((doc) => {
    const d = doc.data();
    rows.push({
      id: doc.id,
      name: d.name,
      crewSize: d.crewSize,
      members_len: Array.isArray(d.members) ? d.members.length : null,
      leadDailyRate: d.leadDailyRate,
      helperDailyRate: d.helperDailyRate,
      workerDailyRate: d.workerDailyRate,
      migrated: d.migrated,
      lead_preserved: !!d.lead && d.lead.name != null,
    });
  });
  console.log(JSON.stringify(rows, null, 2));

  const ok = rows.every((r) =>
    r.crewSize === r.members_len + 1 &&
    r.leadDailyRate === 300 && r.helperDailyRate === 150 && r.workerDailyRate === 250 &&
    r.migrated === true && r.lead_preserved === true
  );
  console.log('\nAll docs migrated correctly:', ok);
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
