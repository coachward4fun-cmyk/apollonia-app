import { db, auth } from '../config/firebase';
import { collection, writeBatch, doc, serverTimestamp } from 'firebase/firestore';

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
  const batch   = writeBatch(db);
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
    userName:  friendlyName(user.email),
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
