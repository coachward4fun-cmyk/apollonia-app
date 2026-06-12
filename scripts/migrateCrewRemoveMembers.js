// Crew cleanup migration: remove the legacy `members` array from every crew doc.
//
// crewSize (set by migrateCrewDataModel.js) now replaces the per-member list, so
// the worker-name backup is no longer needed. Uses update() + FieldValue.delete()
// to drop only the `members` field; all other fields are preserved:
//   KEEP: id, name, lead, crewSize, leadDailyRate, workerDailyRate,
//         helperDailyRate, migrated
const admin = require('firebase-admin');
const serviceAccount = require('../apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async () => {
  const db = admin.firestore();
  const snap = await db.collection('crews').get();
  console.log('Found', snap.size, 'crew docs.\n');

  for (const doc of snap.docs) {
    await doc.ref.update({ members: admin.firestore.FieldValue.delete() });
    console.log(`Removed members from ${doc.id} (${doc.data().name})`);
  }

  console.log('\n--- Verification (read-back) ---');
  const after = await db.collection('crews').get();
  const rows = [];
  after.forEach((d) => {
    const data = d.data();
    rows.push({
      id: d.id,
      name: data.name,
      hasMembers: Object.prototype.hasOwnProperty.call(data, 'members'),
      remainingKeys: Object.keys(data).sort(),
      crewSize: data.crewSize,
      leadDailyRate: data.leadDailyRate,
      workerDailyRate: data.workerDailyRate,
      helperDailyRate: data.helperDailyRate,
      migrated: data.migrated,
      lead_preserved: !!data.lead && data.lead.name != null,
    });
  });
  console.log(JSON.stringify(rows, null, 2));

  const ok = rows.every((r) =>
    r.hasMembers === false &&
    r.crewSize != null &&
    r.leadDailyRate != null && r.workerDailyRate != null && r.helperDailyRate != null &&
    r.migrated === true && r.lead_preserved === true
  );
  console.log('\nAll members removed & remaining fields intact:', ok);
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
