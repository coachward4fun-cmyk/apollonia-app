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
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('Missing required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER');
    console.error('Set them in a .env file or inline, e.g.:');
    console.error('  TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+1... \\');
    console.error('    node scripts/seedTwilioConfig.js');
    process.exit(1);
  }

  await db.collection('meta').doc('twilioConfig').set({
    accountSid,
    authToken,
    fromNumber,
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
