import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { getJobs, getExpenses } from '../services/db';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtCurrency(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function fmtPct(n) {
  return n.toFixed(1) + '%';
}

function fmtK(n) {
  if (n == null || isNaN(n)) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1000)  return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

// ── YTD metrics ────────────────────────────────────────────────────────────────

function calcMetrics(jobs, expenses, startStr, endStr) {
  const periodJobs = jobs.filter((j) => {
    const date = j.targetDate || j.invoiceDate || '';
    return date >= startStr && date <= endStr;
  });

  const paidJobs    = periodJobs.filter((j) => (j.status || '').toLowerCase() === 'invoice paid');
  const notPaidJobs = periodJobs.filter((j) => {
    const s = (j.status || '').toLowerCase();
    return s === 'invoice sent' || s === 'invoice ready';
  });

  const revenue    = paidJobs.reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);
  const notPaid    = notPaidJobs.reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);

  const periodExpenses = expenses.filter((e) => {
    const date = e.date || '';
    return date >= startStr && date <= endStr;
  });
  const totalExpenses = periodExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const net    = revenue - totalExpenses;
  const margin = revenue > 0 ? (net / revenue) * 100 : null;

  return {
    totalJobs: periodJobs.length,
    jobsPaid:  paidJobs.length,
    notPaid,
    revenue,
    expenses:  totalExpenses,
    net,
    margin,
  };
}

// ── 3-month metrics ────────────────────────────────────────────────────────────

function buildMonthStats(jobs, expenses, monthKey) {
  const monthJobs = jobs.filter((j) => (j.targetDate || '').startsWith(monthKey));
  const monthExp  = expenses.filter((e) => (e.date || '').startsWith(monthKey));

  const totalJobs = monthJobs.length;
  const invoiced  = monthJobs
    .filter((j) => { const s = (j.status || '').toLowerCase(); return s === 'invoice ready' || s === 'invoice sent'; })
    .reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);
  const paidJobs = monthJobs.filter((j) => (j.status || '').toLowerCase() === 'invoice paid');
  const jobsPaid = paidJobs.length;
  const revenue  = paidJobs.reduce((s, j) => s + (Number(j.invoiceTotal) || 0), 0);
  const expTotal = monthExp.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const net      = revenue - expTotal;
  const margin   = revenue > 0 ? (net / revenue) * 100 : null;

  return { totalJobs, invoiced, jobsPaid, revenue, expTotal, net, margin };
}

// ── Shared metric row definitions ──────────────────────────────────────────────

const YTD_METRICS = [
  { key: 'totalJobs', label: 'Total Jobs', fmt: 'count'    },
  { key: 'jobsPaid',  label: 'Jobs Paid',  fmt: 'count'    },
  { key: 'notPaid',   label: 'Not Paid $', fmt: 'currency' },
  { key: 'revenue',   label: 'Revenue',    fmt: 'currency' },
  { key: 'expenses',  label: 'Expenses',   fmt: 'currency' },
  { key: 'net',       label: 'Net $',      fmt: 'net'      },
  { key: 'margin',    label: 'Margin %',   fmt: 'percent'  },
];

const MONTH_ROWS = [
  { key: 'totalJobs', label: 'Total Jobs', fmt: (s) => String(s.totalJobs) },
  { key: 'jobsPaid',  label: 'Jobs Paid',  fmt: (s) => String(s.jobsPaid) },
  { key: 'invoiced',  label: 'Not Paid $', fmt: (s) => fmtK(s.invoiced) },
  { key: 'revenue',   label: 'Revenue',    fmt: (s) => fmtK(s.revenue) },
  { key: 'expTotal',  label: 'Expenses',   fmt: (s) => fmtK(s.expTotal) },
  {
    key: 'net', label: 'Net $', bold: true,
    fmt: (s) => fmtK(s.net),
    getColor: (s) => s.net < 0 ? '#dc2626' : '#16a34a',
  },
  {
    key: 'margin', label: 'Margin %',
    fmt: (s) => s.margin === null ? 'N/A' : `${Math.round(s.margin)}%`,
    getColor: (s) => s.margin === null ? colors.textMuted : s.margin >= 0 ? '#16a34a' : '#dc2626',
  },
];

const H_HDR = 44;
const H_ROW = 28;
const H_DIV = 10;

// ── YTD cell renderer ──────────────────────────────────────────────────────────

