import { useState, useEffect } from 'react';
import { db } from '../config/firebase';
import { doc, onSnapshot } from 'firebase/firestore';

/** Parses an ISO date string as a local-timezone date (avoids UTC midnight shift). */
function parseLocalDate(isoString) {
  const [y, m, d] = isoString.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "August 3, 2026" */
export function formatExpiryDate(isoString) {
  if (!isoString) return null;
  return parseLocalDate(isoString).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Days left until the given ISO date. 0 = today, negative = expired. */
export function calcDaysLeft(isoString) {
  if (!isoString) return null;
  return Math.ceil((parseLocalDate(isoString) - new Date()) / (1000 * 60 * 60 * 24));
}

/** Color for the days-remaining value in the Settings card. */
export function daysColor(days) {
  if (days == null) return '#6b7280';
  if (days > 10) return '#16a34a';  // green
  if (days > 7)  return '#d97706';  // yellow  (days 8-10)
  if (days > 3)  return '#f97316';  // orange  (days 4-7)
  return '#dc2626';                  // red     (<= 3)
}

/**
 * Subscribes to meta/buildExpiry in Firestore.
 * Returns { expiryDate, buildDate, updatedBy, loading }.
 * All fields are null while loading or if the document is missing.
 */
export function useBuildExpiry() {
  const [expiry, setExpiry] = useState({ expiryDate: null, buildDate: null, updatedBy: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, 'meta', 'buildExpiry');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setExpiry(snap.exists() ? snap.data() : { expiryDate: null, buildDate: null, updatedBy: null });
        setLoading(false);
      },
      (err) => {
        console.warn('[useBuildExpiry] error:', err.code, err.message);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { ...expiry, loading };
}
