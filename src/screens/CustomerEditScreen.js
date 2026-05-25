import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView,
  ScrollView, TouchableOpacity, TextInput,
  Alert, ActivityIndicator, Animated, Switch,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getCustomers, saveCustomer, getJobs, archiveCustomer } from '../services/db';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { normalizePhone, formatPhoneDisplay } from '../utils/phoneUtils';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function CustomerEditScreen() {
  const navigation    = useNavigation();
  const { customerName } = useRoute().params;

  const [name,        setName]        = useState(customerName);
  const [address,     setAddress]     = useState('');
  const [email,       setEmail]       = useState('');
  const [phone,       setPhone]       = useState('');
  const [salesperson, setSalesperson] = useState('');
  const [retail,      setRetail]      = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [archiving,   setArchiving]   = useState(false);
  const [successMsg,  setSuccessMsg]  = useState('');
  const successOpacity = useRef(new Animated.Value(0)).current;

  const showSuccess = (msg) => {
    setSuccessMsg(msg);
    Animated.sequence([
      Animated.timing(successOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(successOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => navigation.goBack());
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const customers = await getCustomers();
        const saved = customers.find((c) => c.name === customerName);
        if (saved && active) {
          if (saved.address)     setAddress(saved.address);
          if (saved.email)       setEmail(saved.email);
          if (saved.phone)       setPhone(formatPhoneDisplay(saved.phone));
          if (saved.salesperson) setSalesperson(saved.salesperson);
          setRetail(saved.retail === true);
        }
      } catch {}
    })();
    return () => { active = false; };
  }, [customerName]);

  const doArchive = async () => {
    setArchiving(true);
    try {
      await archiveCustomer(customerName);
      logActivity('customer_hidden', `Customer ${customerName} was hidden`);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not hide customer.');
    } finally {
      setArchiving(false);
    }
  };

  const handleArchive = async () => {
    if (archiving || saving) return;
    try {
      const allJobs = await getJobs();
      const custJobs = allJobs.filter((j) => j.billToName === customerName);
      const pendingStatuses = new Set(['invoice sent', 'invoice ready']);
      const hasPending = custJobs.some((j) => pendingStatuses.has((j.status || '').toLowerCase()));
      if (hasPending) {
        Alert.alert(
          'Outstanding Invoices',
          'This customer has invoices that haven\'t been paid yet. Hiding them will remove all their jobs from all lists.\n\nContinue anyway?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Hide Anyway', style: 'destructive', onPress: doArchive },
          ],
        );
      } else {
        await doArchive();
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not check jobs.');
    }
  };

  const handleSave = async () => {
    const trimName = name.trim();
    if (!trimName) {
      Alert.alert('Error', 'Customer name is required.');
      return;
    }
    setSaving(true);
    try {
      const customers = await getCustomers();
      const existing  = customers.find((c) => c.name === customerName);
      await saveCustomer({
        id:          existing ? existing.id : generateId(),
        name:        trimName,
        address:     address.trim(),
        email:       email.trim(),
        phone:       normalizePhone(phone) || '',
        salesperson: salesperson.trim(),
        retail,
        updatedAt:   new Date().toISOString(),
      });
      showSuccess('Customer updated. Changes apply to future jobs only.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topNav}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={20} color={colors.primary} />
          <Text style={styles.backText} numberOfLines={1}>Customers</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle} numberOfLines={1}>Edit Customer</Text>
        <TouchableOpacity onPress={handleSave} style={styles.saveBtn} disabled={saving}>
          {saving
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={styles.saveText}>Save</Text>}
        </TouchableOpacity>
      </View>

      <Animated.View style={[styles.successBanner, { opacity: successOpacity }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={16} color="#16a34a" />
        <Text style={styles.successText}>{successMsg}</Text>
      </Animated.View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.infoText}>
          Changes apply to future jobs only. Existing jobs and invoices keep their original customer data.
        </Text>

        <Field label="NAME"        value={name}        onChange={setName}        placeholder="Customer name" />
        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>ADDRESS</Text>
          <AddressAutocomplete
            value={address}
            onChangeText={setAddress}
            placeholder="Billing address"
            flat
          />
        </View>
        <Field
          label="EMAIL"
          value={email}
          onChange={setEmail}
          placeholder="customer@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Field
          label="PHONE"
          value={phone}
          onChange={setPhone}
          placeholder="555-123-4567"
          keyboardType="phone-pad"
          autoCapitalize="none"
        />
        <Field label="SALESPERSON" value={salesperson} onChange={setSalesperson} placeholder="Salesperson name" />

        <View style={styles.toggleWrap}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>Retail Customer</Text>
            <Text style={styles.toggleSub}>Sales tax applies to retail customers</Text>
          </View>
          <Switch
            value={retail}
            onValueChange={setRetail}
            trackColor={{ false: '#d1d5db', true: '#86efac' }}
            thumbColor={retail ? colors.primary : '#9ca3af'}
            ios_backgroundColor="#d1d5db"
          />
        </View>

        <TouchableOpacity
          style={[styles.archiveBtn, (archiving || saving) && { opacity: 0.5 }]}
          onPress={handleArchive}
          disabled={archiving || saving}
        >
          {archiving
            ? <ActivityIndicator size="small" color="#b45309" />
            : <Ionicons name="eye-off-outline" size={16} color="#b45309" />}
          <Text style={styles.archiveBtnText}>{archiving ? 'Hiding…' : 'Hide Customer'}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType, autoCapitalize }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType={keyboardType || 'default'}
        autoCapitalize={autoCapitalize || 'words'}
        returnKeyType="next"
      />
    </View>
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
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 1, width: 88, flexShrink: 0 },
  backText: { fontSize: 14, color: colors.primary, fontWeight: '500', flexShrink: 1 },
  navTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, flex: 1, textAlign: 'center' },
  saveBtn: { width: 88, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4, flexShrink: 0 },
  saveText: { fontSize: 16, fontWeight: '700', color: colors.primary },

  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f0fdf4',
    borderBottomWidth: 1,
    borderBottomColor: '#bbf7d0',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  successText: { fontSize: 14, fontWeight: '600', color: '#16a34a' },

  content: { padding: 16 },

  infoText: {
    fontSize: 13,
    color: colors.textSecondary,
    backgroundColor: '#f0fdf4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
    lineHeight: 19,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },

  fieldWrap: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  fieldInput: {
    fontSize: 16,
    color: colors.textPrimary,
    paddingVertical: 2,
  },

  toggleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  toggleLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  toggleSub:   { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  archiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
  },
  archiveBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#b45309',
  },
});
