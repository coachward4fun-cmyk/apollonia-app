import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeJobTypes, deleteJobType, saveJobType } from '../services/db';
import { useAIAssistant } from '../context/AIAssistantContext';
import { colors } from '../theme/colors';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const DEFAULT_SEED_TYPES = [
  {
    name: 'Roofing',
    lineItems: [
      { description: 'Install new shingles (Squares)', qty: 0, unitPrice: 80 },
      { description: 'Remove all shingles down to deck', qty: 1, unitPrice: 0 },
      { description: 'Remove extra layer of shingles', qty: 0, unitPrice: 15 },
      { description: 'Replace plywood (Sheets)', qty: 0, unitPrice: 15 },
      { description: 'Dump Fee Total Cost', qty: 1, unitPrice: 469 },
      { description: 'Destination Fee', qty: 1, unitPrice: 0 },
      { description: 'Clean up and haul away all debris', qty: 1, unitPrice: 0 },
      { description: 'Install drip edge (ft)', qty: 0, unitPrice: 2 },
      { description: 'Install ice & water shield (Squares)', qty: 0, unitPrice: 75 },
      { description: 'Install felt underlayment (Rolls)', qty: 0, unitPrice: 45 },
      { description: 'Install ridge cap', qty: 1, unitPrice: 0 },
      { description: 'Install step flashing', qty: 0, unitPrice: 0 },
      { description: 'Permit Fee', qty: 0, unitPrice: 0 },
    ],
  },
  { name: 'Gutters',   lineItems: [] },
  { name: 'Siding',    lineItems: [] },
  { name: 'Concrete',  lineItems: [] },
  { name: 'Painting',  lineItems: [] },
];

export default function JobTypesScreen() {
  const navigation = useNavigation();
  const { voiceEnabled, toggleVoice } = useAIAssistant();
  const [types,   setTypes]   = useState(null); // null = loading
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    return subscribeJobTypes((data) => setTypes(data));
  }, []);

  // Seed defaults on first load if config is empty
  useEffect(() => {
    if (types === null || types.length > 0 || seeding) return;
    (async () => {
      setSeeding(true);
      try {
        for (const t of DEFAULT_SEED_TYPES) {
          await saveJobType({ id: generateId(), ...t });
        }
      } catch { /* ignore */ }
      setSeeding(false);
    })();
  }, [types]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = () => {
    navigation.navigate('EditJobType', { jobTypeId: null });
  };

  const handleEdit = (jobType) => {
    navigation.navigate('EditJobType', { jobTypeId: jobType.id });
  };

  const handleDelete = (jobType) => {
    Alert.alert(
      'Delete Job Type',
      `Delete "${jobType.name}"? Existing jobs keep their job type value.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await deleteJobType(jobType.id);
            } catch (err) {
              Alert.alert('Error', err.message);
            }
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
        <Text style={styles.headerTitle}>Job Types</Text>
        <TouchableOpacity onPress={handleAdd} style={styles.addBtn}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* AI Assist settings */}
        <View style={styles.aiCard}>
          <View style={styles.aiCardHeader}>
            <Ionicons name="sparkles" size={15} color={colors.primary} />
            <Text style={styles.aiCardTitle}>AI Assist</Text>
          </View>
          <View style={styles.aiRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.aiRowLabel}>Voice Responses</Text>
              <Text style={styles.aiRowSub}>
                {voiceEnabled ? 'AI speaks responses aloud' : 'Text only — no audio playback'}
              </Text>
            </View>
            <Switch
              value={voiceEnabled}
              onValueChange={toggleVoice}
              trackColor={{ false: '#d1d5db', true: '#86efac' }}
              thumbColor={voiceEnabled ? colors.primary : '#9ca3af'}
              ios_backgroundColor="#d1d5db"
            />
          </View>
        </View>

        <Text style={styles.hint}>
          Configure default line items for each job type. Used when creating a new invoice.
        </Text>

        {types === null || seeding ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : types.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="list-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No job types</Text>
            <Text style={styles.emptySub}>Tap + to add your first job type.</Text>
          </View>
        ) : (
          types.map((jt) => (
            <View key={jt.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{jt.name}</Text>
                <Text style={styles.rowSub}>
                  {(jt.lineItems || []).length} line item{(jt.lineItems || []).length !== 1 ? 's' : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => handleEdit(jt)} style={styles.editBtn}>
                <Ionicons name="pencil-outline" size={20} color={colors.primary} />
              </TouchableOpacity>
              <View style={styles.iconSeparator} />
              <TouchableOpacity onPress={() => handleDelete(jt)} style={styles.deleteBtn}>
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#111827', textAlign: 'center' },
  addBtn: {
    backgroundColor: colors.primary,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },

  content: { padding: 16 },

  aiCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  aiCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  aiCardTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, letterSpacing: 0.3 },
  aiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiRowLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  aiRowSub:   { fontSize: 12, color: colors.textSecondary },

  hint: { fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 19 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  rowName: { fontSize: 15, fontWeight: '700', color: '#111827' },
  rowSub:  { fontSize: 12, color: '#6b7280', marginTop: 2 },
  iconSeparator: { width: 1, height: 22, backgroundColor: '#e5e7eb', marginHorizontal: 10 },
  editBtn:   { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  emptySub: { fontSize: 13, color: '#6b7280' },
});
