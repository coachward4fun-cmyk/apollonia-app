// Prune anonymous bootstrap shells from the `users` collection.
//
// Deletes a user doc ONLY when BOTH name and mobile are empty/null/missing.
// Any doc with a name OR a mobile is kept — this inherently preserves the three
// named docs (Scott, Kleodian, Mary) and any unclaimed manual_* template that
// carries a mobile. A belt-and-suspenders guard also refuses to delete anything
// whose name matches a known team member.
//
// Usage: node scripts/pruneAnonymousShells.js
const admin = require('firebase-admin');
const serviceAccount = require('../apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const KNOWN_NAMES = ['scott', 'kleodian', 'mary'];
const hasVal = (v) => !!(v && String(v).trim());

(async () => {
  const db = admin.firestore();
  const snap = await db.collection('users').get();
  console.log('Total user docs before:', snap.size);

  const toDelete = [];
  const toKeep = [];
  snap.forEach((doc) => {
    const u = doc.data();
    const named = hasVal(u.name);
    const mobiled = hasVal(u.mobile);
    if (!named && !mobiled) {
      toDelete.push(doc.ref);
    } else {
      toKeep.push({ id: doc.id, name: u.name || '(no name)', mobile: u.mobile || '(no mobile)' });
    }
  });

  // Safety invariant: nothing slated for deletion may carry a name or mobile,
  // and none may match a known team member.
  const violation = toDelete.find((ref) => {
    const u = snap.docs.find((d) => d.id === ref.id).data();
    return hasVal(u.name) || hasVal(u.mobile) ||
      (u.name && KNOWN_NAMES.includes(String(u.name).trim().toLowerCase()));
  });
  if (violation) {
    console.error('ABORT: a delete candidate has a name/mobile — refusing to run.');
    process.exit(1);
  }

  console.log(`\nWill DELETE ${toDelete.length} anonymous shell doc(s):`);
  toDelete.forEach((ref) => console.log('  -', ref.id));

  console.log(`\nWill KEEP ${toKeep.length} doc(s) (have name or mobile):`);
  toKeep.forEach((k) => console.log(`  + ${k.id}  name=${JSON.stringify(k.name)} mobile=${JSON.stringify(k.mobile)}`));

  // Delete in chunks of 450 (Firestore batch limit is 500).
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 450) {
    const batch = db.batch();
    toDelete.slice(i, i + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += Math.min(450, toDelete.length - i);
  }
  console.log(`\nDeleted ${deleted} doc(s).`);

  // Verify
  const after = await db.collection('users').get();
  let stillAnon = 0, named = 0;
  after.forEach((doc) => {
    const u = doc.data();
    if (!hasVal(u.name) && !hasVal(u.mobile)) stillAnon++;
    if (hasVal(u.name)) named++;
  });
  console.log('\n=== Verification ===');
  console.log('Total user docs after:', after.size);
  console.log('Named docs remaining:', named);
  console.log('Anonymous shells remaining (should be 0):', stillAnon);
  process.exit(stillAnon === 0 ? 0 : 1);
})().catch((err) => { console.error('Prune failed:', err.message); process.exit(1); });
