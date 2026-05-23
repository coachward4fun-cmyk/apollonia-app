import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { saveUser } from '../services/db';

const EAS_PROJECT_ID = 'e0e99a7a-2b55-4abc-b349-2637069eedf3';

export default function usePushToken(user) {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [pushToken,         setPushToken]         = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;

    (async () => {
      try {
        const { status: existing } = await Notifications.getPermissionsAsync();
        let status = existing;
        if (status !== 'granted') {
          const req = await Notifications.requestPermissionsAsync();
          status = req.status;
        }
        if (status !== 'granted') {
          console.warn('[push] permission not granted:', status);
          if (!cancelled) setPermissionGranted(false);
          return;
        }
        if (!cancelled) setPermissionGranted(true);

        const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
        const token = tokenResult?.data;
        if (!token) {
          console.warn('[push] empty token result');
          return;
        }
        if (!cancelled) setPushToken(token);

        try {
          await saveUser({
            id:        user.uid,
            pushToken: token,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn('[push] saveUser failed:', err?.message || err);
        }
      } catch (err) {
        console.warn('[push] setup failed:', err?.message || err);
        if (!cancelled) {
          setPermissionGranted(false);
          setPushToken(null);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [user?.uid]);

  return { permissionGranted, pushToken };
}
