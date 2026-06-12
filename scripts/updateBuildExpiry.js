/**
 * Updates meta/buildExpiry in Firestore with a 90-day expiry from today.
 * Usage: node scripts/updateBuildExpiry.js
 */

const admin    = require('firebase-admin');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

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

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

// Writes meta/buildInfo so the app can detect this build and prompt out-of-date
// installs to update. version comes from package.json; buildNumber from app.json
// (ios.buildNumber) — keep app.json's buildNumber incremented per build.
async function saveBuildInfo(buildDate) {
  const buildId = await prompt('\nEnter EAS Build ID (or press Enter to skip): ');
  if (!buildId) {
    console.log('Skipped meta/buildInfo (no build ID entered).');
    return;
  }

  const pkg     = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const version     = pkg.version || appJson.expo?.version || '';
  const buildNumber = appJson.expo?.ios?.buildNumber || '';
  const installUrl  = `https://expo.dev/accounts/coachward/projects/apollonia/builds/${buildId}`;

  await db.collection('meta').doc('buildInfo').set({
    buildId,
    installUrl,
    buildDate,
    version,
    buildNumber,
    updatedAt: new Date().toISOString(),
  });

  const snap  = await db.collection('meta').doc('buildInfo').get();
  const saved = snap.data();
  console.log('\nSaved to meta/buildInfo:');
  console.log('  buildId:    ', saved.buildId);
  console.log('  buildNumber:', saved.buildNumber);
  console.log('  version:    ', saved.version);
  console.log('  installUrl: ', saved.installUrl);
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

  // Prompt for + persist the EAS build info (CHANGE 1) after expiry is saved.
  await saveBuildInfo(buildDate);

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
