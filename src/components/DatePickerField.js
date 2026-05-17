import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

function parseStoredDate(str) {
  if (!str) return new Date();
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? new Date() : d;
}

function formatDateDisplay(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function dateToStorage(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Tappable date field that opens a calendar picker in a modal overlay.
 *
 * Props:
 *   value       – yyyy-mm-dd string (or empty string)
 *   onChange    – called with new yyyy-mm-dd string
 *   placeholder – text shown when no date is selected
 *   clearable   – show × button to clear the value (default true)
 *   label       – optional label shown above the field
 */
export default function DatePickerField({ value, onChange, placeholder, clearable = true, label }) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerValue = parseStoredDate(value);

  return (
    <>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <TouchableOpacity
        style={styles.btn}
        onPress={() => setShowPicker(true)}
        activeOpacity={0.7}
      >
        <Ionicons
          name="calendar-outline"
          size={16}
          color={value ? colors.primary : colors.textMuted}
          style={{ marginRight: 6 }}
        />
        <Text style={[{ flex: 1 }, value ? styles.btnValue : styles.btnPlaceholder]}>
          {value ? formatDateDisplay(value) : (placeholder || 'Select date…')}
        </Text>
        {clearable && value ? (
          <TouchableOpacity
            onPress={() => onChange('')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        )}
      </TouchableOpacity>

      {showPicker && Platform.OS === 'ios' && (
        <Modal
          transparent
          animationType="fade"
          visible
          onRequestClose={() => setShowPicker(false)}
        >
          <View style={styles.overlay}>
            <View style={styles.popup}>
              <View style={styles.popupHeader}>
                <Text style={styles.popupTitle}>Select Date</Text>
                <TouchableOpacity onPress={() => setShowPicker(false)}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <DateTimePicker
                value={pickerValue}
                mode="date"
                display="inline"
                onChange={(event, selected) => {
                  if (selected) {
                    onChange(dateToStorage(selected));
                    setTimeout(() => setShowPicker(false), 150);
                  }
                }}
                accentColor={colors.primary}
                textColor="#111827"
              />
            </View>
          </View>
        </Modal>
      )}

      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={pickerValue}
          mode="date"
          display="default"
          onChange={(event, selected) => {
            setShowPicker(false);
            if (event.type !== 'dismissed' && selected) onChange(dateToStorage(selected));
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 6,
    marginTop: 14,
    marginLeft: 4,
  },

  btn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  btnValue:       { fontSize: 15, color: colors.textPrimary },
  btnPlaceholder: { fontSize: 15, color: colors.textMuted },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  popup: {
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    width: '100%',
  },
  popupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  popupTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
});
