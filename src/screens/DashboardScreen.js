import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
  Modal,
  PanResponder,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAppData } from '../context/AppDataContext';

const TODAY = new Date();

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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

function buildCalendarDays(year, month, jobs) {
  const firstDay    = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstDay.getDay(); // 0=Sun

  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const jobMap   = {};
  for (const job of jobs) {
    const td = job.targetDate || '';
    if (!td.startsWith(monthStr)) continue;
    if (!jobMap[td]) jobMap[td] = { count: 0, allHaveCrew: true };
    jobMap[td].count++;
    if (!job.crewId) jobMap[td].allHaveCrew = false;
  }

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${monthStr}-${String(d).padStart(2, '0')}`;
    const info    = jobMap[dateStr];
    cells.push({ day: d, dateStr, count: info ? info.count : 0, allHaveCrew: info ? info.allHaveCrew : true });
  }
  return cells;
}

// Pay week runs Friday → Thursday
function getPayWeekRange() {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 5=Fri
  const daysSinceFri = (dow + 2) % 7;
  const fri = new Date(today);
  fri.setDate(today.getDate() - daysSinceFri);
  const thu = new Date(fri);
  thu.setDate(fri.getDate() + 6);
  return { start: dateToStr(fri), end: dateToStr(thu) };
}

function jobCrewPay(job) {
  if (job.crewCost != null && job.crewCost !== '') return Number(job.crewCost) || 0;
  const days = Number(job.estimatedDuration) || 1;
  return (
    (Number(job.crewLeads)   || 0) * (Number(job.leadDailyRate)   || 0) * days +
    (Number(job.crewHelpers) || 0) * (Number(job.helperDailyRate) || 0) * days +
    (Number(job.crewWorkers) || 0) * (Number(job.workerDailyRate) || 0) * days
  );
}

function localDateStr(i) {
  const d = new Date();
  d.setDate(d.getDate() + i);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Statuses that take a job out of the active pipeline. Used by the four
// Pipeline boxes (Not Scheduled / Scheduled / Sched No Crew / Crews No Job) —
// completed work doesn't represent upcoming labor or crew demand.
const COMPLETED_STATUSES = new Set([
  'invoice ready',
  'invoice sent',
  'invoice paid',
  'cancelled',
  'in progress',
  'paid',
]);

function buildStats(jobs) {
  const total = jobs.length;
  let scheduled = 0;
  let unassigned = 0;
  let notScheduled = 0;
  let scheduledNoCrew = 0;
  let invoiceNeeded = 0;
  let invoiceReady = 0;
  let invoiceSent = 0;
  let invoicePaid = 0;
  const next7 = Array(7).fill(0);
  const next7HasMissingCrew = Array(7).fill(false);

  // Build the 7 date strings once using local time (no UTC parsing)
  const next7DateStrs = Array.from({ length: 7 }, (_, i) => localDateStr(i));
  const todayStr = next7DateStrs[0];
  // 30-day window cutoff for the Invoice Paid box — local time to match the rest.
  const thirtyDaysAgoStr = localDateStr(-30);
  const invoiceNeededExcluded = new Set(['cancelled', 'invoice paid', 'invoice sent', 'invoice ready']);

  for (const job of jobs) {
    const status = (job.status || '').toLowerCase();
    const hasDate = !!(job.targetDate || job.scheduledDate);
    const hasCrew = !!job.crewId;

    // Pipeline counters — only jobs in an active status (blank, "Unknown",
    // "Not Scheduled", or "Scheduled") feed in. Completed states are skipped.
    if (!COMPLETED_STATUSES.has(status)) {
      if (!hasDate || status === 'not scheduled') {
        notScheduled++;
      } else {
        scheduled++;
        if (!hasCrew) scheduledNoCrew++;
      }
    }

    // Next-7-day counts must match what JobsScreen shows when filtered by date:
    // strictly job.targetDate, regardless of status. (Archived jobs are filtered
    // upstream in the subscribeJobs callback before buildStats is called.)
    const idx = next7DateStrs.indexOf(job.targetDate);
    if (idx !== -1) {
      next7[idx]++;
      if (!hasCrew) next7HasMissingCrew[idx] = true;
    }

    if (!hasCrew) unassigned++;

    if (job.targetDate && job.targetDate <= todayStr && !invoiceNeededExcluded.has(status)) invoiceNeeded++;
    if (status === 'invoice ready') invoiceReady++;
    else if (status === 'invoice sent') invoiceSent++;
    else if (status === 'invoice paid') {
      // Only count jobs whose targetDate falls in the last 30 days.
      if (job.targetDate && job.targetDate >= thirtyDaysAgoStr && job.targetDate <= todayStr) {
        invoicePaid++;
      }
    }
  }

  return { total, scheduled, unassigned, notScheduled, scheduledNoCrew, invoiceNeeded, invoiceReady, invoiceSent, invoicePaid, next7, next7HasMissingCrew };
}

export default function DashboardScreen() {
  const navigation = useNavigation();
  const { width }  = useWindowDimensions();
  const isPad      = Platform.OS === 'ios' && Platform.isPad;
  const { activeJobs: jobs, crews, customers, lastSync } = useAppData();
  const [refreshing,   setRefreshing]   = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

  const stats = useMemo(() => buildStats(jobs), [jobs]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const WEEK_DAYS = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return {
      short: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      num: d.getDate(),
      count: stats.next7[i],
      missingCrew: stats.next7HasMissingCrew[i],
      dateStr: localDateStr(i),
    };
  }), [stats]);

  const scheduledWithCrew = stats.scheduled - stats.scheduledNoCrew;

  // Crews with no upcoming work — used by the 4th Pipeline box.
  // "Busy" = assigned to a non-completed job with targetDate today-or-later.
  const crewsNoJob = useMemo(() => {
    const todayStr = localDateStr(0);
    const busyCrewIds = new Set(
      jobs
        .filter((j) =>
          j.targetDate >= todayStr &&
          !COMPLETED_STATUSES.has((j.status || '').toLowerCase())
        )
        .map((j) => j.crewId)
        .filter(Boolean)
    );
    return crews.filter((c) => !busyCrewIds.has(c.id)).length;
  }, [jobs, crews]);

  // Past-due invoices — jobs whose dueDate has passed (strictly < today) and
  // aren't paid or cancelled. Powers the dedicated Past Due box.
  const pastDueCount = useMemo(() => {
    const todayStr = localDateStr(0);
    return jobs.filter((j) => {
      if (!j.dueDate) return false;
      if (j.dueDate >= todayStr) return false;
      const s = (j.status || '').toLowerCase();
      return s !== 'invoice paid' && s !== 'cancelled';
    }).length;
  }, [jobs]);

  const { weekStart, weekEnd, weekJobs, weekPaidJobs, weekUnpaidJobs, weekCrewCost, weekPaidCost, weekUnpaidCost } = useMemo(() => {
    const { start, end } = getPayWeekRange();
    const todayStr = localDateStr(0);
    // Jobs This Week / Crews Paid: scoped to the current Fri→Thu pay week,
    // excluding cancelled work.
    const all = jobs.filter((j) =>
      j.targetDate &&
      j.targetDate >= start &&
      j.targetDate <= end &&
      (j.status || '').toLowerCase() !== 'cancelled'
    );
    const paid = all.filter((j) => j.crewPaidAt);
    // Crews to Pay: ALL past unpaid jobs with a crew assigned — including
    // weeks before this pay window so overdue payroll stays visible. Future
    // jobs are excluded since the work hasn't happened yet.
    const unpaid = jobs.filter((j) =>
      j.crewId &&
      !j.crewPaidAt &&
      j.targetDate &&
      j.targetDate <= todayStr &&
      (j.status || '').toLowerCase() !== 'cancelled'
    );
    return {
      weekStart:    start,
      weekEnd:      end,
      weekJobs:     all,
      weekPaidJobs: paid,
      weekUnpaidJobs: unpaid,
      weekCrewCost:   all.reduce((s, j) => s + jobCrewPay(j), 0),
      weekPaidCost:   paid.reduce((s, j) => s + jobCrewPay(j), 0),
      weekUnpaidCost: unpaid.reduce((s, j) => s + jobCrewPay(j), 0),
    };
  }, [jobs]);

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
        {lastSync ? (
          <Text style={styles.lastUpdated}>
            Updated: {lastSync.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </Text>
        ) : null}

        {/* Job Pipeline */}
        <SectionLabel title="Job Pipeline" />
        <View style={styles.fourRow}>
          <PipelineBox
            label="Scheduled"
            value={scheduledWithCrew}
            accent={colors.primary}
            disabled={scheduledWithCrew === 0}
            onPress={() => navToJobs({ filter: 'Scheduled With Crew' })}
          />
          <PipelineBox
            label="Not Scheduled"
            value={stats.notScheduled}
            accent="#6b7280"
            disabled={stats.notScheduled === 0}
            onPress={() => navToJobs({ filter: 'Not Scheduled' })}
          />
          <PipelineBox
            label="Sched / No Crew"
            value={stats.scheduledNoCrew}
            accent="#d97706"
            disabled={stats.scheduledNoCrew === 0}
            onPress={() => navToJobs({ filter: 'Scheduled No Crew' })}
          />
          <PipelineBox
            label="Crews no job"
            value={crewsNoJob}
            accent="#dc2626"
            disabled={crewsNoJob === 0}
            onPress={() => navToJobs({ filter: 'Scheduled No Crew' })}
          />
        </View>

        {/* Next 7 Days */}
        <SectionLabel title="Jobs for Next 7 Days" rightIcon="calendar" onRightIconPress={() => setShowCalendar(true)} />
        <View style={styles.weekRow}>
          {WEEK_DAYS.map((d, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.dayBox, d.count > 0 && styles.dayBoxActive]}
              onPress={() => navToJobs({ date: d.dateStr })}
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
        <View style={styles.fourRow}>
          <InvoiceBox
            label="Invoice Needed"
            value={stats.invoiceNeeded}
            accent="#7c3aed"
            compact
            disabled={stats.invoiceNeeded === 0}
            onPress={() => navToJobs({ filter: 'Invoice Needed' })}
          />
          <InvoiceBox
            label="Invoice Ready"
            value={stats.invoiceReady}
            accent="#2563eb"
            compact
            disabled={stats.invoiceReady === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice ready' })}
          />
          <InvoiceBox
            label="Invoice Sent"
            value={stats.invoiceSent}
            accent="#d97706"
            compact
            disabled={stats.invoiceSent === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice sent' })}
          />
          <InvoiceBox
            label="Invoice Paid"
            value={stats.invoicePaid}
            accent={colors.primary}
            compact
            disabled={stats.invoicePaid === 0}
            onPress={() => navigation.navigate('Invoice', { filter: 'invoice paid' })}
          />
        </View>

        {/* Past Due — its own row so the warning stands out */}
        <TouchableOpacity
          style={[styles.pastDueBox, pastDueCount === 0 && styles.pastDueBoxInactive]}
          onPress={() => navigation.navigate('Invoice', { filter: 'pastDue' })}
          activeOpacity={pastDueCount === 0 ? 1 : 0.72}
          disabled={pastDueCount === 0}
        >
          <View style={styles.pastDueLeft}>
            <Ionicons
              name="alert-circle"
              size={20}
              color={pastDueCount === 0 ? colors.textMuted : '#dc2626'}
            />
            <Text style={[styles.pastDueLabel, pastDueCount === 0 && styles.pastDueLabelInactive]}>
              Past Due
            </Text>
          </View>
          <Text style={[styles.pastDueValue, pastDueCount === 0 && styles.pastDueValueInactive]}>
            {pastDueCount}
          </Text>
        </TouchableOpacity>

        {/* Crew $ */}
        <SectionLabel title="Crew $" />
        <View style={styles.threeRow}>
          <CrewBox
            label="Jobs This Week"
            count={weekJobs.length}
            amount={weekCrewCost}
            accent="#6b7280"
            disabled={weekJobs.length === 0}
            onPress={() => navToJobs({ weekStart, weekEnd })}
          />
          <CrewBox
            label="Crews Paid"
            count={weekPaidJobs.length}
            amount={weekPaidCost}
            accent={colors.primary}
            disabled={weekPaidJobs.length === 0}
            onPress={() => navToJobs({ weekStart, weekEnd, crewPay: 'paid' })}
          />
          <CrewBox
            label="Crews to Pay"
            count={weekUnpaidJobs.length}
            amount={weekUnpaidCost}
            accent="#d97706"
            disabled={weekUnpaidJobs.length === 0}
            onPress={() => navToJobs({ weekStart, weekEnd, crewPay: 'unpaid' })}
          />
        </View>

        <SectionLabel title="Customers" />
        <View style={styles.threeRow}>
          <TouchableOpacity
            style={styles.pipelineBox}
            onPress={() => navigation.navigate('Admin', { screen: 'CustomerList' })}
            activeOpacity={0.72}
          >
            <Text style={[styles.pipelineValue, { color: colors.primary }]}>
              {customers.filter((c) => !c.archived).length}
            </Text>
            <Text style={styles.pipelineLabel}>Total Customers</Text>
          </TouchableOpacity>
        </View>

        {/* Reports — moved here from Admin so they're one tap from the dashboard. */}
        <SectionLabel title="Reports" />
        <View style={styles.reportsCard}>
          <ReportRow
            icon="stats-chart-outline"
            label="Financials"
            onPress={() => navigation.navigate('Admin', { screen: 'Financials' })}
          />
          <View style={styles.reportsDivider} />
          <ReportRow
            icon="bar-chart-outline"
            label="Revenue YTD"
            onPress={() => navigation.navigate('Admin', { screen: 'RevenueYTD' })}
          />
          <View style={styles.reportsDivider} />
          <ReportRow
            icon="people-outline"
            label="Crew Pay YTD"
            onPress={() => navigation.navigate('Admin', { screen: 'CrewPayYTD' })}
          />
          <View style={styles.reportsDivider} />
          <ReportRow
            icon="wallet-outline"
            label="Expenses YTD"
            onPress={() => navigation.navigate('Admin', { screen: 'ExpensesYTD' })}
          />
          <View style={styles.reportsDivider} />
          <ReportRow
            icon="time-outline"
            label="Activity Log"
            onPress={() => navigation.navigate('Admin', { screen: 'ActivityLog' })}
          />
        </View>

        <View style={{ height: 16 }} />
        </View>
      </ScrollView>

      <CalendarModal
        visible={showCalendar}
        jobs={jobs}
        onDayPress={(dateStr) => navToJobs({ date: dateStr })}
        onClose={() => setShowCalendar(false)}
      />
    </SafeAreaView>
  );
}

function SectionLabel({ title, rightIcon, onRightIconPress }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {rightIcon ? (
        <TouchableOpacity onPress={onRightIconPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name={rightIcon} size={18} color={colors.primary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// Disabled (zero-count) boxes render as a plain View — no TouchableOpacity, no
// press handler, no touch feedback. Clearly distinct grey "0" so the user can
// see it's inactive at a glance.

function PipelineBox({ label, value, accent, onPress, disabled }) {
  if (disabled) {
    return (
      <View style={[styles.pipelineBox, styles.boxInactive]}>
        <Text style={[styles.pipelineValue, styles.boxInactiveValue]}>0</Text>
        <Text style={[styles.pipelineLabel, styles.boxInactiveLabel]}>{label}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity style={styles.pipelineBox} onPress={onPress} activeOpacity={0.72}>
      <Text style={[styles.pipelineValue, { color: accent }]}>{value}</Text>
      <Text style={styles.pipelineLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function InvoiceBox({ label, value, accent, onPress, disabled, compact }) {
  if (disabled) {
    return (
      <View style={[styles.invoiceBox, styles.boxInactive]}>
        <View style={[styles.invoiceAccentBar, { backgroundColor: '#e5e7eb' }]} />
        <Text style={[styles.invoiceValue, compact && styles.invoiceValueCompact, styles.boxInactiveValue]}>0</Text>
        <Text style={[styles.invoiceLabel, compact && styles.invoiceLabelCompact, styles.boxInactiveLabel]}>{label}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity style={styles.invoiceBox} onPress={onPress} activeOpacity={0.72}>
      <View style={[styles.invoiceAccentBar, { backgroundColor: accent }]} />
      <Text style={[styles.invoiceValue, compact && styles.invoiceValueCompact, { color: accent }]}>{value}</Text>
      <Text style={[styles.invoiceLabel, compact && styles.invoiceLabelCompact]}>{label}</Text>
    </TouchableOpacity>
  );
}

function CrewBox({ label, count, amount, accent, onPress, disabled }) {
  if (disabled) {
    return (
      <View style={[styles.crewBox, styles.boxInactive]}>
        <View style={[styles.invoiceAccentBar, { backgroundColor: '#e5e7eb' }]} />
        <Text style={[styles.crewCount, styles.boxInactiveValue]}>0</Text>
        <Text style={[styles.crewAmount, { color: '#d1d5db' }]}>{fmtK(0)}</Text>
        <Text style={[styles.crewLabel, styles.boxInactiveLabel]}>{label}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity style={styles.crewBox} onPress={onPress} activeOpacity={0.72}>
      <View style={[styles.invoiceAccentBar, { backgroundColor: accent }]} />
      <Text style={[styles.crewCount, { color: accent }]}>{count}</Text>
      <Text style={[styles.crewAmount, { color: accent }]}>{fmtK(amount)}</Text>
      <Text style={styles.crewLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function ReportRow({ icon, label, onPress }) {
  return (
    <TouchableOpacity style={styles.reportRow} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.reportRowLeft}>
        <Ionicons name={icon} size={20} color={colors.primary} />
        <Text style={styles.reportRowLabel}>{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

// ── Calendar Modal ─────────────────────────────────────────────────────────────

function CalendarModal({ visible, jobs, onDayPress, onClose }) {
  const [monthOffset, setMonthOffset] = useState(0);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy),
      onPanResponderRelease: (_, { dx }) => {
        if      (dx >  60) setMonthOffset((m) => m - 1);
        else if (dx < -60) setMonthOffset((m) => m + 1);
      },
    })
  ).current;

  useEffect(() => {
    if (visible) setMonthOffset(0);
  }, [visible]);

  const now      = new Date();
  const viewDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year     = viewDate.getFullYear();
  const month    = viewDate.getMonth();
  const todayStr = dateToStr(now);
  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const cells = buildCalendarDays(year, month, jobs);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={calStyles.container}>
        {/* Header */}
        <View style={calStyles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={calStyles.monthNav}>
            <TouchableOpacity onPress={() => setMonthOffset((m) => m - 1)} style={calStyles.navBtn}>
              <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
            <Text style={calStyles.monthTitle}>{monthLabel}</Text>
            <TouchableOpacity onPress={() => setMonthOffset((m) => m + 1)} style={calStyles.navBtn}>
              <Ionicons name="chevron-forward" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <View style={{ width: 22 }} />
        </View>

        {/* Day-of-week header row */}
        <View style={calStyles.weekDayRow}>
          {['S','M','T','W','T','F','S'].map((d, i) => (
            <Text key={i} style={calStyles.weekDayLabel}>{d}</Text>
          ))}
        </View>

        {/* Calendar grid — horizontal swipe switches month */}
        <View style={calStyles.grid} {...panResponder.panHandlers}>
          {cells.map((cell, i) => {
            if (!cell) return <View key={`e${i}`} style={calStyles.cell} />;
            const hasJobs  = cell.count > 0;
            const isToday  = cell.dateStr === todayStr;
            const accent   = hasJobs ? (cell.allHaveCrew ? '#16a34a' : '#dc2626') : null;
            return (
              <TouchableOpacity
                key={cell.dateStr}
                style={[
                  calStyles.cell,
                  isToday && calStyles.cellToday,
                  hasJobs && { backgroundColor: cell.allHaveCrew ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)' },
                ]}
                onPress={hasJobs ? () => { onDayPress(cell.dateStr); onClose(); } : undefined}
                activeOpacity={hasJobs ? 0.7 : 1}
              >
                <Text style={[
                  calStyles.cellDay,
                  isToday && calStyles.cellDayToday,
                  hasJobs && { color: accent, fontWeight: '700' },
                ]}>
                  {cell.day}
                </Text>
                {hasJobs && (
                  <View style={[calStyles.jobBadge, { backgroundColor: accent }]}>
                    <Text style={calStyles.jobBadgeText}>{cell.count}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Legend */}
        <View style={calStyles.legend}>
          <View style={calStyles.legendItem}>
            <View style={[calStyles.legendDot, { backgroundColor: '#16a34a' }]} />
            <Text style={calStyles.legendLabel}>Crew assigned</Text>
          </View>
          <View style={calStyles.legendItem}>
            <View style={[calStyles.legendDot, { backgroundColor: '#dc2626' }]} />
            <Text style={calStyles.legendLabel}>Missing crew</Text>
          </View>
          <View style={calStyles.legendItem}>
            <View style={[calStyles.legendDot, { backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.primary }]} />
            <Text style={calStyles.legendLabel}>Today</Text>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const calStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  navBtn: { padding: 4 },
  monthTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, minWidth: 150, textAlign: 'center' },
  weekDayRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 4,
  },
  weekDayLabel: {
    width: '14.2857%',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  cell: {
    width: '14.2857%',
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    marginVertical: 1,
  },
  cellToday: {
    borderWidth: 2,
    borderColor: colors.primary,
  },
  cellDay: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '400',
  },
  cellDayToday: { color: colors.primary, fontWeight: '800' },
  jobBadge: {
    marginTop: 3,
    minWidth: 18,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jobBadgeText: { fontSize: 9, fontWeight: '800', color: '#fff' },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    marginTop: 4,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
});

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
  lastUpdated: { fontSize: 11, color: colors.textMuted, marginTop: 2, marginBottom: 12, textAlign: 'right' },

  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, letterSpacing: 0.2 },

  threeRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  fourRow:  { flexDirection: 'row', gap: 8,  marginBottom: 20 },

  // Past Due banner — full-width row beneath the 4 invoicing boxes.
  pastDueBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 20,
  },
  pastDueBoxInactive: {
    backgroundColor: '#f9fafb',
    borderColor: '#e5e7eb',
  },
  pastDueLeft:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pastDueLabel: { fontSize: 14, fontWeight: '700', color: '#991b1b', letterSpacing: 0.3 },
  pastDueLabelInactive: { color: colors.textMuted },
  pastDueValue: { fontSize: 22, fontWeight: '800', color: '#dc2626' },
  pastDueValueInactive: { color: '#9ca3af' },

  pipelineBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  pipelineValue: { fontSize: 28, fontWeight: '800' },
  pipelineLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 2, textAlign: 'center', fontWeight: '500' },

  boxInactive: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderStyle: 'dashed',
    shadowOpacity: 0,
    elevation: 0,
  },
  boxInactiveValue: { color: '#9ca3af' },
  boxInactiveLabel: { color: '#9ca3af' },

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
    paddingVertical: 8,
    paddingHorizontal: 10,
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
  invoiceValue: { fontSize: 28, fontWeight: '800', marginTop: 5 },
  invoiceValueCompact: { fontSize: 22, marginTop: 4 },
  invoiceLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 2, textAlign: 'center', fontWeight: '500' },
  invoiceLabelCompact: { fontSize: 9 },

  crewBox: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingTop: 11,
    paddingBottom: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  crewCount:  { fontSize: 22, fontWeight: '800', marginTop: 2 },
  crewAmount: { fontSize: 13, fontWeight: '700', marginTop: 1 },
  crewLabel:  { fontSize: 9, color: colors.textSecondary, marginTop: 2, textAlign: 'center', fontWeight: '500' },

  reportsCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 4,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  reportsDivider: { height: 1, backgroundColor: '#f3f4f6' },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  reportRowLeft:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reportRowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
});
