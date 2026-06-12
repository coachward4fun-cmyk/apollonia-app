import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getExpenses } from '../services/db';
import { colors } from '../theme/colors';

function fmtMoney(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function formatShortDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthKey(dateStr) { return (dateStr || '').slice(0, 7); }

function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long' });
}

function groupByMonth(list) {
  const groups = {};
  for (const e of list) {
    const k = monthKey(e.date);
    if (!k) continue;
    (groups[k] = groups[k] || []).push(e);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return groups;
}

function sumOf(list) {
  return list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

export default function ExpensesYTDScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const handleBack = useCallback(() => {
    if (route.params?.fromDashboard) { navigation.popToTop(); navigation.navigate('Dashboard'); }
    else navigation.goBack();
  }, [navigation, route.params?.fromDashboard]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      getExpenses().then((data) => { setExpenses(data); setLoading(false); }).catch(() => setLoading(false));
    }, [])
  );

  const year = new Date().getFullYear();
  const yearStr = String(year);

  const yearExpenses     = expenses.filter((e) => (e.date || '').startsWith(yearStr));
  const companyExpenses  = yearExpenses.filter((e) => e.type === 'company');
  const jobExpenses      = yearExpenses.filter((e) => e.type === 'job' && e.addToInvoice !== true);

  const companyByMonth   = groupByMonth(companyExpenses);
  const jobByMonth       = groupByMonth(jobExpenses);

  const companyTotal = sumOf(companyExpenses);
  const jobTotal     = sumOf(jobExpenses);
  const grandTotal   = companyTotal + jobTotal;

  const sortedMonthKeys = (groups) => Object.keys(groups).sort((a, b) => b.localeCompare(a));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Expenses YTD {year}</Text>
        <View style={{ width: 34 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Expenses {year}</Text>
            <Text style={styles.summaryValue}>{fmtMoney(grandTotal)}</Text>
            <Text style={styles.summaryMeta}>
              Company {fmtMoney(companyTotal)} · Job (not invoiced) {fmtMoney(jobTotal)}
            </Text>
          </View>

          {/* Company Expenses */}
          <Text style={styles.sectionLabel}>COMPANY EXPENSES</Text>
          {companyExpenses.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No company expenses this year</Text>
            </View>
          ) : (
            <View style={styles.tableCard}>
              {sortedMonthKeys(companyByMonth).map((k) => {
                const items = companyByMonth[k];
                const subtotal = sumOf(items);
                return (
                  <View key={k}>
                    <View style={styles.monthHeader}>
                      <Text style={styles.monthHeaderLabel}>{monthLabel(k)}</Text>
                      <Text style={styles.monthHeaderTotal}>{fmtMoney(subtotal)}</Text>
                    </View>
                    {items.map((e, i) => (
                      <View key={e.id || i} style={[styles.row, i === items.length - 1 && styles.rowLast]}>
                        <Text style={styles.cellDate}>{formatShortDate(e.date)}</Text>
                        <Text style={styles.cellDesc} numberOfLines={1}>
                          {e.description || e.category || 'Expense'}
                        </Text>
                        <Text style={styles.cellAmount}>{fmtMoney(e.amount)}</Text>
                      </View>
                    ))}
                  </View>
                );
              })}
              <View style={styles.sectionTotalRow}>
                <Text style={styles.sectionTotalLabel}>Section Total</Text>
                <Text style={styles.sectionTotalValue}>{fmtMoney(companyTotal)}</Text>
              </View>
            </View>
          )}

          {/* Job Expenses — Not Invoiced */}
          <Text style={styles.sectionLabel}>JOB EXPENSES (NOT INVOICED)</Text>
          {jobExpenses.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No un-invoiced job expenses this year</Text>
            </View>
          ) : (
            <View style={styles.tableCard}>
              {sortedMonthKeys(jobByMonth).map((k) => {
                const items = jobByMonth[k];
                const subtotal = sumOf(items);
                return (
                  <View key={k}>
                    <View style={styles.monthHeader}>
                      <Text style={styles.monthHeaderLabel}>{monthLabel(k)}</Text>
                      <Text style={styles.monthHeaderTotal}>{fmtMoney(subtotal)}</Text>
                    </View>
                    {items.map((e, i) => (
                      <View key={e.id || i} style={[styles.row, i === items.length - 1 && styles.rowLast]}>
                        <Text style={styles.cellDate}>{formatShortDate(e.date)}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.cellDesc} numberOfLines={1}>
                            {e.description || e.category || 'Expense'}
                          </Text>
                          {e.jobName ? (
                            <Text style={styles.cellSub} numberOfLines={1}>{e.jobName}</Text>
                          ) : null}
                        </View>
                        <Text style={styles.cellAmount}>{fmtMoney(e.amount)}</Text>
                      </View>
                    ))}
                  </View>
                );
              })}
              <View style={styles.sectionTotalRow}>
                <Text style={styles.sectionTotalLabel}>Section Total</Text>
                <Text style={styles.sectionTotalValue}>{fmtMoney(jobTotal)}</Text>
              </View>
            </View>
          )}

          <View style={styles.grandTotalCard}>
            <Text style={styles.grandTotalLabel}>GRAND TOTAL</Text>
            <Text style={styles.grandTotalValue}>{fmtMoney(grandTotal)}</Text>
          </View>

          <View style={{ height: 32 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingVertical: 12,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  backBtn: { width: 34, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16 },

  summaryCard: {
    backgroundColor: colors.primary, borderRadius: 14,
    padding: 20, alignItems: 'center', marginBottom: 16,
  },
  summaryLabel: { fontSize: 13, color: '#bbf7d0', fontWeight: '600' },
  summaryValue: { fontSize: 36, fontWeight: '800', color: '#fff', marginTop: 4 },
  summaryMeta:  { fontSize: 12, color: '#86efac', marginTop: 6, textAlign: 'center' },

  sectionLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginBottom: 8, marginTop: 4,
  },

  emptyCard: {
    backgroundColor: '#fff', borderRadius: 12,
    padding: 20, alignItems: 'center', marginBottom: 18,
  },
  emptyText: { fontSize: 13, color: colors.textMuted },

  tableCard: {
    backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden',
    marginBottom: 18,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07, shadowRadius: 4, elevation: 2,
  },
  monthHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#f9fafb',
    paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  monthHeaderLabel: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  monthHeaderTotal: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },

  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
    gap: 10,
  },
  rowLast: { borderBottomWidth: 0 },
  cellDate:   { width: 56, fontSize: 12, color: colors.textSecondary },
  cellDesc:   { flex: 1, fontSize: 13, color: colors.textPrimary },
  cellSub:    { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  cellAmount: { width: 70, fontSize: 13, fontWeight: '700', color: colors.textPrimary, textAlign: 'right' },

  sectionTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: '#f0fdf4',
    borderTopWidth: 1, borderTopColor: '#bbf7d0',
  },
  sectionTotalLabel: { fontSize: 12, fontWeight: '700', color: colors.primary, letterSpacing: 0.4 },
  sectionTotalValue: { fontSize: 14, fontWeight: '800', color: colors.primary },

  grandTotalCard: {
    backgroundColor: '#111827', borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 4,
  },
  grandTotalLabel: { fontSize: 13, fontWeight: '800', color: '#fff', letterSpacing: 1 },
  grandTotalValue: { fontSize: 20, fontWeight: '800', color: '#fff' },
});
