import React, { useState, useCallback, useLayoutEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import AppTextInput from '../components/AppTextInput';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getCrews, saveCrew, deleteCrew, saveJob } from '../services/db';
import { useAuth } from '../context/AuthContext';
import { useAppData } from '../context/AppDataContext';
import { colors } from '../theme/colors';
import { normalizePhone, formatPhoneDisplay } from '../utils/phoneUtils';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const EMPTY_LEAD = { name: '', mobile: '', email: '', comment: '' };

// New data-model defaults (migration #3/#4). Crew size is the TOTAL headcount
// including the lead; daily rates seed the job's crew-pay fields on assignment.
const DEFAULT_LEAD_RATE   = '300';
const DEFAULT_WORKER_RATE = '250';
const DEFAULT_HELPER_RATE = '150';

export default function CrewFormScreen() {
  const navigation = useNavigation();
  const { crewId } = useRoute().params;
  const { canWrite } = useAuth();
  const { activeJobs } = useAppData();
  const isEdit = !!crewId;

  const [crewName, setCrewName] = useState('');
  const [lead,     setLead]     = useState({ ...EMPTY_LEAD });
  const [crewSize, setCrewSize] = useState('1'); // total incl. lead, min 1
  const [leadRate,   setLeadRate]   = useState(DEFAULT_LEAD_RATE);
  const [workerRate, setWorkerRate] = useState(DEFAULT_WORKER_RATE);
  const [helperRate, setHelperRate] = useState(DEFAULT_HELPER_RATE);
  const [saving,   setSaving]   = useState(false);
  // Preserve the `migrated` flag across edits. saveCrew is a full-document
  // overwrite (setDoc, no merge), so we must carry it forward or editing a crew
  // would drop it.
  const [preserved, setPreserved] = useState({});

  const loadCrew = useCallback(async () => {
    if (!crewId) return;
    try {
      const crews = await getCrews();
      const crew  = crews.find((c) => c.id === crewId);
      if (crew) {
        setCrewName(crew.name || '');
        setLead({
          ...EMPTY_LEAD,
          ...(crew.lead || {}),
          mobile: formatPhoneDisplay(crew.lead?.mobile || ''),
        });
        // crewSize is always set post-migration; default to 1 (lead only) if a
        // doc somehow lacks it.
        const size = crew.crewSize != null ? crew.crewSize : 1;
        setCrewSize(String(Math.max(1, size)));
        setLeadRate(crew.leadDailyRate     != null ? String(crew.leadDailyRate)     : DEFAULT_LEAD_RATE);
        setWorkerRate(crew.workerDailyRate != null ? String(crew.workerDailyRate)   : DEFAULT_WORKER_RATE);
        setHelperRate(crew.helperDailyRate != null ? String(crew.helperDailyRate)   : DEFAULT_HELPER_RATE);
        const carry = {};
        if (crew.migrated !== undefined) carry.migrated = crew.migrated;
        setPreserved(carry);
      }
    } catch { /* ignore */ }
  }, [crewId]);

  useLayoutEffect(() => { loadCrew(); }, [loadCrew]);

  const handleSave = async () => {
    if (!canWrite('crews')) {
      Alert.alert('Access Restricted', 'You don\'t have permission to edit crews.');
      return;
    }
    if (!crewName.trim()) { Alert.alert('Required', 'Please enter a crew name.'); return; }

    const size = Math.max(1, parseInt(crewSize, 10) || 1); // enforce min 1

    setSaving(true);
    try {
      const crewData = {
        id:      isEdit ? crewId : generateId(),
        name:    crewName.trim(),
        lead:    {
          name:    lead.name.trim(),
          mobile:  normalizePhone(lead.mobile) || '',
          email:   (lead.email || '').trim(),
          comment: (lead.comment || '').trim(),
        },
        crewSize:        size,
        leadDailyRate:   parseFloat(leadRate)   || 0,
        workerDailyRate: parseFloat(workerRate) || 0,
        helperDailyRate: parseFloat(helperRate) || 0,
        // Carry forward the `migrated` flag so a full-overwrite save keeps it.
        ...preserved,
      };

      await saveCrew(crewData);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', 'Could not save crew: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!canWrite('crews')) return;
    const closedStatuses = ['invoice paid', 'invoice sent'];
    const activeJobCount = activeJobs.filter(
      (j) => j.crewId === crewId &&
      !closedStatuses.includes((j.status || '').toLowerCase())
    ).length;

    const message = activeJobCount > 0
      ? `${crewName} has ${activeJobCount} active job${activeJobCount === 1 ? '' : 's'} assigned. Deleting this crew will remove their crew assignments. This cannot be undone.`
      : `Delete "${crewName}"? This cannot be undone.`;

    Alert.alert('Delete Crew', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            if (activeJobCount > 0) {
              const affected = activeJobs.filter((j) => j.crewId === crewId);
              await Promise.all(affected.map((j) => saveJob({ ...j, crewId: '' })));
            }
            await deleteCrew(crewId);
            navigation.popTo('CrewsList');
          } catch (err) {
            Alert.alert('Error', err.message || 'Could not delete crew.');
          }
        },
      },
    ]);
  };

  const workerCount = Math.max(0, (parseInt(crewSize, 10) || 1) - 1);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isEdit ? 'Edit Crew' : 'New Crew'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            <Text style={[styles.saveText, saving && { opacity: 0.5 }]}>Save</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <Label text="CREW NAME" />
          <View style={styles.card}>
            <AppTextInput
              style={styles.input}
              placeholder="e.g. Crew 1 – Bob"
              placeholderTextColor={colors.textMuted}
              value={crewName}
              onChangeText={setCrewName}
              returnKeyType="next"
            />
          </View>

          <Label text="LEAD" />
          <View style={styles.card}>
            <Field label="Name"   value={lead.name}    onChangeText={(v) => setLead((l) => ({ ...l, name: v }))}    placeholder="Lead name"  />
            <Divider />
            <Field label="Mobile" value={lead.mobile}  onChangeText={(v) => setLead((l) => ({ ...l, mobile: v }))}  placeholder="Phone number" keyboard="phone-pad" />
          </View>

          <Label text="CREW SIZE" />
          <View style={styles.card}>
            <Field
              label="Total"
              value={crewSize}
              onChangeText={(v) => setCrewSize(v.replace(/[^0-9]/g, ''))}
              placeholder="1"
              keyboard="number-pad"
            />
          </View>
          <Text style={styles.helpText}>
            Total headcount including the lead — {workerCount} worker{workerCount === 1 ? '' : 's'} + 1 lead.
          </Text>

          <Label text="DAILY RATES" />
          <View style={styles.card}>
            <Field label="Lead $/Day"   value={leadRate}   onChangeText={(v) => setLeadRate(v.replace(/[^0-9.]/g, ''))}   placeholder="300" keyboard="decimal-pad" />
            <Divider />
            <Field label="Worker $/Day" value={workerRate} onChangeText={(v) => setWorkerRate(v.replace(/[^0-9.]/g, ''))} placeholder="250" keyboard="decimal-pad" />
            <Divider />
            <Field label="Helper $/Day" value={helperRate} onChangeText={(v) => setHelperRate(v.replace(/[^0-9.]/g, ''))} placeholder="150" keyboard="decimal-pad" />
          </View>

          {isEdit && (
            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={16} color="#dc2626" />
              <Text style={styles.deleteBtnText}>Delete Crew</Text>
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Label({ text }) {
  return <Text style={styles.label}>{text}</Text>;
}
function Divider() {
  return <View style={styles.divider} />;
}
function Field({ label, value, onChangeText, placeholder, keyboard }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <AppTextInput
        style={styles.fieldInput}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboard || 'default'}
        returnKeyType="next"
        autoCapitalize={keyboard === 'email-address' ? 'none' : 'words'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  cancelText: { fontSize: 16, color: colors.textSecondary },
  saveText:   { fontSize: 16, fontWeight: '700', color: colors.primary },

  content: { padding: 16 },

  label: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    letterSpacing: 0.8, marginBottom: 8, marginTop: 8, marginLeft: 4,
  },
  helpText: {
    fontSize: 12, color: colors.textMuted,
    marginTop: 2, marginBottom: 4, marginLeft: 4,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  input: {
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: 14,
  },

  divider: { height: 1, backgroundColor: '#f3f4f6' },

  fieldRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  fieldLabel: { width: 90, fontSize: 13, color: colors.textMuted, fontWeight: '500' },
  fieldInput: { flex: 1, fontSize: 15, color: colors.textPrimary },

  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 14,
    borderWidth: 1, borderColor: '#fecaca',
    borderRadius: 12, justifyContent: 'center',
    backgroundColor: '#fff5f5', marginTop: 8,
  },
  deleteBtnText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },
});
