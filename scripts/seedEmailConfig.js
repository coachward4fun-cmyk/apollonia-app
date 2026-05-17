/**
 * Seeds meta/emailConfig in Firestore with Gmail SMTP settings.
 * Usage: node scripts/seedEmailConfig.js
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
  await db.collection('meta').doc('emailConfig').set({
    fromEmail:   'claudioroma999@gmail.com',
    fromName:    'Kleodian Nazeraj - Apollonia Construction LLC',
    appPassword: 'REDACTED_GMAIL_PASSWORD',
    replyTo:     'kleodiannazeraj@icloud.com',
    cc:          ['claudioroma999@gmail.com', 'apolloniaconstructionllc@gmail.com'],
  });

  const snap  = await db.collection('meta').doc('emailConfig').get();
  const saved = snap.data();
  console.log('Saved to Firestore meta/emailConfig:');
  console.log('  fromEmail:  ', saved.fromEmail);
  console.log('  fromName:   ', saved.fromName);
  console.log('  appPassword:', '•'.repeat(saved.appPassword.length));
  console.log('  replyTo:    ', saved.replyTo);
  console.log('  cc:         ', saved.cc.join(', '));
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
