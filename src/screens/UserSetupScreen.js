import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeUsers, saveUser, deleteUser } from '../services/db';
import { formatPhoneDisplay } from '../utils/phoneUtils';
import { colors } from '../theme/colors';

export default function UserSetupScreen() {
  const navigation = useNavigation();
  const [users, setUsers] = useState(null); // null = loading

  useEffect(() => subscribeUsers(setUsers), []);

  // Hide bootstrap anonymous docs that haven't been named yet.
  const visible = (users || [])
    .filter((u) => (u.name || '').trim())
    .sort((a, b) => a.name.localeCompare(b.name));

  const handleAdd  = () => navigation.navigate('EditUser', { userId: null });
  const handleEdit = (u) => navigation.navigate('EditUser', { userId: u.id });

  const handleToggleNotifications = async (u, value) => {
    try {
      await saveUser({ id: u.id, notificationsEnabled: value, updatedAt: new Date().toISOString() });
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not update.');
    }
  };

  const handleDelete = (u) => {
    Alert.alert(
      'Delete User',
      `Delete "${u.name}"? This removes their profile from the User Setup list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try { await deleteUser(u.id); }
            catch (err) { Alert.alert('Error', err.message); }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Admin</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>User Setup</Text>
        <TouchableOpacity onPress={handleAdd} style={styles.addBtn}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.hint}>
          Manage the office team. Each person controls their own Job Reminders toggle.
        </Text>

        {users === null ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : visible.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No users yet</Text>
            <Text style={styles.emptySub}>Tap + to add your first user.</Text>
          </View>
        ) : (
          visible.map((u) => (
            <View key={u.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{u.name}</Text>
                <Text style={styles.rowSub}>{formatPhoneDisplay(u.mobile) || 'No mobile'}</Text>
              </View>
              <Switch
                value={u.notificationsEnabled !== false}
                onValueChange={(v) => handleToggleNotifications(u, v)}
                trackColor={{ false: '#d1d5db', true: '#86efac' }}
                thumbColor={u.notificationsEnabled !== false ? colors.primary : '#9ca3af'}
                ios_backgroundColor="#d1d5db"
              />
              <View style={styles.iconSeparator} />
              <TouchableOpacity onPress={() => handleEdit(u)} style={styles.editBtn}>
                <Ionicons name="pencil-outline" size={20} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDelete(u)} style={styles.deleteBtn}>
                <Ionicons name="trash-outline" size={20} color="#dc2626" />
              </TouchableOpacity>
            </View>
          ))
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
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
  addBtn: {
    backgroundColor: colors.primary, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  content: { padding: 16 },
  hint: { fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 19 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  rowName: { fontSize: 15, fontWeight: '700', color: '#111827' },
  rowSub:  { fontSize: 12, color: '#6b7280', marginTop: 2 },
  iconSeparator: { width: 1, height: 22, backgroundColor: '#e5e7eb', marginHorizontal: 8 },
  editBtn:   { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  emptySub:   { fontSize: 13, color: '#6b7280' },
});
