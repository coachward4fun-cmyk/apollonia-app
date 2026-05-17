/**
 * Seeds meta/twilioConfig in Firestore with Twilio SMS settings.
 * Usage: node scripts/seedTwilioConfig.js
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
  await db.collection('meta').doc('twilioConfig').set({
    accountSid:  'REDACTED_TWILIO_SID',
    authToken:   'REDACTED_TWILIO_TOKEN',
    fromNumber:  '+18772694012',
  });

  const snap  = await db.collection('meta').doc('twilioConfig').get();
  const saved = snap.data();
  console.log('Saved to Firestore meta/twilioConfig:');
  console.log('  accountSid:', saved.accountSid);
  console.log('  authToken: ', '•'.repeat(saved.authToken.length));
  console.log('  fromNumber:', saved.fromNumber);
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
