/**
 * Normalises all crew lead mobile numbers in Firestore to E.164 format.
 * Twilio requires +15312226245, not 531-222-6245 or (531) 222-6245.
 *
 * Usage: node scripts/fixCrewPhones.js
 * Dry run (no writes): node scripts/fixCrewPhones.js --dry-run
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

const DRY_RUN  = process.argv.includes('--dry-run');
const KEY_PATH = path.join(__dirname, '..', 'apollonia-construction-firebase-adminsdk-fbsvc-c1e5618be0.json');

if (!fs.existsSync(KEY_PATH)) {
  console.error('Service account key not found:', KEY_PATH);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))),
});

const db = admin.firestore();

function toE164(phone) {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;          // already E.164
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null; // unrecognisable — leave unchanged
}

async function main() {
  console.log(DRY_RUN ? '--- DRY RUN (no writes) ---' : '--- LIVE RUN ---');

  const snap = await db.collection('crews').get();
  if (snap.empty) { console.log('No crews found.'); process.exit(0); }

  let changed = 0;
  let skipped = 0;

  for (const docSnap of snap.docs) {
    const crew  = docSnap.data();
    const raw   = crew.lead?.mobile;
    const fixed = raw ? toE164(raw) : null;

    if (!raw) {
      console.log(`  ${crew.name || docSnap.id}: no mobile — skipped`);
      skipped++;
      continue;
    }

    if (fixed === raw) {
      console.log(`  ${crew.name || docSnap.id}: ${raw} — already E.164, no change`);
      skipped++;
      continue;
    }

    if (!fixed) {
      console.warn(`  ${crew.name || docSnap.id}: "${raw}" — unrecognisable format, leaving unchanged`);
      skipped++;
      continue;
    }

    console.log(`  ${crew.name || docSnap.id}: "${raw}" → "${fixed}"`);

    if (!DRY_RUN) {
      await docSnap.ref.set({ lead: { ...crew.lead, mobile: fixed } }, { merge: true });
    }
    changed++;
  }

  console.log(`\nDone — ${changed} updated, ${skipped} skipped${DRY_RUN ? ' (dry run, nothing written)' : ''}`);
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
