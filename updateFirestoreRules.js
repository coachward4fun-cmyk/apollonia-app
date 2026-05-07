/**
 * Updates Firestore security rules to allow all authenticated users to read/write.
 * Usage: node updateFirestoreRules.js
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

const KEY_PATH = path.join(__dirname, 'apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');
const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  serviceAccount.project_id,
});

const NEW_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

async function main() {
  const secRules = admin.securityRules();

  console.log('Fetching current Firestore rules…');
  try {
    const current = await secRules.getFirestoreRuleset();
    const src = current.source[0]?.content || '';
    console.log('Current rules:\n' + src.trim());
  } catch (e) {
    console.log('(Could not fetch current rules:', e.message, ')');
  }

  console.log('\nApplying new rules…');
  await secRules.releaseFirestoreRulesetFromSource(NEW_RULES);

  console.log('Done. New rules:');
  console.log(NEW_RULES);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
