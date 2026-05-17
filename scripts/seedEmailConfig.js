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
  const fromEmail   = process.env.GMAIL_FROM_EMAIL;
  const fromName    = process.env.GMAIL_FROM_NAME;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  const replyTo     = process.env.GMAIL_REPLY_TO   || fromEmail;
  const cc          = (process.env.GMAIL_CC || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!fromEmail || !fromName || !appPassword) {
    console.error('Missing required env vars: GMAIL_FROM_EMAIL, GMAIL_FROM_NAME, GMAIL_APP_PASSWORD');
    console.error('Set them in a .env file or inline, e.g.:');
    console.error('  GMAIL_FROM_EMAIL=you@gmail.com GMAIL_FROM_NAME="Your Name" \\');
    console.error('    GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx \\');
    console.error('    [GMAIL_REPLY_TO=reply@gmail.com] [GMAIL_CC=cc1@x.com,cc2@x.com] \\');
    console.error('    node scripts/seedEmailConfig.js');
    process.exit(1);
  }

  await db.collection('meta').doc('emailConfig').set({
    fromEmail,
    fromName,
    appPassword,
    replyTo,
    cc,
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