function CellValue({ metric, value }) {
  if (metric.fmt === 'count') {
    return <Text style={styles.cellValue}>{value}</Text>;
  }
  if (metric.fmt === 'currency') {
    return <Text style={styles.cellValue}>{fmtCurrency(value)}</Text>;
  }
  if (metric.fmt === 'net') {
    const color = value > 0 ? styles.positive : value < 0 ? styles.negative : null;
    return <Text style={[styles.cellValue, color]}>{fmtCurrency(value)}</Text>;
  }
  if (metric.fmt === 'percent') {
    if (value === null) return <Text style={styles.cellMuted}>N/A</Text>;
    const color = value > 0 ? styles.positive : value < 0 ? styles.negative : null;
    return <Text style={[styles.cellValue, color]}>{fmtPct(value)}</Text>;
  }
  return null;
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function FinancialsScreen() {
  const navigation = useNavigation();
  const [jobs,     setJobs]     = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [view,     setView]     = useState('3months'); // '3months' | 'ytd'

  useEffect(() => {
    setLoading(true);
    Promise.all([getJobs(), getExpenses()])
      .then(([jobsData, expData]) => {
        setJobs(jobsData.filter((j) => !j.archivedForCustomer));
        setExpenses(expData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const now      = new Date();
  const year     = now.getFullYear();
  const prevYear = year - 1;
  const todayStr = localTodayStr();

  const ytd  = calcMetrics(jobs, expenses, `${year}-01-01`,     todayStr);
  const prev = calcMetrics(jobs, expenses, `${prevYear}-01-01`, `${prevYear}-12-31`);

  const THREE_MONTHS = [-2, -1, 0].map((offset) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = offset === 0
      ? d.toLocaleDateString('en-US', { month: 'long' }) + ' MTD'
      : d.toLocaleDateString('en-US', { month: 'long' });
    return { key, label, isCurrent: offset === 0, stats: buildMonthStats(jobs, expenses, key) };
  });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Financials</Text>
        <View style={{ width: 34 }} />
      </View>

      {/* View toggle */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleBtn, view === '3months' && styles.toggleBtnActive]}
          onPress={() => setView('3months')}
        >
          <Text style={[styles.toggleBtnText, view === '3months' && styles.toggleBtnTextActive]}>3 Months</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, view === 'ytd' && styles.toggleBtnActive]}
          onPress={() => setView('ytd')}
        >
          <Text style={[styles.toggleBtnText, view === 'ytd' && styles.toggleBtnTextActive]}>YTD</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : view === 'ytd' ? (
        /* ── YTD view ── */
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.tableCard}>
            <View style={[styles.row, styles.headRow]}>
              <Text style={[styles.metricCell, styles.headLabel, styles.headLabelLeft]}>Metric</Text>
              <Text style={[styles.ytdCell, styles.headLabel]}>{year} YTD</Text>
              <Text style={[styles.prevCell, styles.headLabel]}>{prevYear}</Text>
            </View>

            {YTD_METRICS.map((metric, i) => (
              <View
                key={metric.key}
                style={[
                  styles.row,
                  i % 2 === 1 && styles.rowAlt,
                  i === YTD_METRICS.length - 1 && styles.rowLast,
                ]}
              >
                <Text style={styles.metricCell}>{metric.label}</Text>
                <View style={styles.ytdCell}>
                  <CellValue metric={metric} value={ytd[metric.key]} />
                </View>
                <View style={styles.prevCell}>
                  <CellValue metric={metric} value={prev[metric.key]} />
                </View>
              </View>
            ))}
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      ) : (
        /* ── 3-month view ── */
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.monthTableCard}>
            <View style={styles.monthTableInner}>
              {/* Labels column */}
              <View style={styles.monthLabels}>
                <View style={{ height: H_HDR }} />
                <View style={{ height: H_DIV }} />
                {MONTH_ROWS.map((row) => (
                  <View key={row.key} style={{ height: H_ROW, justifyContent: 'center' }}>
                    <Text style={styles.monthMetricLabel}>{row.label}</Text>
                  </View>
                ))}
              </View>

              {/* Month columns */}
              {THREE_MONTHS.map((m) => (
                <View
                  key={m.key}
                  style={[
                    styles.monthCol,
                    m.isCurrent && styles.monthColCurrent,
                  ]}
                >
                  {/* Header */}
                  <View style={{ height: H_HDR, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                    <Text style={[styles.monthColHeader, m.isCurrent && styles.monthColHeaderCurrent]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>
                      {m.label}
                    </Text>
                  </View>

                  {/* Divider */}
                  <View style={{ height: H_DIV, justifyContent: 'center', paddingHorizontal: 4 }}>
                    <View style={[styles.monthColLine, m.isCurrent && { backgroundColor: '#86efac' }]} />
                  </View>

                  {/* Metric rows */}
                  {MONTH_ROWS.map((row) => {
                    const val   = row.fmt(m.stats);
                    const color = row.getColor ? row.getColor(m.stats) : null;
                    return (
                      <View key={row.key} style={{ height: H_ROW, alignItems: 'center', justifyContent: 'center' }}>
                        <Text
                          style={[
                            styles.monthMetricValue,
                            row.bold && styles.monthMetricValueBold,
                            color ? { color } : null,
                          ]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.7}
                        >
                          {val}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
          <View style={{ height: 40 }} />
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
  backBtn:     { width: 34, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content:     { padding: 16 },

  toggleRow: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  toggleBtnActive: { backgroundColor: colors.primary },
  toggleBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  toggleBtnTextActive: { color: '#fff' },

  // ── YTD table ──
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  headRow: {
    backgroundColor: '#f9fafb',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  rowAlt:  { backgroundColor: '#fafafa' },
  rowLast: { borderBottomWidth: 0 },
  metricCell: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.textPrimary },
  ytdCell:    { width: 108, alignItems: 'flex-end' },
  prevCell:   { width: 88,  alignItems: 'flex-end' },
  headLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'right',
  },
  headLabelLeft: { textAlign: 'left' },
  cellValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, textAlign: 'right' },
  cellMuted: { fontSize: 13, color: colors.textMuted, textAlign: 'right' },
  positive:  { color: colors.primary },
  negative:  { color: '#dc2626' },

  // ── 3-month table ──
  monthTableCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  monthTableInner: { flexDirection: 'row', gap: 6 },
  monthLabels: { width: 72 },
  monthMetricLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },
  monthCol: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  monthColCurrent: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  monthColHeader: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  monthColHeaderCurrent: { color: colors.primary },
  monthColLine: { height: 1, backgroundColor: '#e5e7eb' },
  monthMetricValue: { fontSize: 12, color: colors.textPrimary, fontWeight: '600', textAlign: 'center' },
  monthMetricValueBold: { fontWeight: '800', fontSize: 13 },
});
