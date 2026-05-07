import { db, auth } from '../config/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

const USER_NAMES = {
  'coachward4fun@gmail.com':      'Scott',
  'claudioroma999@gmail.com':     'Kleodian',
  'MaryC​Stiles@gmail.com':       'Mary',
  'marycstiles@gmail.com':        'Mary',
};

export function friendlyName(email) {
  if (!email) return 'Unknown';
  const lower = email.toLowerCase();
  for (const [k, v] of Object.entries(USER_NAMES)) {
    if (k.toLowerCase() === lower) return v;
  }
  return email.split('@')[0];
}

/**
 * Fire-and-forget activity log write. Never throws or blocks the caller.
 * action: short machine key e.g. 'job_created'
 * details: friendly display string e.g. 'Created job: Replace roof'
 */
export async function logActivity(action, details = '') {
  try {
    const user = auth.currentUser;
    if (!user) return;
    await addDoc(collection(db, 'activityLog'), {
      timestamp: serverTimestamp(),
      userId:    user.uid,
      userEmail: user.email || '',
      userName:  friendlyName(user.email),
      action,
      details,
    });
  } catch (err) {
    console.warn('[ActivityLog] write failed:', err.message);
  }
}
