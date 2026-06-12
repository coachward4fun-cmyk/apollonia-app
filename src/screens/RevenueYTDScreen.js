import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { getJobs } from '../services/db';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

// Compares two job arrays on the fields that influence the YTD revenue
// computation. Used to skip a state update (and therefore a re-render +
// re-compute) when refocusing the screen returns identical data.
function jobsRevenueEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id) return false;
    if (x.status !== y.status) return false;
    if (x.invoiceTotal !== y.invoiceTotal) return false;
    if (x.invoiceDate !== y.invoiceDate) return false;
    if (x.targetDate !== y.targetDate) return false;
    if (x.billToName !== y.billToName) return false;
    if (x.archivedForCustomer !== y.archivedForCustomer) return false;
  }
  return true;
}

function fmtCurrency(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function currentYear() {
  return new Date().getFullYear();
}

export default function RevenueYTDScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  // When opened from Dashboard, back should return to Dashboard tab — not the
  // Admin stack root (which is where this screen is registered).
  const handleBack = useCallback(() => {
    if (route.params?.fromDashboard) { navigation.popToTop(); navigation.navigate('Dashboard'); }
    else navigation.goBack();
  }, [navigation, route.params?.fromDashboard]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lastJobsRef = useRef([]);

  // Re-fetch every time the screen comes into focus so data is always fresh.
  // Skip the state update (and downstream recompute) when the new active-jobs
  // set is identical to what we already had — common when bouncing between tabs.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      getJobs()
        .then((data) => {
          const active = data.filter((j) => !j.archivedForCustomer);
          if (!jobsRevenueEqual(active, lastJobsRef.current)) {
            lastJobsRef.current = active;
            setJobs(active);
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, [])
  );

  const year = currentYear();
  const yearStr = String(year);

  const paidJobs = jobs.filter((j) => {
    const status = (j.status || '').toLowerCase();
    return (
      status === 'invoice paid' &&
      (j.invoiceDate || j.targetDate || '').startsWith(yearStr) &&
      j.invoiceTotal != null
    );
  });

  // Debug log — verify which jobs are being summed
  console.log(`[RevenueYTD] Total jobs: ${jobs.length} | Paid ${year}: ${paidJobs.length} | Total: $${paidJobs.reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0)}`);
  paidJobs.forEach((j) => {
    console.log(`  ✓ ${j.projectName || 'Untitled'} | status="${j.status}" | invoiceTotal=${j.invoiceTotal} | invoiceDate=${j.invoiceDate} | targetDate=${j.targetDate}`);
  });

  const totalRevenue = paidJobs.reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);

  // Group by customer
  const byCustomer = {};
  for (const job of paidJobs) {
    const key = job.billToName || 'Unknown Customer';
    if (!byCustomer[key]) byCustomer[key] = { name: key, total: 0, jobCount: 0 };
    byCustomer[key].total += Number(job.invoiceTotal) || 0;
    byCustomer[key].jobCount++;
  }

  const sorted = Object.values(byCustomer).sort((a, b) => b.total - a.total);
  const top10 = sorted.slice(0, 10);
  const others = sorted.slice(10);
  const othersTotal = others.reduce((s, c) => s + c.total, 0);
  const othersCount = others.reduce((s, c) => s + c.jobCount, 0);

  const rows = othersTotal > 0
    ? [...top10, { name: 'Other Customers', total: othersTotal, jobCount: othersCount, isOther: true }]
    : top10;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Revenue YTD {year}</Text>
        <TouchableOpacity onPress={onRefresh} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Revenue {year}</Text>
            <Text style={styles.summaryValue}>{fmtCurrency(totalRevenue)}</Text>
            <Text style={styles.summaryMeta}>{paidJobs.length} paid invoice{paidJobs.length !== 1 ? 's' : ''}</Text>
          </View>

          {rows.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="bar-chart-outline" size={52} color={colors.textMuted} />
              <Text style={styles.emptyText}>No paid invoices in {year} yet</Text>
            </View>
          ) : (
            <View style={styles.tableCard}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeadCell, { flex: 1 }]}>Customer</Text>
                <Text style={[styles.tableHeadCell, styles.tableRight, { width: 44 }]}>Jobs</Text>
                <Text style={[styles.tableHeadCell, styles.tableRight, { width: 88 }]}>Revenue</Text>
              </View>
              {rows.map((row, i) => (
                <View
                  key={row.name}
                  style={[styles.tableRow, row.isOther && styles.tableRowOther, i === rows.length - 1 && styles.tableRowLast]}
                >
                  <Text style={[styles.tableCell, { flex: 1 }, row.isOther && styles.tableCellMuted]} numberOfLines={1}>
                    {row.name}
                  </Text>
                  <Text style={[styles.tableCell, styles.tableRight, { width: 44 }, row.isOther && styles.tableCellMuted]}>
                    {row.jobCount}
                  </Text>
                  <Text style={[styles.tableCell, styles.tableRight, styles.tableCellBold, { width: 88 }]}>
                    {fmtCurrency(row.total)}
                  </Text>
                </View>
              ))}
              <View style={styles.tableTotalRow}>
                <Text style={[styles.tableTotalCell, { flex: 1 }]}>Total</Text>
                <Text style={[styles.tableTotalCell, styles.tableRight, { width: 44 }]}>{paidJobs.length}</Text>
                <Text style={[styles.tableTotalCell, styles.tableRight, { width: 88 }]}>{fmtCurrency(totalRevenue)}</Text>
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
  refreshBtn: { width: 34, alignItems: 'center' },
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
    backgroundColor: '#f0fdf4',
    borderTopWidth: 2,
    borderTopColor: '#86efac',
  },
  tableTotalCell: { fontSize: 14, fontWeight: '800', color: colors.primary },
});
