import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, SafeAreaView, ScrollView,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAuth } from '../context/AuthContext';
import AppTextInput from './AppTextInput';
import DatePickerField from './DatePickerField';
import {
  subscribeReminders, saveReminder, deleteReminder, toggleReminderDone, deleteReminders,
} from '../services/db';

const DASHBOARD_LIMIT = 10;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDue(str) {
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function confirmDelete(reminder) {
  Alert.alert('Delete Reminder', `Delete "${reminder.text}"?`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: () => deleteReminder(reminder.id).catch((err) => Alert.alert('Error', err.message)),
    },
  ]);
}

// ── Dashboard section ─────────────────────────────────────────────────────────

export default function RemindersSection() {
  const { user } = useAuth();
  const uid = user?.uid;
  const [reminders, setReminders] = useState([]);
  const [editing,   setEditing]   = useState(null); // null = closed, {} = new, reminder = edit
  const [showAll,   setShowAll]   = useState(false);

  useEffect(() => subscribeReminders(uid, setReminders), [uid]);

  const open = useMemo(() => reminders.filter((r) => !r.done), [reminders]);
  const visible = open.slice(0, DASHBOARD_LIMIT);

  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Reminders</Text>
        {reminders.length > 0 ? (
          <TouchableOpacity onPress={() => setShowAll(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.seeAll}>
              {open.length > DASHBOARD_LIMIT ? `See all (${open.length})` : 'See all'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.card}>
        {visible.length === 0 ? (
          <Text style={styles.empty}>No open reminders</Text>
        ) : (
          visible.map((r, i) => (
            <View key={r.id}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <ReminderRow reminder={r} onEdit={setEditing} />
            </View>
          ))
        )}
        <View style={styles.divider} />
        <TouchableOpacity style={styles.addBtn} onPress={() => setEditing({})} activeOpacity={0.7}>
          <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
          <Text style={styles.addBtnText}>Add Reminder</Text>
        </TouchableOpacity>
      </View>

      <ReminderEditModal
        reminder={showAll ? null : editing}
        userId={uid}
        onClose={() => setEditing(null)}
      />
      <AllRemindersModal
        visible={showAll}
        reminders={reminders}
        userId={uid}
        onClose={() => setShowAll(false)}
      />
    </View>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ReminderRow({ reminder, onEdit }) {
  const swipeRef = useRef(null);
  const overdue  = !reminder.done && reminder.dueDate && reminder.dueDate < todayStr();

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
      <TouchableOpacity
        style={styles.row}
        onPress={() => onEdit(reminder)}
        onLongPress={() => confirmDelete(reminder)}
        activeOpacity={0.7}
      >
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
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, reminder.done && styles.rowTextDone]} numberOfLines={2}>
            {reminder.text}
          </Text>
          {reminder.dueDate ? (
            <Text style={[styles.rowDue, overdue && styles.rowDueOverdue]}>
              {overdue ? 'Overdue · ' : 'Due '}{formatDue(reminder.dueDate)}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

function ReminderEditModal({ reminder, userId, onClose }) {
  const isEdit = !!reminder?.id;
  const [text,    setText]    = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    if (reminder) {
      setText(reminder.text || '');
      setDueDate(reminder.dueDate || '');
    }
  }, [reminder]);

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

  return (
    <Modal visible={!!reminder} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalContainer}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{isEdit ? 'Edit Reminder' : 'New Reminder'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={saving || !text.trim()}>
              <Text style={[styles.modalSave, (saving || !text.trim()) && { opacity: 0.4 }]}>Save</Text>
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
            {isEdit ? (
              <TouchableOpacity
                style={styles.modalDeleteBtn}
                onPress={() => {
                  Alert.alert('Delete Reminder', `Delete "${reminder.text}"?`, [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try { await deleteReminder(reminder.id); onClose(); }
                        catch (err) { Alert.alert('Error', err.message); }
                      },
                    },
                  ]);
                }}
              >
                <Ionicons name="trash-outline" size={16} color={colors.danger} />
                <Text style={styles.modalDeleteText}>Delete Reminder</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Full list modal ───────────────────────────────────────────────────────────

function AllRemindersModal({ visible, reminders, userId, onClose }) {
  const [editing, setEditing] = useState(null);
  const open      = reminders.filter((r) => !r.done);
  const completed = reminders.filter((r) => r.done);

  const handleClearCompleted = () => {
    if (completed.length === 0) return;
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

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* Modals render outside the app's root gesture view — Swipeable needs its own. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Reminders</Text>
            <TouchableOpacity onPress={() => setEditing({})} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="add" size={24} color={colors.primary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <Text style={styles.groupLabel}>Open ({open.length})</Text>
            <View style={styles.card}>
              {open.length === 0 ? (
                <Text style={styles.empty}>No open reminders</Text>
              ) : open.map((r, i) => (
                <View key={r.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <ReminderRow reminder={r} onEdit={setEditing} />
                </View>
              ))}
              <View style={styles.divider} />
              <TouchableOpacity style={styles.addBtn} onPress={() => setEditing({})} activeOpacity={0.7}>
                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                <Text style={styles.addBtnText}>Add Reminder</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.titleRow, { marginTop: 20 }]}>
              <Text style={styles.groupLabel}>Completed ({completed.length})</Text>
              {completed.length > 0 ? (
                <TouchableOpacity onPress={handleClearCompleted} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.clearBtn}>Clear Completed</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <View style={styles.card}>
              {completed.length === 0 ? (
                <Text style={styles.empty}>Nothing completed yet</Text>
              ) : completed.map((r, i) => (
                <View key={r.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <ReminderRow reminder={r} onEdit={setEditing} />
                </View>
              ))}
            </View>
          </ScrollView>
        </SafeAreaView>

        <ReminderEditModal reminder={editing} userId={userId} onClose={() => setEditing(null)} />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, letterSpacing: 0.2 },
  seeAll: { fontSize: 13, fontWeight: '600', color: colors.primary },

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
  empty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 14 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: '#fff',
  },
  rowBody: { flex: 1 },
  rowText: { fontSize: 15, color: colors.textPrimary },
  rowTextDone: { color: colors.textMuted, textDecorationLine: 'line-through' },
  rowDue: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rowDueOverdue: { color: colors.danger, fontWeight: '600' },

  deleteAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'center',
    width: 76,
  },
  deleteActionText: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: 2 },

  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 },
  addBtnText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  groupLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
  clearBtn: { fontSize: 13, fontWeight: '600', color: colors.danger, marginBottom: 8 },

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
  modalDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 28,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  modalDeleteText: { fontSize: 14, fontWeight: '600', color: colors.danger },
});
