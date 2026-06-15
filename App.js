import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Image, Alert, AppState, Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { AIAssistantProvider } from './src/context/AIAssistantContext';
import { AppDataProvider, useAppData } from './src/context/AppDataContext';
import AppNavigator from './src/navigation/AppNavigator';
import { signInAnonymously } from 'firebase/auth';
import { auth } from './src/config/firebase';
import FloatingMicButton from './src/components/FloatingMicButton';
import AIAssistantPanel from './src/components/AIAssistantPanel';
import { ensureFirestoreData } from './src/utils/ensureFirestoreData';
import { backfillJobIds, saveJob } from './src/services/db';
import { ExpiryBanner, ExpiryBlockScreen } from './src/components/ExpiryWarning';
import { colors } from './src/theme/colors';
import usePushToken from './src/hooks/usePushToken';
import SelfClaimModal from './src/components/SelfClaimModal';
import UpdateModal from './src/components/UpdateModal';
import { notifyCrewViaWhatsApp } from './src/utils/notifyCrewViaWhatsApp';
import { runBuildUpdateCheck } from './src/services/buildUpdate';

// Foreground notification presentation — show banner + sound, no badge.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Register interactive action buttons for crew-related push notifications.
// Called once at app start; categoryId on each push payload selects the matching set.
async function registerNotificationCategories() {
  await Notifications.setNotificationCategoryAsync('CREW_REMINDER', [
    {
      identifier: 'NOTIFY_WHATSAPP',
      buttonTitle: 'Notify via WhatsApp',
      options: { isDestructive: false, isAuthenticationRequired: false, opensAppToForeground: true },
    },
    {
      identifier: 'DISMISS_LOCAL',
      buttonTitle: 'Dismiss',
      options: { isDestructive: true, isAuthenticationRequired: false, opensAppToForeground: false },
    },
  ]);
  await Notifications.setNotificationCategoryAsync('CREW_NEEDED', [
    {
      identifier: 'DISMISS_LOCAL',
      buttonTitle: 'Dismiss',
      options: { isDestructive: true, isAuthenticationRequired: false, opensAppToForeground: false },
    },
  ]);
}

// ── Loading / seeding screen ───────────────────────────────────────────────────

function SeedingScreen({ message }) {
  return (
    <View style={seedStyles.container}>
      <Image source={require('./assets/Apollonia_new.png')} style={seedStyles.logo} />
      <Text style={seedStyles.title}>Setting up your data…</Text>
      <ActivityIndicator size="large" color="#16a34a" style={{ marginTop: 24 }} />
      {message ? <Text style={seedStyles.statusMsg}>{message}</Text> : null}
      <Text style={seedStyles.sub}>
        Uploading your jobs, crews, and expenses to the cloud.{'\n'}This only happens once.
      </Text>
    </View>
  );
}

const seedStyles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#f9fafb',
    alignItems: 'center', justifyContent: 'center', padding: 36,
  },
  logo:      { width: 220, height: 55, resizeMode: 'contain', marginBottom: 36 },
  title:     { fontSize: 20, fontWeight: '700', color: '#111827', textAlign: 'center' },
  statusMsg: { fontSize: 14, color: '#16a34a', fontWeight: '600', marginTop: 18, textAlign: 'center' },
  sub: {
    fontSize: 13, color: '#6b7280', marginTop: 28,
    textAlign: 'center', lineHeight: 20,
  },
});

// ── Root content ───────────────────────────────────────────────────────────────
//
// App states after user is confirmed signed-in:
//   'checking'  — running ensureFirestoreData fast-path check
//   'seeding'   — writing data to Firestore (shows SeedingScreen)
//   'ready'     — show AppNavigator

