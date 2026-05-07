import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { subscribeExpenses } from '../services/db';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

function fmtCurrency(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function currentYear() {
  return new Date().getFullYear();
}

function extractCrewName(description) {
  // Description format: "Crew Pay - {crew name} - {week label}"
  if (!description) return 'Unknown Crew';
  const match = description.match(/^Crew Pay - (.+?) - /);
  return match ? match[1] : description;
}

export default function CrewPayYTDScreen() {
  const navigation = useNavigation();
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = subscribeExpenses((data) => {
      setExpenses(data);
      setLoading(false);
    });
    return unsub;
  }, []);

  const year = currentYear();
  const yearStr = String(year);

  const crewExpenses = expenses.filter((e) =>
    e.isCrewCost === true && (e.date || '').startsWith(yearStr)
  );

  const totalPay = crewExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Group by crew name
  const byCrew = {};
  for (const exp of crewExpenses) {
    const key = extractCrewName(exp.description);
    if (!byCrew[key]) byCrew[key] = { name: key, total: 0, paymentCount: 0 };
    byCrew[key].total += Number(exp.amount) || 0;
    byCrew[key].paymentCount++;
  }

  const sorted = Object.values(byCrew).sort((a, b) => b.total - a.total);
  const top10 = sorted.slice(0, 10);
  const others = sorted.slice(10);
  const othersTotal = others.reduce((s, c) => s + c.total, 0);
  const othersCount = others.reduce((s, c) => s + c.paymentCount, 0);

  const rows = othersTotal > 0
    ? [...top10, { name: 'Other Crews', total: othersTotal, paymentCount: othersCount, isOther: true }]
    : top10;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Crew Pay YTD {year}</Text>
        <View style={{ width: 34 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Crew Pay {year}</Text>
            <Text style={styles.summaryValue}>{fmtCurrency(totalPay)}</Text>
            <Text style={styles.summaryMeta}>{crewExpenses.length} payment{crewExpenses.length !== 1 ? 's' : ''}</Text>
          </View>

          {rows.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={52} color={colors.textMuted} />
              <Text style={styles.emptyText}>No crew payments recorded in {year}</Text>
            </View>
          ) : (
            <View style={styles.tableCard}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeadCell, { flex: 1 }]}>Crew</Text>
                <Text style={[styles.tableHeadCell, styles.tableRight, { width: 60 }]}>Payments</Text>
                <Text style={[styles.tableHeadCell, styles.tableRight, { width: 88 }]}>Total Pay</Text>
              </View>
              {rows.map((row, i) => (
                <View
                  key={row.name}
                  style={[styles.tableRow, row.isOther && styles.tableRowOther, i === rows.length - 1 && styles.tableRowLast]}
                >
                  <Text style={[styles.tableCell, { flex: 1 }, row.isOther && styles.tableCellMuted]} numberOfLines={1}>
                    {row.name}
                  </Text>
                  <Text style={[styles.tableCell, styles.tableRight, { width: 60 }, row.isOther && styles.tableCellMuted]}>
                    {row.paymentCount}
                  </Text>
                  <Text style={[styles.tableCell, styles.tableRight, styles.tableCellBold, { width: 88 }]}>
                    {fmtCurrency(row.total)}
                  </Text>
                </View>
              ))}
              <View style={styles.tableTotalRow}>
                <Text style={[styles.tableTotalCell, { flex: 1 }]}>Total</Text>
                <Text style={[styles.tableTotalCell, styles.tableRight, { width: 60 }]}>{crewExpenses.length}</Text>
                <Text style={[styles.tableTotalCell, styles.tableRight, { width: 88 }]}>{fmtCurrency(totalPay)}</Text>
              </View>
            </View>
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { width: 34, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16 },
  summaryCard: {
    backgroundColor: '#1d4ed8',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryLabel: { fontSize: 13, color: '#bfdbfe', fontWeight: '600' },
  summaryValue: { fontSize: 36, fontWeight: '800', color: '#fff', marginTop: 4 },
  summaryMeta: { fontSize: 12, color: '#93c5fd', marginTop: 4 },
  empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyText: { fontSize: 15, color: colors.textSecondary, textAlign: 'center' },
  tableCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f9fafb',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tableHeadCell: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  tableRight: { textAlign: 'right' },
  tableRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  tableRowLast: { borderBottomWidth: 0 },
  tableRowOther: { backgroundColor: '#fafafa' },
  tableCell: { fontSize: 13, color: colors.textPrimary },
  tableCellMuted: { color: colors.textSecondary, fontStyle: 'italic' },
  tableCellBold: { fontWeight: '700' },
  tableTotalRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#eff6ff',
    borderTopWidth: 2,
    borderTopColor: '#93c5fd',
  },
  tableTotalCell: { fontSize: 14, fontWeight: '800', color: '#1d4ed8' },
});
