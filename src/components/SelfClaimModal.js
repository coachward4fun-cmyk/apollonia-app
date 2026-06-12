import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onSnapshot, doc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { subscribeUsers, saveUser, deleteUser, getBuildInfo } from '../services/db';
import { formatPhoneDisplay } from '../utils/phoneUtils';
import { colors } from '../theme/colors';

export default function SelfClaimModal({ user }) {
  const uid = user?.uid || null;
  const [selfDoc,  setSelfDoc]  = useState(undefined); // undefined = loading, null = no doc, object = doc
  const [allUsers, setAllUsers] = useState(null);      // null = loading
  const [busy,     setBusy]     = useState(false);

  // Live: this device's own users/{uid} doc
  useEffect(() => {
    if (!uid) { setSelfDoc(null); return; }
    const unsub = onSnapshot(
      doc(db, 'users', uid),
      (snap) => setSelfDoc(snap.exists() ? snap.data() : null),
      () => setSelfDoc(null),
    );
    return unsub;
  }, [uid]);

  // Live: full users collection so we can filter pending manual_* entries
  useEffect(() => subscribeUsers(setAllUsers), []);

  if (!uid) return null;
  if (selfDoc === undefined || allUsers === null) return null; // still loading; don't flash modal

  const alreadyNamed   = !!(selfDoc?.name || '').trim();
  const alreadySkipped = selfDoc?.skippedClaim === true;
  const pending = (allUsers || []).filter((u) =>
    u.id.startsWith('manual_') && (u.name || '').trim()
  );

  const visible = !alreadyNamed && !alreadySkipped && pending.length > 0;
  if (!visible) return null;

  const handleClaim = async (entry) => {
    if (busy) return;
    setBusy(true);
    try {
      // Stamp this install's build info onto the freshly-claimed (named) doc so it
      // reflects the running build immediately. Without this, a fresh install /
      // new anonymous UID claims the name on a doc with no/stale build fields, and
      // the Admin "USER BUILD VERSIONS" list shows "Needs Update" forever (the
      // build info written by buildUpdate.js lands on the old, now-unnamed UID doc).
      // sanitize() in saveUser strips any undefined values, so a missing field is a no-op.
      let buildFields = {};
      try {
        const info = await getBuildInfo();
        buildFields = {
          currentBuildId:     info?.buildId || undefined,
          currentBuildNumber: parseInt(Constants.expoConfig?.ios?.buildNumber ?? '0', 10) || undefined,
          currentVersion:     Constants.expoConfig?.version || undefined,
        };
      } catch (e) {
        console.warn('[SelfClaim] build info fetch failed:', e?.message || e);
      }
      await saveUser({
        id:                   uid,
        name:                 entry.name,
        mobile:               entry.mobile || '',
        notificationsEnabled: entry.notificationsEnabled !== false,
        claimedAt:            new Date().toISOString(),
        updatedAt:            new Date().toISOString(),
        ...buildFields,
      });
      // Remember which doc UID this device claimed as its named identity. After a
      // delete + reinstall the auth UID changes, but buildUpdate.js reads this to
      // keep writing build info onto the correct named doc instead of a fresh,
      // unnamed shell. (Re-claiming after a reinstall overwrites it with the new UID.)
      await AsyncStorage.setItem('namedUserDocId', uid).catch((e) =>
        console.warn('[SelfClaim] persist namedUserDocId failed:', e?.message || e));
      await deleteUser(entry.id);
      // Modal auto-dismisses on next snapshot (selfDoc.name now set).
    } catch (err) {
      Alert.alert('Could not link', err?.message || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await saveUser({
        id:            uid,
        skippedClaim:  true,
        updatedAt:     new Date().toISOString(),
      });
    } catch (err) {
      Alert.alert('Could not skip', err?.message || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={handleSkip}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Which team member are you?</Text>
          <Text style={styles.subtitle}>Tap your name so reminders reach this phone.</Text>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingVertical: 4 }} showsVerticalScrollIndicator={false}>
            {pending.map((entry) => (
              <TouchableOpacity
                key={entry.id}
                style={styles.row}
                onPress={() => handleClaim(entry)}
                disabled={busy}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{entry.name}</Text>
                  <Text style={styles.rowSub}>{formatPhoneDisplay(entry.mobile) || 'No mobile'}</Text>
                </View>
                {busy
                  ? <ActivityIndicator color={colors.primary} size="small" />
                  : <Text style={styles.rowArrow}>›</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>

          <TouchableOpacity onPress={handleSkip} disabled={busy} style={styles.skipBtn}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 20,
    paddingHorizontal: 18,
    paddingBottom: 28,
    maxHeight: '78%',
  },
  title:    { fontSize: 19, fontWeight: '800', color: '#111827', textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#6b7280', textAlign: 'center', marginTop: 6, marginBottom: 16 },

  list: { maxHeight: 420 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  rowName:  { fontSize: 16, fontWeight: '700', color: '#111827' },
  rowSub:   { fontSize: 12, color: '#6b7280', marginTop: 2 },
  rowArrow: { fontSize: 22, color: colors.textMuted, marginLeft: 8 },

  skipBtn:  { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  skipText: { fontSize: 14, color: colors.textMuted, fontWeight: '500' },
});
