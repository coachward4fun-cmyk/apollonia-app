import React, { useState, useCallback, useLayoutEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, SafeAreaView,
  ScrollView, TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getCrews, saveCrew, deleteCrew } from '../services/db';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/colors';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const EMPTY_LEAD   = { name: '', mobile: '', email: '', comment: '' };
const EMPTY_MEMBER = { name: '', mobile: '', comment: '' };

export default function CrewFormScreen() {
  const navigation = useNavigation();
  const { crewId } = useRoute().params;
  const { canWrite } = useAuth();
  const isEdit = !!crewId;

  const [crewName, setCrewName] = useState('');
  const [lead,     setLead]     = useState({ ...EMPTY_LEAD });
  const [members,  setMembers]  = useState([{ ...EMPTY_MEMBER }]);
  const [saving,   setSaving]   = useState(false);

  const loadCrew = useCallback(async () => {
    if (!crewId) return;
    try {
      const crews = await getCrews();
      const crew  = crews.find((c) => c.id === crewId);
      if (crew) {
        setCrewName(crew.name || '');
        setLead({ ...EMPTY_LEAD, ...(crew.lead || {}) });
        setMembers((crew.members || []).length > 0
          ? crew.members.map((m) => ({ ...EMPTY_MEMBER, ...m }))
          : [{ ...EMPTY_MEMBER }]);
      }
    } catch { /* ignore */ }
  }, [crewId]);

  useLayoutEffect(() => { loadCrew(); }, [loadCrew]);

  const updateMember = (index, field, value) => {
    setMembers((prev) => prev.map((m, i) => i === index ? { ...m, [field]: value } : m));
  };
  const addMember    = () => setMembers((prev) => [...prev, { ...EMPTY_MEMBER }]);
  const removeMember = (index) => {
    if (members.length === 1) { setMembers([{ ...EMPTY_MEMBER }]); return; }
    setMembers((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!canWrite('crews')) {
      Alert.alert('Access Restricted', 'You don\'t have permission to edit crews.');
      return;
    }
    if (!crewName.trim()) { Alert.alert('Required', 'Please enter a crew name.'); return; }

    setSaving(true);
    try {
      const cleanMembers = members.filter((m) => m.name.trim());

      const crewData = {
        id:      isEdit ? crewId : generateId(),
        name:    crewName.trim(),
        lead:    {
          name:    lead.name.trim(),
          mobile:  lead.mobile.trim(),
          email:   lead.email.trim(),
          comment: lead.comment.trim(),
        },
        members: cleanMembers.map((m) => ({
          name:    m.name.trim(),
          mobile:  m.mobile.trim(),
          comment: m.comment.trim(),
        })),
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
    if (!canWrite('crews')) {
      Alert.alert('Access Restricted', 'You don\'t have permission to delete crews.');
      return;
    }
    Alert.alert(
      'Delete Crew',
      `Remove "${crewName}"? This won't affect jobs already assigned to this crew.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            await deleteCrew(crewId);
            navigation.popTo('CrewsList');
          },
        },
      ]
    );
  };

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
            <TextInput
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
            <Divider />
            <Field label="Email"  value={lead.email}   onChangeText={(v) => setLead((l) => ({ ...l, email: v }))}   placeholder="Email address" keyboard="email-address" />
            <Divider />
            <Field label="Note"   value={lead.comment} onChangeText={(v) => setLead((l) => ({ ...l, comment: v }))} placeholder="Optional note" />
          </View>

          <Label text="MEMBERS" />
          <View style={styles.card}>
            {members.map((m, i) => (
              <View key={i}>
                {i > 0 && <Divider />}
                <View style={styles.memberRow}>
                  <View style={{ flex: 1 }}>
                    <TextInput
                      style={styles.memberInput}
                      placeholder={`Member ${i + 1} name`}
                      placeholderTextColor={colors.textMuted}
                      value={m.name}
                      onChangeText={(v) => updateMember(i, 'name', v)}
                      returnKeyType="next"
                    />
                    {m.name.trim().length > 0 && (
                      <TextInput
                        style={[styles.memberInput, styles.memberInputSub]}
                        placeholder="Mobile (optional)"
                        placeholderTextColor={colors.textMuted}
                        value={m.mobile}
                        onChangeText={(v) => updateMember(i, 'mobile', v)}
                        keyboardType="phone-pad"
                        returnKeyType="next"
                      />
                    )}
                  </View>
                  <TouchableOpacity onPress={() => removeMember(i)} style={styles.removeBtn}>
                    <Ionicons name="remove-circle" size={22} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>

          <TouchableOpacity style={styles.addMemberBtn} onPress={addMember}>
            <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.addMemberText}>Add Member</Text>
          </TouchableOpacity>

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
      <TextInput
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
  fieldLabel: { width: 58, fontSize: 13, color: colors.textMuted, fontWeight: '500' },
  fieldInput: { flex: 1, fontSize: 15, color: colors.textPrimary },

  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  memberInput: { fontSize: 15, color: colors.textPrimary, paddingVertical: 2 },
  memberInputSub: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
  removeBtn: { padding: 4, marginLeft: 8 },

  addMemberBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 4, marginBottom: 16,
  },
  addMemberText: { fontSize: 15, color: colors.primary, fontWeight: '600' },

  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 14,
    borderWidth: 1, borderColor: '#fecaca',
    borderRadius: 12, justifyContent: 'center',
    backgroundColor: '#fff5f5', marginTop: 8,
  },
  deleteBtnText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },
});
