import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { subscribeJobs, subscribeExpenses } from '../services/db';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';

const TODAY = new Date();

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtK(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1000)  return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function buildMonthStats(jobs, expenses, monthKey) {
  const monthJobs = jobs.filter((j) => (j.targetDate || '').startsWith(monthKey));
  const monthExp  = expenses.filter((e) => (e.date || '').startsWith(monthKey));

  const totalJobs = monthJobs.length;

  const invoiced = monthJobs
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

function buildStats(jobs) {
  const total = jobs.length;
  let scheduled = 0;
  let unassigned = 0;
  let notScheduled = 0;
  let scheduledNoCrew = 0;
  let invoiceReady = 0;
  let invoiceSent = 0;
  let invoicePaid = 0;
  const next7 = Array(7).fill(0);
  const next7HasMissingCrew = Array(7).fill(false);

  for (const job of jobs) {
    const status = (job.status || '').toLowerCase();
    const hasDate = !!(job.targetDate || job.scheduledDate);
    const hasCrew = !!job.crewId;

    if (!hasDate || status === 'not scheduled') {
      notScheduled++;
    } else {
      scheduled++;
      if (!hasCrew) scheduledNoCrew++;

      const dateStr = job.targetDate || job.scheduledDate;
      const d = new Date(dateStr);
      if (!isNaN(d)) {
        for (let i = 0; i < 7; i++) {
          if (isSameDay(d, addDays(TODAY, i))) {
            next7[i]++;
            if (!hasCrew) next7HasMissingCrew[i] = true;
            break;
          }
        }
      }
    }

    if (!hasCrew) unassigned++;

    if (status === 'invoice ready') invoiceReady++;
    else if (status === 'invoice sent') invoiceSent++;
    else if (status === 'invoice paid' || status === 'completed') invoicePaid++;
  }

  return { total, scheduled, unassigned, notScheduled, scheduledNoCrew, invoiceReady, invoiceSent, invoicePaid, next7, next7HasMissingCrew };
}

const EMPTY = {
  total: 0, scheduled: 0, unassigned: 0, notScheduled: 0,
  scheduledNoCrew: 0, invoiceReady: 0, invoiceSent: 0, invoicePaid: 0,
  next7: Array(7).fill(0),
  next7HasMissingCrew: Array(7).fill(false),
};

export default function DashboardScreen() {
  const navigation = useNavigation();
  const { width }  = useWindowDimensions();
  const isPad      = Platform.OS === 'ios' && Platform.isPad;
  const [stats, setStats] = useState(EMPTY);
  const [refreshing, setRefreshing] = useState(false);
  const [jobs,      setJobs]      = useState([]);
  const [expenses,  setExpenses]  = useState([]);

  // Real-time Firestore subscriptions — no need for useFocusEffect
  useEffect(() => {
    const unsubJobs = subscribeJobs((data) => {
      setJobs(data);
      setStats(buildStats(data));
    });
    const unsubExp = subscribeExpenses((data) => setExpenses(data));
    return () => { unsubJobs(); unsubExp(); };
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const WEEK_DAYS = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(TODAY, i);
    return {
      short: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      num: d.getDate(),
      count: stats.next7[i],
      missingCrew: stats.next7HasMissingCrew[i],
      dateStr: dateToStr(d),
    };
  });

  const scheduledWithCrew = stats.scheduled - stats.scheduledNoCrew;

  const THREE_MONTHS = [-2, -1, 0].map((offset) => {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + offset, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    return {
      key,
      label: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
      isCurrent: offset === 0,
      stats: buildMonthStats(jobs, expenses, key),
    };
  });

  const navToJobs = (params) =>
    navigation.navigate('Jobs', { screen: 'JobsList', params });

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={isPad ? [styles.iPadWrapper, { maxWidth: Math.min(width - 32, 800) }] : null}>
        {/* Header */}
        <View style={styles.header}>
          <Image
            source={require('../../assets/Apollonia_new.png')}
            style={styles.logoImage}
          />
          <Text style={styles.headerDate}>{formatDate(TODAY)}</Text>
        </View>

        {/* Job Pipeline */}
        <SectionLabel title="Job Pipeline" />
        <View style={styles.threeRow}>
          <PipelineBox
            label="Not Scheduled"
            value={stats.notScheduled}
            accent="#6b7280"
            disabled={stats.notScheduled === 0}
            onPress={() => navToJobs({ filter: 'Not Scheduled' })}
          />
          <PipelineBox
            label="Scheduled"
            value={scheduledWithCrew}
            accent={colors.primary}
            disabled={scheduledWithCrew === 0}
            onPress={() => navToJobs({ filter: 'Scheduled' })}
          />
          <PipelineBox
            label="Sched / No Crew"
            value={stats.scheduledNoCrew}
            accent="#d97706"
            disabled={stats.scheduledNoCrew === 0}
            onPress={() => navToJobs({ filter: 'Unassigned' })}
          />
        </View>

        {/* Next 7 Days */}
        <SectionLabel title="Jobs for Next 7 Days" />
        <View style={styles.weekRow}>
          {WEEK_DAYS.map((d, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.dayBox, d.count > 0 && styles.dayBoxActive]}
              onPress={() => navToJobs({ date: d.dateStr, filter: 'All' })}
              activeOpacity={0.75}
            >
              <Text style={[styles.dayName, d.count > 0 && styles.dayNameActive]}>{d.short}</Text>
              <Text style={[styles.dayNum, d.count > 0 && styles.dayNumActive]}>{d.num}</Text>
              <View style={[styles.countBadge, d.count > 0 && styles.countBadgeActive]}>
                <Text style={[styles.countText, d.count > 0 && styles.countTextActive]}>{d.count}</Text>
              </View>
              {d.count > 0 && d.missingCrew && (
                <View style={styles.missingCrewDot} />
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* Invoicing */}
        <SectionLabel title="Invoicing" />
        <View style={styles.threeRow}>
          <InvoiceBox
            label="Invoice Ready"
            value={stats.invoiceReady}
            accent="#2563eb"
            disabled={stats.invoiceReady === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice ready' })}
          />
          <InvoiceBox
            label="Invoice Sent"
            value={stats.invoiceSent}
            accent="#d97706"
            disabled={stats.invoiceSent === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice sent' })}
          />
          <InvoiceBox
            label="Invoice Paid"
            value={stats.invoicePaid}
            accent={colors.primary}
            disabled={stats.invoicePaid === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice paid' })}
          />
        </View>

        {/* Financials */}
        <SectionLabel title="Financials" />
        <FinancialsTable
          months={THREE_MONTHS}
          onMonthPress={(monthKey) => navToJobs({ month: monthKey, filter: 'All' })}
        />

        <View style={{ height: 16 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionLabel({ title }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function PipelineBox({ label, value, accent, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.pipelineBox, disabled && styles.boxDisabled]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={disabled ? 1 : 0.72}
    >
      <Text style={[styles.pipelineValue, { color: disabled ? '#9ca3af' : accent }]}>{value}</Text>
      <Text style={styles.pipelineLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function InvoiceBox({ label, value, accent, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.invoiceBox, disabled && styles.boxDisabled]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={disabled ? 1 : 0.72}
    >
      <View style={[styles.invoiceAccentBar, { backgroundColor: disabled ? '#e5e7eb' : accent }]} />
      <Text style={[styles.invoiceValue, { color: disabled ? '#9ca3af' : accent }]}>{value}</Text>
      <Text style={styles.invoiceLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const FIN_ROWS = [
  { key: 'totalJobs', label: 'Total Jobs', fmt: (s) => String(s.totalJobs) },
  { key: 'jobsPaid',  label: 'Jobs Paid',  fmt: (s) => String(s.jobsPaid) },
  { key: 'invoiced',  label: 'Not Paid $', fmt: (s) => fmtK(s.invoiced) },
  { key: 'revenue',   label: 'Revenue',    fmt: (s) => fmtK(s.revenue) },
  { key: 'expTotal',  label: 'Expenses',   fmt: (s) => fmtK(s.expTotal) },
  { key: 'net',    label: 'Net $',    bold: true, fmt: (s) => fmtK(s.net),    getColor: (s) => s.net < 0 ? '#dc2626' : '#16a34a' },
  { key: 'margin', label: 'Margin %', fmt: (s) => s.margin === null ? 'N/A' : `${Math.round(s.margin)}%`, getColor: (s) => s.margin === null ? colors.textMuted : s.margin >= 0 ? '#16a34a' : '#dc2626' },
];

const H_HDR = 40;
const H_ROW = 26;
const H_DIV = 11;

function FinancialsTable({ months, onMonthPress }) {
  return (
    <View style={styles.finTable}>
      <View style={styles.finTableInner}>
        {/* Labels column */}
        <View style={styles.finLabels}>
          <View style={{ height: H_HDR }} />
          <View style={{ height: H_DIV }} />
          {FIN_ROWS.map((row, idx) =>
            !row ? (
              <View key={`d${idx}`} style={{ height: H_DIV }} />
            ) : (
              <View key={row.key} style={{ height: H_ROW, justifyContent: 'center' }}>
                <Text style={styles.finMetricLabel}>{row.label}</Text>
              </View>
            )
          )}
        </View>

        {/* Month column boxes */}
        {months.map((m) => {
          const disabled = m.stats.totalJobs === 0;
          return (
            <TouchableOpacity
              key={m.key}
              style={[
                styles.finMonthBox,
                m.isCurrent && styles.finMonthBoxCurrent,
                disabled && styles.finMonthBoxDisabled,
              ]}
              onPress={disabled ? undefined : () => onMonthPress(m.key)}
              activeOpacity={disabled ? 1 : 0.72}
            >
              <View style={{ height: H_HDR, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[styles.finMonthHeader, m.isCurrent && styles.finMonthHeaderCurrent]}>
                  {m.label}
                </Text>
                {m.isCurrent && <Text style={styles.finMtdLabel}>MTD</Text>}
              </View>

              <View style={{ height: H_DIV, justifyContent: 'center', paddingHorizontal: 6 }}>
                <View style={[styles.finBoxLine, m.isCurrent && { backgroundColor: '#86efac' }]} />
              </View>

              {FIN_ROWS.map((row, idx) => {
                if (!row) return (
                  <View key={`d${idx}`} style={{ height: H_DIV, justifyContent: 'center', paddingHorizontal: 6 }}>
                    <View style={[styles.finBoxLine, m.isCurrent && { backgroundColor: '#86efac' }]} />
                  </View>
                );
                const val   = row.fmt(m.stats);
                const color = row.getColor ? row.getColor(m.stats) : null;
                return (
                  <View key={row.key} style={{ height: H_ROW, alignItems: 'center', justifyContent: 'center' }}>
                    <Text
                      style={[
                        styles.finMetricValue,
                        row.bold && styles.finMetricValueBold,
                        color && !disabled ? { color } : null,
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
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16 },
  iPadWrapper: { alignSelf: 'center', width: '100%' },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  logoImage: { height: 50, width: 200, resizeMode: 'contain' },
  headerDate: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },

  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 10, letterSpacing: 0.2 },

  threeRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },

  pipelineBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  pipelineValue: { fontSize: 28, fontWeight: '800' },
  pipelineLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 4, textAlign: 'center', fontWeight: '500' },

  boxDisabled: { opacity: 0.42 },

  weekRow: { flexDirection: 'row', gap: 6, marginBottom: 20 },
  dayBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  dayBoxActive: { backgroundColor: colors.primary },
  dayName: { fontSize: 9, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase' },
  dayNameActive: { color: '#bbf7d0' },
  dayNum: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginTop: 2 },
  dayNumActive: { color: '#fff' },
  countBadge: {
    marginTop: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  countText: { fontSize: 10, fontWeight: '700', color: colors.textSecondary },
  countTextActive: { color: '#fff' },
  missingCrewDot: {
    marginTop: 4,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#dc2626',
  },

  invoiceBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  invoiceAccentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  invoiceValue: { fontSize: 28, fontWeight: '800', marginTop: 8 },
  invoiceLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 4, textAlign: 'center', fontWeight: '500' },

  finTable: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  finTableInner: { flexDirection: 'row', gap: 6 },
  finLabels: { width: 66 },
  finMonthBox: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  finMonthBoxCurrent: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  finMonthBoxDisabled: { opacity: 0.4 },
  finMonthHeader: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  finMonthHeaderCurrent: { color: colors.primary },
  finMtdLabel: { fontSize: 8, fontWeight: '700', color: colors.primary, letterSpacing: 0.5, marginTop: 1 },
  finBoxLine: { height: 1, backgroundColor: '#e5e7eb' },
  finMetricLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '500' },
  finMetricValue: { fontSize: 11, color: colors.textPrimary, fontWeight: '600', textAlign: 'center' },
  finMetricValueBold: { fontWeight: '800', fontSize: 12 },
});
