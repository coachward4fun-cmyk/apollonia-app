import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import AppTextInput from '../components/AppTextInput';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getJobTypes, saveJobType } from '../services/db';
import { colors } from '../theme/colors';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function EditJobTypeScreen() {
  const navigation = useNavigation();
  const { jobTypeId } = useRoute().params || {};
  const isNew = !jobTypeId;

  const [name,      setName]      = useState('');
  const [lineItems, setLineItems] = useState([]);
  const [saving,    setSaving]    = useState(false);
  const [loading,   setLoading]   = useState(!isNew);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const types = await getJobTypes();
        const jt = types.find((t) => t.id === jobTypeId);
        if (jt) {
          setName(jt.name || '');
          setLineItems((jt.lineItems || []).map((i) => ({
            description: i.description || '',
            unit:        i.unit || '',
            qty:         String(i.qty ?? 0),
            unitPrice:   String(i.unitPrice ?? 0),
            isBid:       !!i.isBid,
          })));
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateItem = (index, field, value) => {
    setLineItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  const addItem = () => {
    setLineItems((prev) => [...prev, { description: '', unit: '', qty: '1', unitPrice: '0', isBid: false }]);
  };

  const removeItem = (index) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert('Required', 'Enter a job type name.');
      return;
    }
    setSaving(true);
    try {
      const jobType = {
        id: jobTypeId || generateId(),
        name: name.trim(),
        lineItems: lineItems.map((i) => ({
          description: i.description,
          unit:        i.unit || '',
          qty:         parseFloat(i.qty) || 0,
          unitPrice:   parseFloat(i.unitPrice) || 0,
          isBid:       !!i.isBid,
        })),
      };
      await saveJobType(jobType);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
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
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Job Types</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isNew ? 'New Job Type' : 'Edit Job Type'}</Text>
        <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.saveBtn}>
          {saving
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={styles.saveBtnText}>Save</Text>}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          <Text style={styles.sectionLabel}>JOB TYPE NAME</Text>
          <View style={styles.inputCard}>
            <AppTextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Roofing"
              placeholderTextColor="#9ca3af"
              returnKeyType="next"
            />
          </View>

          <View style={styles.lineItemsHeader}>
            <Text style={styles.sectionLabel}>LINE ITEMS ({lineItems.length})</Text>
            <TouchableOpacity onPress={addItem} style={styles.addItemBtn}>
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.addItemText}>Add Line Item</Text>
            </TouchableOpacity>
          </View>

          {lineItems.length === 0 ? (
            <Text style={styles.noItems}>No line items. Tap "Add Line Item" to add defaults for this job type.</Text>
          ) : (
            lineItems.map((item, i) => (
              <View key={i} style={styles.lineItemCard}>
                <View style={styles.lineItemDescRow}>
                  <AppTextInput
                    style={styles.lineItemDescInput}
                    value={item.description}
                    onChangeText={(v) => updateItem(i, 'description', v)}
                    placeholder="Description"
                    placeholderTextColor="#9ca3af"
                    returnKeyType="next"
                  />
                  <TouchableOpacity onPress={() => removeItem(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                </View>
                <View style={styles.lineItemRow}>
                  <View style={styles.lineItemField}>
                    <Text style={styles.fieldLabel}>Unit</Text>
                    <AppTextInput
                      style={styles.fieldInput}
                      value={item.unit}
                      onChangeText={(v) => updateItem(i, 'unit', v)}
                      placeholder="SQ"
                      placeholderTextColor="#9ca3af"
                      autoCapitalize="characters"
                      selectTextOnFocus
                    />
                  </View>
                  <View style={styles.lineItemField}>
                    <Text style={styles.fieldLabel}>Default Qty</Text>
                    <AppTextInput
                      style={styles.fieldInput}
                      value={item.qty}
                      onChangeText={(v) => updateItem(i, 'qty', v)}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                  <View style={styles.lineItemField}>
                    <Text style={styles.fieldLabel}>Unit Price</Text>
                    <View style={styles.priceWrap}>
                      <Text style={styles.dollarSign}>$</Text>
                      <AppTextInput
                        style={styles.fieldInput}
                        value={item.unitPrice}
                        onChangeText={(v) => updateItem(i, 'unitPrice', v)}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.bidToggleRow}
                  onPress={() => updateItem(i, 'isBid', !item.isBid)}
                  hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                >
                  <Ionicons name={item.isBid ? 'checkbox' : 'square-outline'} size={16} color={item.isBid ? colors.primary : '#9ca3af'} />
                  <Text style={styles.bidToggleText}>Bid item (no fixed price)</Text>
                </TouchableOpacity>
              </View>
            ))
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
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
  saveBtn: { paddingHorizontal: 4, minWidth: 48, alignItems: 'flex-end' },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.primary },

  content: { padding: 16 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: '#9ca3af',
    letterSpacing: 0.8, marginBottom: 6, marginTop: 16, marginLeft: 4,
  },

  inputCard: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  input: { fontSize: 15, color: '#111827', paddingVertical: 14 },

  lineItemsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4 },
  addItemText: { fontSize: 13, fontWeight: '600', color: colors.primary },

  noItems: { fontSize: 13, color: '#9ca3af', textAlign: 'center', paddingVertical: 20, lineHeight: 19 },

  lineItemCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  lineItemDescRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  lineItemDescInput: {
    flex: 1, fontSize: 13, fontWeight: '600', color: '#111827',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 2,
  },
  lineItemRow: { flexDirection: 'row', gap: 12 },
  lineItemField: { flex: 1, alignItems: 'center', gap: 4 },
  fieldLabel: { fontSize: 9, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 },
  fieldInput: {
    backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, fontWeight: '600',
    color: '#111827', minWidth: 60, textAlign: 'center',
  },
  priceWrap: { flexDirection: 'row', alignItems: 'center' },
  dollarSign: { fontSize: 13, color: '#6b7280', marginRight: 2 },
  bidToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  bidToggleText: { fontSize: 12, color: '#6b7280', fontWeight: '500' },
});
