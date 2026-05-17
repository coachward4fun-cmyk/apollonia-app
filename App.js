import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Image, Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { AIAssistantProvider } from './src/context/AIAssistantContext';
import { AppDataProvider } from './src/context/AppDataContext';
import AppNavigator from './src/navigation/AppNavigator';
import LoginScreen from './src/screens/LoginScreen';
import FloatingMicButton from './src/components/FloatingMicButton';
import AIAssistantPanel from './src/components/AIAssistantPanel';
import { ensureFirestoreData } from './src/utils/ensureFirestoreData';
import { backfillJobIds } from './src/services/db';
import { ExpiryBanner, ExpiryBlockScreen } from './src/components/ExpiryWarning';
import { colors } from './src/theme/colors';

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
  const [appStatus,  setAppStatus]  = useState('checking');
  const [seedMsg,    setSeedMsg]    = useState('');
  const checkedUid = useRef(null);

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

  // ── Auth state unknown ────────────────────────────────────────────────────
  if (user === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9fafb' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── Not logged in ─────────────────────────────────────────────────────────
  if (!user) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen />
      </>
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