function RootContent() {
  const { user } = useAuth();
  const { activeJobs: jobs, crews } = useAppData();
  const [appStatus,  setAppStatus]  = useState('checking');
  const [seedMsg,    setSeedMsg]    = useState('');
  const checkedUid = useRef(null);
  const anonAttempted = useRef(false);

  // Request push permission + write the Expo push token to users/{uid}.
  // The hook short-circuits while `user` is undefined/null.
  usePushToken(user);

  // Register notification action buttons once at mount.
  useEffect(() => {
    registerNotificationCategories().catch((err) =>
      console.warn('[notifications] category setup failed:', err)
    );
  }, []);

  // Handle notification taps and action-button presses.
  //   - Default tap on a crew_reminder push → open the prebuilt wa.me URL
  //     directly. Works in foreground, background, and post-launch (Expo's
  //     response listener fires consistently across these states).
  //   - "Notify via WhatsApp" action button → existing flow: mark the job as
  //     crewNotified and invoke the app's notifyCrewViaWhatsApp helper.
  //   - "Dismiss" action button → no app-side handling needed.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const { actionIdentifier, notification } = response;
      const data = notification.request.content.data || {};

      // App-update push (CHANGE 10): tapping opens the EAS install page.
      if (data.type === 'app_update' && data.installUrl) {
        Linking.openURL(data.installUrl).catch((err) =>
          console.warn('[notifications] open install URL failed:', err.message),
        );
        return;
      }

      if (
        actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER &&
        data.type === 'crew_reminder' &&
        data.whatsappUrl
      ) {
        Linking.openURL(data.whatsappUrl).catch((err) =>
          console.warn('[notifications] open WhatsApp URL failed:', err.message),
        );
        return;
      }

      if (actionIdentifier !== 'NOTIFY_WHATSAPP') return; // DISMISS_LOCAL needs no handling
      const { crewId, jobIds } = data;
      if (!crewId) return;
      const crew = crews.find((c) => c.id === crewId);
      const jobId = Array.isArray(jobIds) ? jobIds[0] : null;
      const job = jobId
        ? jobs.find((j) => j.id === jobId)
        : jobs.find((j) => j.crewId === crewId);
      if (!job || !crew) {
        console.warn('[notifications] could not find job/crew for action', { crewId, jobId });
        return;
      }
      try {
        await saveJob({ id: job.id, crewNotifiedAt: new Date().toISOString() });
      } catch (err) {
        console.warn('[notifications] saveJob failed:', err);
      }
      await notifyCrewViaWhatsApp(job, crew);
    });
    return () => sub.remove();
  }, [jobs, crews]);

  // Clear the app icon badge whenever the app comes to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        Notifications.setBadgeCountAsync(0).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // Silently bootstrap an anonymous Firebase user when no user is signed in.
  // No Login UI — the spinner below covers the brief in-flight window.
  useEffect(() => {
    if (user === null && !anonAttempted.current) {
      anonAttempted.current = true;
      signInAnonymously(auth).catch((err) =>
        console.warn('Anonymous sign-in failed:', err)
      );
    }
  }, [user]);

  useEffect(() => {
    if (user === undefined) return; // auth state still loading

    if (!user) {
      // Signed out — reset so the check reruns on next login
      setAppStatus('checking');
      setSeedMsg('');
      checkedUid.current = null;
      return;
    }

    if (checkedUid.current === user.uid) return; // already ran for this session
    checkedUid.current = user.uid;

    (async () => {
      try {
        const result = await ensureFirestoreData((msg) => {
          if (appStatus !== 'seeding') setAppStatus('seeding');
          setSeedMsg(msg);
        });

        if (result) {
          // Data was just seeded — log the counts
          console.log(
            `[Seed] Complete — jobs: ${result.jobs}, crews: ${result.crews}, expenses: ${result.expenses} (source: ${result.source})`,
          );
        }
      } catch (err) {
        console.warn('[Seed] Error:', err.message);
        // Don't block the user if seeding fails
      }
      try {
        await backfillJobIds();
      } catch (err) {
        console.warn('[JobId] Backfill error:', err.message);
      }
      setAppStatus('ready');
    })();
  }, [user]);

  // Build-update lifecycle (CHANGES 3/4/5/7): once auth resolves to a real user,
  // record this device's installed build, register brand-new builds, and prompt
  // out-of-date installs. Runs once per uid; no-ops in Expo Go.
  const buildCheckedUid = useRef(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  useEffect(() => {
    if (!user?.uid) return;
    if (buildCheckedUid.current === user.uid) return;
    buildCheckedUid.current = user.uid;
    runBuildUpdateCheck(user)
      .then((res) => { if (res?.updateAvailable) setUpdateInfo(res); })
      .catch((err) => console.warn('[buildUpdate] check failed:', err?.message || err));
  }, [user]);

  // ── Auth state unknown ────────────────────────────────────────────────────
  if (user === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── No user yet: anonymous sign-in is in-flight ──────────────────────────
  if (!user) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── Logged in: checking Firestore (fast, ~200ms) ──────────────────────────
  if (appStatus === 'checking') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── Logged in: writing data to Firestore ──────────────────────────────────
  if (appStatus === 'seeding') {
    return <SeedingScreen message={seedMsg} />;
  }

  // ── Ready ─────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="light" />
      {/* ExpiryBlockScreen renders a Modal — no flex impact */}
      <ExpiryBlockScreen />
      {/* Explicit flex:1 wrapper ensures the navigator always fills all remaining space
          and is not compressed by any absolutely-positioned overlay siblings. */}
      <View style={{ flex: 1 }}>
        <AppNavigator />
      </View>
      {/* Overlays — all position:'absolute', zero flex impact */}
      <ExpiryBanner />
      <FloatingMicButton />
      <AIAssistantPanel />
      <SelfClaimModal user={user} />
      <UpdateModal info={updateInfo} onDismiss={() => setUpdateInfo(null)} />
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <AIAssistantProvider>
            <AppDataProvider>
              <RootContent />
            </AppDataProvider>
          </AIAssistantProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
