/**
 * Updates Firebase Storage security rules to allow authenticated reads/writes.
 * Usage: node updateStorageRules.js
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const KEY_PATH = path.join(__dirname, 'apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');
const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const PROJECT_ID = serviceAccount.project_id;
const BUCKET     = 'apollonia-construction.firebasestorage.app';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId:  PROJECT_ID,
  storageBucket: BUCKET,
});

const NEW_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

async function getAccessToken() {
  const cred = admin.credential.cert(serviceAccount);
  const token = await cred.getAccessToken();
  return token.access_token;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Getting access token…');
  const token = await getAccessToken();

  // 1. Create a new ruleset
  console.log('Creating ruleset…');
  const createRes = await httpsRequest({
    hostname: 'firebaserules.googleapis.com',
    path:     `/v1/projects/${PROJECT_ID}/rulesets`,
    method:   'POST',
    headers:  {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  }, JSON.stringify({
    source: {
      files: [{ name: 'storage.rules', content: NEW_RULES }],
    },
  }));

  if (createRes.status !== 200) {
    console.error('Failed to create ruleset:', createRes.status, createRes.body);
    process.exit(1);
  }

  const ruleset = JSON.parse(createRes.body);
  const rulesetName = ruleset.name; // projects/.../rulesets/...
  console.log('Ruleset created:', rulesetName);

  // 2. Release the ruleset to the Storage bucket
  const releaseName = `projects/${PROJECT_ID}/releases/firebase.storage/${BUCKET}`;
  console.log('Releasing ruleset to bucket…');

  const releaseRes = await httpsRequest({
    hostname: 'firebaserules.googleapis.com',
    path:     `/v1/${releaseName}`,
    method:   'PATCH',
    headers:  {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  }, JSON.stringify({
    release: { name: releaseName, rulesetName },
  }));

  if (releaseRes.status === 200) {
    console.log('Storage rules updated successfully!');
    console.log('New rules:\n' + NEW_RULES);
  } else if (releaseRes.status === 404) {
    // Release doesn't exist yet — create it
    console.log('Creating new release…');
    const newReleaseRes = await httpsRequest({
      hostname: 'firebaserules.googleapis.com',
      path:     `/v1/projects/${PROJECT_ID}/releases`,
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    }, JSON.stringify({
      name: releaseName, rulesetName,
    }));

    if (newReleaseRes.status === 200) {
      console.log('Storage rules created and released!');
      console.log('New rules:\n' + NEW_RULES);
    } else {
      console.error('Could not create release:', newReleaseRes.status, newReleaseRes.body);
      console.log('\nManual fallback: Go to Firebase Console → Storage → Rules and paste:');
      console.log(NEW_RULES);
    }
  } else {
    console.error('Failed to release ruleset:', releaseRes.status, releaseRes.body);
    console.log('\nManual fallback: Go to Firebase Console → Storage → Rules and paste:');
    console.log(NEW_RULES);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  console.log('\nIf Firebase Storage has not been enabled yet:');
  console.log('1. Go to Firebase Console → Build → Storage → Get Started');
  console.log('2. Choose your region and click Done');
  console.log('3. Then run this script again, or paste these rules manually under Storage → Rules:');
  console.log(NEW_RULES);
  process.exit(1);
});
