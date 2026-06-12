import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { getExpenses } from '../services/db';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

const PAGE_SIZE = 25;

function fmtCurrency(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function currentYear() {
  return new Date().getFullYear();
}

function extractCrewName(expense) {
  // 1. Dedicated field (set on new records)
  if (expense.crewName) return expense.crewName;
  if (expense.crew)     return expense.crew;

  // 2. Parse description: "Crew Pay - [Crew Name] - May 2 – May 8"
  //    Take text immediately after "Crew Pay - " up to the next " - "
  const desc = expense.description || '';
  const match = desc.match(/^Crew Pay - (.+?) - /);
  if (match) return match[1];

  // 3. Last resort – return description as-is (no truncation)
  return desc || 'Unknown Crew';
}

function getWeekEndingThursday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  const daysToAdd = (4 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysToAdd);
  return d;
}

function formatWeekEnding(date) {
  if (!date) return '—';
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}/${mm}/${dd}`;
}

export default function CrewPayYTDScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const handleBack = useCallback(() => {
    if (route.params?.fromDashboard) { navigation.popToTop(); navigation.navigate('Dashboard'); }
    else navigation.goBack();
  }, [navigation, route.params?.fromDashboard]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      getExpenses().then((data) => { setExpenses(data); setLoading(false); }).catch(() => setLoading(false));
    }, [])
  );

  const year = currentYear();
  const yearStr = String(year);

  const crewExpenses = expenses.filter((e) =>
    e.isCrewCost === true &&
    e.type === 'company' &&
    (e.date || '').startsWith(yearStr)
  );

  const totalPay = crewExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const rows = crewExpenses
    .map((e) => ({
      id: e.id,
      crewName: extractCrewName(e),
      weekEnding: getWeekEndingThursday(e.date),
      amount: Number(e.amount) || 0,
    }))
    .sort((a, b) => {
      const timeDiff = (b.weekEnding?.getTime() ?? 0) - (a.weekEnding?.getTime() ?? 0);
      if (timeDiff !== 0) return timeDiff;
      return a.crewName.localeCompare(b.crewName);
    });

  const visibleRows = rows.slice(0, page * PAGE_SIZE);
  const hasMore = visibleRows.length < rows.length;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
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
                <Text style={[styles.tableHeadCell, { flex: 1 }]}>Crew Name</Text>
                <Text style={[styles.tableHeadCell, { width: 84 }]}>Week Ending</Text>
                <Text style={[styles.tableHeadCell, styles.tableRight, { width: 88 }]}>Total Pay</Text>
              </View>

              {visibleRows.map((row, i) => (
                <View
                  key={row.id || i}
                  style={[styles.tableRow, i === visibleRows.length - 1 && !hasMore && styles.tableRowLast]}
                >
                  <Text style={[styles.tableCell, { flex: 1 }]} numberOfLines={1}>
                    {row.crewName}
                  </Text>
                  <Text style={[styles.tableCell, styles.cellWeek, { width: 84 }]} numberOfLines={1}>
                    {formatWeekEnding(row.weekEnding)}
                  </Text>
                  <Text style={[styles.tableCell, styles.tableRight, styles.tableCellBold, { width: 88 }]}>
                    {fmtCurrency(row.amount)}
                  </Text>
                </View>
              ))}

              {hasMore && (
                <TouchableOpacity style={styles.loadMoreBtn} onPress={() => setPage((p) => p + 1)}>
                  <Text style={styles.loadMoreText}>Load More</Text>
                </TouchableOpacity>
              )}
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
    backgroundColor: colors.primary,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryLabel: { fontSize: 13, color: '#bbf7d0', fontWeight: '600' },
  summaryValue: { fontSize: 36, fontWeight: '800', color: '#fff', marginTop: 4 },
  summaryMeta: { fontSize: 12, color: '#86efac', marginTop: 4 },
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
  tableHeadCell: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  tableRight: { textAlign: 'right' },
  tableRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'center',
  },
  tableRowLast: { borderBottomWidth: 0 },
  tableCell: { fontSize: 13, color: colors.textPrimary },
  cellWeek: { fontSize: 12, color: colors.textSecondary },
  tableCellBold: { fontWeight: '700' },
  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  loadMoreText: { fontSize: 14, fontWeight: '600', color: colors.primary },
});
