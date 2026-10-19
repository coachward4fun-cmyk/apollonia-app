import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { subscribeReminders } from '../services/db';

export function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isReminderPastDue(reminder, todayStr = localTodayStr()) {
  return !reminder.done && !!reminder.dueDate && reminder.dueDate < todayStr;
}

// Live list of the signed-in user's reminders (newest first, per subscribeReminders).
export default function useReminders() {
  const { user } = useAuth();
  const uid = user?.uid;
  const [reminders, setReminders] = useState([]);

  useEffect(() => subscribeReminders(uid, setReminders), [uid]);

  return { reminders, userId: uid };
}
