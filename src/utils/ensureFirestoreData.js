/**
 * Ensures Firestore has the app-config documents required for the app to
 * function on a fresh install. The sample-data seeding (jobs, crews, expenses,
 * customers) that lived here previously was removed for production use —
 * users now enter real data through the app's own flows.
 */

import { db } from '../config/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// ── Meta document: build expiry ───────────────────────────────────────────────

async function ensureBuildExpiryDoc() {
  try {
    const ref  = doc(db, 'meta', 'buildExpiry');
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        expiryDate: '2026-08-04',
        buildDate:  '2026-05-06',
        updatedBy:  'Scott Ward',
      });
      console.log('[Seed] meta/buildExpiry created');
    }
  } catch (err) {
    // Non-fatal — Settings will show "Loading…" if this fails
    console.warn('[Seed] meta/buildExpiry error:', err.message);
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Call on every login. Ensures app-config docs (currently just
 * meta/buildExpiry) exist in Firestore. Returns null — no seed return value
 * since nothing user-facing is seeded anymore.
 */
export async function ensureFirestoreData(_onProgress) {
  await ensureBuildExpiryDoc();
  return null;
}
