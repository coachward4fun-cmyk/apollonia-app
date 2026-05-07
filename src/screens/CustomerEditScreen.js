import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView,
  ScrollView, TouchableOpacity, TextInput,
  Alert, ActivityIndicator, Animated,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getCustomers, getJobs, saveCustomer, saveJob } from '../services/db';
import { colors } from '../theme/colors';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function CustomerEditScreen() {
  const navigation    = useNavigation();
  const { customerName } = useRoute().params;

  const [name,        setName]        = useState(customerName);
  const [address,     setAddress]     = useState('');
  const [email,       setEmail]       = useState('');
  const [salesperson, setSalesperson] = useState('');
  const [saving,      setSaving]      = useState(false);
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
        const [customers, jobs] = await Promise.all([getCustomers(), getJobs()]);

        const saved = customers.find((c) => c.name === customerName);
        if (saved && active) {
          if (saved.address)     setAddress(saved.address);
          if (saved.email)       setEmail(saved.email);
          if (saved.salesperson) setSalesperson(saved.salesperson);
          return;
        }

        for (const j of jobs.filter((j) => j.billToName?.trim() === customerName)) {
          if (active) {
            if (j.billToAddress) setAddress((prev) => prev || j.billToAddress);
            if (j.email)         setEmail((prev) => prev || j.email);
            if (j.salesperson)   setSalesperson((prev) => prev || j.salesperson);
          }
        }
      } catch {}
    })();
    return () => { active = false; };
  }, [customerName]);

  const doSave = async (trimName, updateJobs) => {
    setSaving(true);
    try {
      const customers = await getCustomers();
      const existing  = customers.find((c) => c.name === customerName);
      const entry = {
        id:          existing ? existing.id : generateId(),
        name:        trimName,
        address:     address.trim(),
        email:       email.trim(),
        salesperson: salesperson.trim(),
        updatedAt:   new Date().toISOString(),
      };
      await saveCustomer(entry);

      if (updateJobs) {
        const jobs = await getJobs();
        const toUpdate = jobs.filter(
          (j) => j.billToName?.trim() === customerName && (j.status || '').toLowerCase() !== 'invoice paid',
        );
        await Promise.all(
          toUpdate.map((j) => saveJob({
            ...j,
            billToName:    trimName,
            billToAddress: address.trim(),
            email:         email.trim(),
            salesperson:   salesperson.trim(),
          })),
        );
      }

      showSuccess('Customer saved successfully');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const trimName = name.trim();
    if (!trimName) {
      Alert.alert('Error', 'Customer name is required.');
      return;
    }

    try {
      const jobs = await getJobs();
      const unpaidCount = jobs.filter(
        (j) => j.billToName?.trim() === customerName && (j.status || '').toLowerCase() !== 'invoice paid',
      ).length;

      if (unpaidCount === 0) {
        await doSave(trimName, false);
        return;
      }

      Alert.alert(
        'Update Customer',
        `Also update customer details on ${unpaidCount} unpaid job${unpaidCount !== 1 ? 's' : ''}?`,
        [
          {
            text: 'Save Customer Only',
            onPress: () => doSave(trimName, false),
          },
          {
            text: `Update ${unpaidCount} Job${unpaidCount !== 1 ? 's' : ''}`,
            onPress: () => doSave(trimName, true),
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save changes.');
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
          Saving will update all unpaid jobs linked to this customer name.
        </Text>

        <Field label="NAME"        value={name}        onChange={setName}        placeholder="Customer name" />
        <Field label="ADDRESS"     value={address}     onChange={setAddress}     placeholder="Billing address" />
        <Field
          label="EMAIL"
          value={email}
          onChange={setEmail}
          placeholder="customer@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Field label="SALESPERSON" value={salesperson} onChange={setSalesperson} placeholder="Salesperson name" />

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
});
