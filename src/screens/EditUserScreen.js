import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Switch, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import AppTextInput from '../components/AppTextInput';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { onSnapshot, doc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { saveUser, deleteUser } from '../services/db';
import { normalizePhone, formatPhoneDisplay } from '../utils/phoneUtils';
import { colors } from '../theme/colors';

function generateId() {
  return 'manual_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function EditUserScreen() {
  const navigation = useNavigation();
  const { userId } = useRoute().params || {};
  const isNew = !userId;

  const [name,    setName]    = useState('');
  const [mobile,  setMobile]  = useState('');
  const [notif,   setNotif]   = useState(true);
  const [status,  setStatus]  = useState('pending'); // preserved on edit
  const [loading, setLoading] = useState(!isNew);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    if (isNew) return;
    const unsub = onSnapshot(doc(db, 'users', userId), (snap) => {
      if (snap.exists()) {
        const u = snap.data();
        setName(u.name || '');
        setMobile(formatPhoneDisplay(u.mobile || ''));
        setNotif(u.notificationsEnabled !== false);
        setStatus(u.status || 'active');
      }
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [userId, isNew]);

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert('Required', 'Enter a name.'); return; }
    const normalized = normalizePhone(mobile);
    if (mobile.trim() && !normalized) {
      Alert.alert('Invalid mobile', 'Enter a valid 10-digit mobile number.');
      return;
    }
    setSaving(true);
    try {
      const nowIso = new Date().toISOString();
      const payload = {
        id:                   userId || generateId(),
        name:                 name.trim(),
        mobile:               normalized || '',
        notificationsEnabled: notif,
        status,
        updatedAt:            nowIso,
      };
      if (isNew) payload.createdAt = nowIso;
      await saveUser(payload);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete User',
      `Delete "${name || 'this user'}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try { await deleteUser(userId); navigation.goBack(); }
            catch (err) { Alert.alert('Error', err.message); }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.primary} />
            <Text style={styles.backText}>User Setup</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isNew ? 'Add User' : 'Edit User'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.saveBtn}>
            {saving
              ? <ActivityIndicator color={colors.primary} size="small" />
              : <Text style={styles.saveText}>Save</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.fieldLabel}>NAME</Text>
          <AppTextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Full name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            returnKeyType="next"
          />

          <Text style={styles.fieldLabel}>MOBILE</Text>
          <AppTextInput
            style={styles.input}
            value={mobile}
            onChangeText={setMobile}
            placeholder="555-123-4567"
            placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad"
            returnKeyType="done"
          />

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Job Reminders</Text>
              <Text style={styles.toggleSub}>
                {notif ? 'Will receive day-before reminders' : 'Reminders are paused'}
              </Text>
            </View>
            <Switch
              value={notif}
              onValueChange={setNotif}
              trackColor={{ false: '#d1d5db', true: '#86efac' }}
              thumbColor={notif ? colors.primary : '#9ca3af'}
              ios_backgroundColor="#d1d5db"
            />
          </View>

          {!isNew && (
            <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={18} color="#dc2626" />
              <Text style={styles.deleteText}>Delete User</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#111827', textAlign: 'center' },
  saveBtn: { paddingHorizontal: 10, paddingVertical: 6, minWidth: 50, alignItems: 'flex-end' },
  saveText: { fontSize: 16, fontWeight: '700', color: colors.primary },

  content: { padding: 16 },
  fieldLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 14, marginBottom: 6,
  },
  input: {
    backgroundColor: '#fff', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: '#111827',
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 14, marginTop: 22,
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  toggleLabel: { fontSize: 15, fontWeight: '600', color: '#111827' },
  toggleSub:   { fontSize: 12, color: '#6b7280', marginTop: 2 },

  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 40, paddingVertical: 14,
  },
  deleteText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },
});
