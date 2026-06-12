import { db, auth } from '../config/firebase';
import { collection, writeBatch, doc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

// Legacy email → display-name map. Only useful when the app is signed in with
// an email-based account (Firebase email/password, Google, etc.). The app
// currently uses anonymous auth so this map never matches — kept as a fallback
// for any future email-auth path, not removed to avoid breaking that future.
const USER_NAMES = {
  'coachward4fun@gmail.com':  'Scott',
  'claudioroma999@gmail.com': 'Kleodian',
  'MaryC​Stiles@gmail.com':   'Mary',
  'marycstiles@gmail.com':    'Mary',
};

export function friendlyName(email) {
  if (!email) return 'Unknown';
  const lower = email.toLowerCase();
  for (const [k, v] of Object.entries(USER_NAMES)) {
    if (k.toLowerCase() === lower) return v;
  }
  return email.split('@')[0];
}

// ── Live cache of users/{uid}.name ────────────────────────────────────────────
// Anonymous Firebase Auth never has an email, so the real name lives on the
// users/{uid} Firestore doc (written by SelfClaimModal / EditUserScreen).
// Subscribing here keeps a module-level cache in sync so logActivity can stamp
// the correct name synchronously — no per-call Firestore read.

let _cachedName   = null;
let _unsubUserDoc = null;

function _subscribeToUserDoc(uid) {
  if (_unsubUserDoc) {
    _unsubUserDoc();
    _unsubUserDoc = null;
  }
  _cachedName = null;
  if (!uid) return;
  _unsubUserDoc = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      _cachedName = snap.exists() ? (snap.data().name || null) : null;
    },
    (err) => {
      console.warn('[ActivityLog] user subscription error:', err?.message);
      _cachedName = null;
    },
  );
}

// Track the current uid so we can swap subscriptions when auth state changes.
// onAuthStateChanged also fires with the current state on subscribe, so this
// handles the "module loads after the user is already signed in" case too.
onAuthStateChanged(auth, (firebaseUser) => {
  _subscribeToUserDoc(firebaseUser?.uid || null);
});

function _resolveUserName(user) {
  if (_cachedName) return _cachedName;
  if (user?.email) return friendlyName(user.email);
  return 'Unknown';
}

// ── Batched write queue ────────────────────────────────────────────────────────
// Entries accumulate in memory and are committed every 30 seconds,
// or immediately when the queue reaches 20 items.

const _queue   = [];
const INTERVAL = 30_000;
const MAX_SIZE = 20;
let _timer     = null;

async function _flush() {
  clearTimeout(_timer);
  _timer = null;
  if (_queue.length === 0) return;
  const entries = _queue.splice(0, _queue.length);
  // Re-resolve userName for entries that were queued before the users/{uid}
  // subscription loaded — common immediately after first sign-in. Only override
  // if the queued entry belongs to the currently-cached user (defense against
  // a queue spanning a sign-out / sign-in of a different account).
  const currentUid = auth.currentUser?.uid || null;
  if (_cachedName && currentUid) {
    for (const entry of entries) {
      if (entry.userName === 'Unknown' && entry.userId === currentUid) {
        entry.userName = _cachedName;
      }
    }
  }
  const batch = writeBatch(db);
  entries.forEach((entry) => batch.set(doc(collection(db, 'activityLog')), entry));
  batch.commit().catch((err) => console.warn('[ActivityLog] batch write failed:', err.message));
}

function _schedule() {
  if (_timer) return;
  _timer = setTimeout(_flush, INTERVAL);
}

/**
 * Fire-and-forget. Queues an activity log entry; never throws or blocks the caller.
 */
export function logActivity(action, details = '') {
  const user = auth.currentUser;
  if (!user) return;
  _queue.push({
    timestamp: serverTimestamp(),
    userId:    user.uid,
    userEmail: user.email || '',
    userName:  _resolveUserName(user),
    action,
    details,
  });
  if (_queue.length >= MAX_SIZE) {
    _flush();
  } else {
    _schedule();
  }
}

/** Flush the queue immediately — call on app background to avoid losing entries. */
export function flushActivityLog() {
  return _flush();
}
