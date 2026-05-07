/**
 * Updates meta/buildExpiry in Firestore with a 90-day expiry from today.
 * Usage: node scripts/updateBuildExpiry.js
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

function toISODate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

async function main() {
  const today  = new Date();
  today.setHours(0, 0, 0, 0);

  const expiry = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);

  const expiryDate = toISODate(expiry);
  const buildDate  = toISODate(today);

  console.log('Today:       ', buildDate);
  console.log('Expiry (+90d):', expiryDate);

  await db.collection('meta').doc('buildExpiry').set({
    expiryDate,
    buildDate,
    updatedBy: 'Scott Ward',
  });

  // Verify round-trip
  const snap = await db.collection('meta').doc('buildExpiry').get();
  const saved = snap.data();
  console.log('\nSaved to Firestore:');
  console.log('  expiryDate:', saved.expiryDate);
  console.log('  buildDate: ', saved.buildDate);
  console.log('  updatedBy: ', saved.updatedBy);

  const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
  console.log(`\nDays remaining: ${daysLeft}`);
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
