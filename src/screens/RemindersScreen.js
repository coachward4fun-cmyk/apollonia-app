import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, SafeAreaView, ScrollView,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import AppTextInput from '../components/AppTextInput';
import DatePickerField from '../components/DatePickerField';
import useReminders, { localTodayStr, isReminderPastDue } from '../hooks/useReminders';
import { saveReminder, deleteReminder, toggleReminderDone, deleteReminders } from '../services/db';

function formatDue(str) {
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCreated(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function sortOldestFirst(list) {
  return [...list].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// Confirm, then delete. onDeleted runs only after a successful delete.
function confirmDelete(reminder, onDeleted) {
  Alert.alert('Delete Reminder', `Delete "${reminder.text}"?`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: async () => {
        try { await deleteReminder(reminder.id); onDeleted?.(); }
        catch (err) { Alert.alert('Error', err.message); }
      },
    },
  ]);
}

export default function RemindersScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const { reminders, userId } = useReminders();
  const [filter,   setFilter]   = useState(route.params?.filter === 'pastDue' ? 'pastDue' : 'all');
  const [selected, setSelected] = useState(null); // reminder id shown in the detail modal
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (route.params?.filter) setFilter(route.params.filter === 'pastDue' ? 'pastDue' : 'all');
  }, [route.params?.filter]);

  const todayStr  = localTodayStr();
  const open      = useMemo(() => sortOldestFirst(reminders.filter((r) => !r.done)), [reminders]);
  const completed = useMemo(() => sortOldestFirst(reminders.filter((r) => r.done)), [reminders]);
  const pastDue   = useMemo(() => open.filter((r) => isReminderPastDue(r, todayStr)), [open, todayStr]);

  // Look the selected reminder up live so the detail view reflects edits/toggles.
  const selectedReminder = selected ? reminders.find((r) => r.id === selected) || null : null;

  const handleClearCompleted = () => {
    Alert.alert(
      'Clear Completed',
      `Delete ${completed.length} completed reminder${completed.length === 1 ? '' : 's'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteReminders(completed.map((r) => r.id)).catch((err) => Alert.alert('Error', err.message)),
        },
      ],
    );
  };

  const shown = filter === 'pastDue' ? pastDue : open;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topNav}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Dashboard</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>Reminders</Text>
        <TouchableOpacity onPress={() => setCreating(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="add" size={26} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.segment}>
        <SegmentButton label={`All (${open.length})`} active={filter === 'all'} onPress={() => setFilter('all')} />
        <SegmentButton
          label={`Past Due (${pastDue.length})`}
          active={filter === 'pastDue'}
          danger={pastDue.length > 0}
          onPress={() => setFilter('pastDue')}
        />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          {shown.length === 0 ? (
            <Text style={styles.empty}>
              {filter === 'pastDue' ? 'Nothing past due' : 'No open reminders'}
            </Text>
          ) : shown.map((r, i) => (
            <View key={r.id}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <ReminderRow reminder={r} todayStr={todayStr} onPress={() => setSelected(r.id)} />
            </View>
          ))}
        </View>

        {filter === 'all' && completed.length > 0 ? (
          <>
            <View style={styles.groupRow}>
              <Text style={styles.groupLabel}>Completed ({completed.length})</Text>
              <TouchableOpacity onPress={handleClearCompleted} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.clearBtn}>Clear Completed</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.card}>
              {completed.map((r, i) => (
                <View key={r.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <ReminderRow reminder={r} todayStr={todayStr} onPress={() => setSelected(r.id)} />
                </View>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>

      <ReminderDetailModal
        reminder={selectedReminder}
        todayStr={todayStr}
        onClose={() => setSelected(null)}
      />
      <ReminderFormModal
        visible={creating}
        reminder={null}
        userId={userId}
        onClose={() => setCreating(false)}
      />
    </SafeAreaView>
  );
}

function SegmentButton({ label, active, danger, onPress }) {
  return (
    <TouchableOpacity style={[styles.segmentBtn, active && styles.segmentBtnActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[
        styles.segmentText,
        danger && styles.segmentTextDanger,
        active && styles.segmentTextActive,
      ]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function DuePill({ dueDate, overdue }) {
  return (
    <View style={[styles.pill, overdue ? styles.pillOverdue : styles.pillFuture]}>
      <Text style={[styles.pillText, overdue ? styles.pillTextOverdue : styles.pillTextFuture]}>
        {formatDue(dueDate)}
      </Text>
    </View>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ReminderRow({ reminder, todayStr, onPress }) {
  const swipeRef = useRef(null);
  const overdue  = isReminderPastDue(reminder, todayStr);

  const renderRightActions = () => (
    <TouchableOpacity
      style={styles.deleteAction}
      onPress={() => {
        swipeRef.current?.close();
        confirmDelete(reminder);
      }}
    >
      <Ionicons name="trash-outline" size={18} color="#fff" />
      <Text style={styles.deleteActionText}>Delete</Text>
    </TouchableOpacity>
  );

  return (
    <Swipeable ref={swipeRef} renderRightActions={renderRightActions} friction={2} rightThreshold={40}>
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <TouchableOpacity
          onPress={() => toggleReminderDone(reminder.id, !reminder.done)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons
            name={reminder.done ? 'checkbox' : 'square-outline'}
            size={22}
            color={reminder.done ? colors.primary : colors.textMuted}
          />
        </TouchableOpacity>
        <Text style={[styles.rowText, reminder.done && styles.rowTextDone]} numberOfLines={2}>
          {reminder.text}
        </Text>
        {reminder.dueDate && !reminder.done ? (
          <DuePill dueDate={reminder.dueDate} overdue={overdue} />
        ) : null}
      </TouchableOpacity>
    </Swipeable>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────

function ReminderDetailModal({ reminder, todayStr, onClose }) {
  const [editing, setEditing] = useState(false);

  useEffect(() => { if (!reminder) setEditing(false); }, [reminder]);

  const overdue = reminder ? isReminderPastDue(reminder, todayStr) : false;

  return (
    <Modal visible={!!reminder} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {reminder && editing ? (
        <ReminderForm reminder={reminder} onClose={() => setEditing(false)} />
      ) : reminder ? (
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Reminder</Text>
            <View style={{ width: 22 }} />
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Text style={[styles.detailText, reminder.done && styles.rowTextDone]}>{reminder.text}</Text>

            <View style={styles.detailCard}>
              <DetailRow label="Status" value={reminder.done ? 'Completed' : 'Open'} />
              <View style={styles.divider} />
              <DetailRow label="Created" value={formatCreated(reminder.createdAt)} />
              <View style={styles.divider} />
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Due</Text>
                {reminder.dueDate ? (
                  <DuePill dueDate={reminder.dueDate} overdue={overdue} />
                ) : (
                  <Text style={styles.detailValue}>No due date</Text>
                )}
              </View>
            </View>

            <View style={styles.detailActions}>
              <TouchableOpacity style={styles.editBtn} onPress={() => setEditing(true)} activeOpacity={0.8}>
                <Ionicons name="pencil-outline" size={16} color="#fff" />
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalDeleteBtn}
                onPress={() => confirmDelete(reminder, onClose)}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={16} color={colors.danger} />
                <Text style={styles.modalDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </SafeAreaView>
      ) : null}
    </Modal>
  );
}

function DetailRow({ label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

// ── Add / Edit ────────────────────────────────────────────────────────────────

function ReminderFormModal({ visible, reminder, userId, onClose }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {visible ? <ReminderForm reminder={reminder} userId={userId} onClose={onClose} /> : null}
    </Modal>
  );
}

function ReminderForm({ reminder, userId, onClose }) {
  const isEdit = !!reminder?.id;
  const [text,    setText]    = useState(reminder?.text || '');
  const [dueDate, setDueDate] = useState(reminder?.dueDate || '');
  const [saving,  setSaving]  = useState(false);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await saveReminder(isEdit
        ? { id: reminder.id, text: trimmed, dueDate: dueDate || null }
        : { userId, text: trimmed, dueDate: dueDate || null, done: false });
      onClose();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const canSave = !saving && !!text.trim();

  return (
    <SafeAreaView style={styles.modalContainer}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.modalCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.modalTitle}>{isEdit ? 'Edit Reminder' : 'New Reminder'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={!canSave}>
            <Text style={[styles.modalSave, !canSave && { opacity: 0.4 }]}>Save</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.modalBody}>
          <Text style={styles.fieldLabel}>Reminder</Text>
          <AppTextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="What do you need to remember?"
            placeholderTextColor={colors.textMuted}
            multiline
            autoFocus
          />
          <DatePickerField
            label="Due Date (optional)"
            value={dueDate}
            onChange={setDueDate}
            placeholder="No due date"
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  topNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 100 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  navTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },

  segment: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#e5e7eb',
    borderRadius: 10,
    padding: 3,
  },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  segmentTextDanger: { color: colors.danger },
  segmentTextActive: { color: colors.textPrimary },

  content: { paddingHorizontal: 16, paddingBottom: 32 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginHorizontal: 14 },
  empty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 16 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  rowText: { flex: 1, fontSize: 15, color: colors.textPrimary },
  rowTextDone: { color: colors.textMuted, textDecorationLine: 'line-through' },

  pill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  pillFuture: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  pillOverdue: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  pillText: { fontSize: 11, fontWeight: '700' },
  pillTextFuture: { color: colors.primaryDark },
  pillTextOverdue: { color: colors.danger },

  deleteAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'center',
    width: 76,
  },
  deleteActionText: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: 2 },

  groupRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 8 },
  groupLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  clearBtn: { fontSize: 13, fontWeight: '600', color: colors.danger },

  modalContainer: { flex: 1, backgroundColor: '#f9fafb' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  modalCancel: { fontSize: 16, color: colors.textSecondary },
  modalSave: { fontSize: 16, fontWeight: '700', color: colors.primary },
  modalBody: { padding: 16 },

  detailText: { fontSize: 18, color: colors.textPrimary, lineHeight: 26, marginBottom: 20 },
  detailCard: { backgroundColor: '#fff', borderRadius: 14, paddingVertical: 2 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  detailLabel: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  detailValue: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  detailActions: { flexDirection: 'row', gap: 10, marginTop: 24 },
  editBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  editBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  modalDeleteBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  modalDeleteText: { fontSize: 14, fontWeight: '600', color: colors.danger },

  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
});
