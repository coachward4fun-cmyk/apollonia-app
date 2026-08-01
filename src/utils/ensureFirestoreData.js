/**
 * Ensures Firestore has the app-config documents required for the app to
 * function on a fresh install. The sample-data seeding (jobs, crews, expenses,
 * customers) that lived here previously was removed for production use —
 * users now enter real data through the app's own flows.
 */

import { db } from '../config/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ROOFING_LINE_ITEMS } from '../data/roofingLineItems';

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

// ── One-time migration: 40-item Roofing line item list ─────────────────────────
// The Roofing job type's line items were previously seeded once (if empty) and
// never touched again, so replacing the seed constant alone doesn't reach data
// that's already saved. This overwrites the live Roofing job type with the new
// 40-item list a single time, tracked by meta/migrations.roofingLineItemsV2.

async function ensureRoofingLineItemsV2() {
  try {
    const migRef  = doc(db, 'meta', 'migrations');
    const migSnap = await getDoc(migRef);
    if (migSnap.exists() && migSnap.data().roofingLineItemsV2) return;

    const typesRef  = doc(db, 'appConfig', 'jobTypes');
    const typesSnap = await getDoc(typesRef);
    const types     = typesSnap.exists() ? (typesSnap.data().types || []) : [];
    const idx       = types.findIndex((t) => (t.name || '').toLowerCase() === 'roofing');

    if (idx >= 0) {
      types[idx] = { ...types[idx], lineItems: ROOFING_LINE_ITEMS };
    } else {
      types.push({ id: 'roofing-' + Date.now().toString(36), name: 'Roofing', lineItems: ROOFING_LINE_ITEMS });
    }
    await setDoc(typesRef, { types });
    await setDoc(migRef, { roofingLineItemsV2: true }, { merge: true });
    console.log('[Migration] Roofing line items updated to 40-item list');
  } catch (err) {
    console.warn('[Migration] roofingLineItemsV2 error:', err.message);
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
  await ensureRoofingLineItemsV2();
  return null;
}
