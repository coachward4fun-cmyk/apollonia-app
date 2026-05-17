import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  TextInput,
  Platform,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { statusStyle } from '../theme/statusColors';
import { useAppData } from '../context/AppDataContext';
import { SkeletonCard } from '../components/SkeletonLoader';

const PAGE_SIZE = 25;

const FILTERS = ['All', 'Not Scheduled', 'Scheduled', 'Invoice Ready', 'Invoice Sent', 'Paid'];

function normalizeFilter(f) {
  if (!f) return null;
  const lf = (f || '').toLowerCase();
  if (lf === 'all') return 'All';
  if (lf === 'not scheduled') return 'Not Scheduled';
  if (lf === 'scheduled') return 'Scheduled';
  if (lf === 'scheduled with crew' || lf === 'scheduled / with crew') return 'Scheduled With Crew';
  if (lf === 'scheduled no crew'   || lf === 'scheduled / no crew' || lf === 'sched / no crew' || lf === 'unassigned') return 'Scheduled No Crew';
  if (lf === 'invoice ready') return 'Invoice Ready';
  if (lf === 'invoice sent') return 'Invoice Sent';
  if (lf === 'invoice paid' || lf === 'paid') return 'Paid';
  if (lf === 'invoice needed') return 'Invoice Needed';
  return 'All';
}


function jobMatchesFilter(job, filter) {
  const status  = (job.status || '').toLowerCase();
  const hasDate = !!(job.targetDate || job.scheduledDate);
  const hasCrew = !!job.crewId;
  if (filter === 'All') return true;
  if (filter === 'Not Scheduled')        return !hasDate || status === 'not scheduled';
  if (filter === 'Scheduled')            return status === 'scheduled' && hasDate;
  if (filter === 'Scheduled With Crew')  return hasDate && status !== 'not scheduled' && hasCrew;
  if (filter === 'Scheduled No Crew')    return hasDate && status !== 'not scheduled' && !hasCrew;
  if (filter === 'Invoice Ready') return status === 'invoice ready';
  if (filter === 'Invoice Sent')  return status === 'invoice sent';
  if (filter === 'Paid')          return status === 'invoice paid';
  if (filter === 'Invoice Needed') {
    const todayStr = new Date().toISOString().slice(0, 10);
    const excluded = new Set(['cancelled', 'invoice paid', 'invoice sent', 'invoice ready']);
    return !!job.targetDate && job.targetDate <= todayStr && !excluded.has(status);
  }
  return true;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function calcCrewPay(job) {
  if (job.leadDailyRate == null && job.helperDailyRate == null && job.workerDailyRate == null) return null;
  const leads   = (job.crewLeads   || 0) * (job.leadDailyRate   || 0);
  const helpers = (job.crewHelpers || 0) * (job.helperDailyRate || 0);
  const workers = (job.crewWorkers || 0) * (job.workerDailyRate || 0);
  return (leads + helpers + workers) * (parseFloat(job.estimatedDuration) || 1);
}

function fmtPay(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export default function JobsScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const { activeJobs: jobs, crews, jobsLoading: loading } = useAppData();

  const [filter,     setFilter]     = useState('All');
  const [search,     setSearch]     = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [monthFilter, setMonthFilter] = useState(null);
  const [dateFilter,  setDateFilter]  = useState(null);
  const [weekFilter,  setWeekFilter]  = useState(null); // { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  const [crewPayFilter, setCrewPayFilter] = useState(null); // null | 'paid' | 'unpaid'
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE); // kept for load-more footer

  // Apply filter from navigation params.
  // Behavior contract: ANY incoming nav param is treated as an atomic "reset
  // everything, then apply the new ones" — so a Dashboard tap always lands the
  // user on a clean view filtered only by what was tapped.
  useEffect(() => {
    const p = route.params || {};
    const hasIncoming =
      p.clearFilters != null ||
      p.filter       != null ||
      p.month        != null ||
      p.date         != null ||
      p.weekStart    != null ||
      p.weekEnd      != null ||
      p.crewPay      != null;
    if (!hasIncoming) return;

    setFilter(p.filter ? normalizeFilter(p.filter) : 'All');
    setDateFilter(p.date || null);
    setMonthFilter(p.month || null);
    setWeekFilter((p.weekStart && p.weekEnd) ? { start: p.weekStart, end: p.weekEnd } : null);
    setCrewPayFilter(p.crewPay || null);
    setSearch('');

    navigation.setParams({
      clearFilters: null,
      filter:       null,
      month:        null,
      date:         null,
      weekStart:    null,
      weekEnd:      null,
      crewPay:      null,
    });
  }, [
    route.params?.clearFilters,
    route.params?.filter,
    route.params?.month,
    route.params?.date,
    route.params?.weekStart,
    route.params?.weekEnd,
    route.params?.crewPay,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset pagination when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, search, dateFilter, monthFilter, weekFilter, crewPayFilter]);

  // Pull-to-refresh is a visual acknowledgement only — the jobs subscription
  // in AppDataContext is already live, so data is current. A short spinner
  // confirms the gesture without holding the list mid-flicker.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 300);
  }, []);

  // Status filter chip tap = atomic reset of all other filters + apply the new
  // status. Matches the Dashboard-tap contract so the chips always give a
  // clean filtered view with no leftover date / week / crew-pay / search.
  const selectStatusFilter = useCallback((next) => {
    setFilter(next);
    setDateFilter(null);
    setMonthFilter(null);
    setWeekFilter(null);
    setCrewPayFilter(null);
    setSearch('');
  }, []);

  const crewInfo = useCallback((crewId) => {
    const c = crews.find((c) => c.id === crewId);
    if (!c) return null;
    const leadCount = c.lead?.name?.trim() ? 1 : 0;
    const memberCount = (c.members || []).filter((m) => m.name?.trim()).length;
    return { name: c.name, count: leadCount + memberCount };
  }, [crews]);

  const sorted = useMemo(() => [...jobs].sort((a, b) => {
    if (!a.targetDate && !b.targetDate) return 0;
    if (!a.targetDate) return 1;
    if (!b.targetDate) return -1;
    return b.targetDate.localeCompare(a.targetDate);
  }), [jobs]);

  const filtered = useMemo(() => sorted.filter((job) => {
    // archivedForCustomer already filtered upstream via context's activeJobs
    if (weekFilter) {
      const d = job.targetDate || job.scheduledDate;
      if (!d || d < weekFilter.start || d > weekFilter.end) return false;
    }
    if (dateFilter && job.targetDate !== dateFilter) return false;
    if (monthFilter && !(job.targetDate || '').startsWith(monthFilter)) return false;
    if (crewPayFilter === 'paid'   && !job.crewPaidAt) return false;
    if (crewPayFilter === 'unpaid' && (!job.crewId || job.crewPaidAt)) return false;
    if (!jobMatchesFilter(job, filter)) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        (job.projectName || '').toLowerCase().includes(q) ||
        (job.billToName || '').toLowerCase().includes(q) ||
        (job.jobLocationAddress || '').toLowerCase().includes(q) ||
        (job.jobType || '').toLowerCase().includes(q)
      );
    }
    return true;
  }), [sorted, filter, search, dateFilter, monthFilter, weekFilter, crewPayFilter]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Jobs</Text>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>{jobs.length}</Text>
        </View>
        <TouchableOpacity
          style={styles.newJobBtn}
          onPress={() => navigation.navigate('JobForm', { jobId: null })}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.newJobBtnText}>New Job</Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search jobs, customers, addresses…"
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={styles.filterContent}>
        {FILTERS.map((f) => (
          <TouchableOpacity key={f} style={[styles.filterTab, filter === f && styles.filterTabActive]} onPress={() => selectStatusFilter(f)}>
            <Text style={[styles.filterTabText, filter === f && styles.filterTabTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Month filter banner */}
      {monthFilter ? (
        <View style={styles.monthFilterBanner}>
          <Ionicons name="calendar" size={13} color={colors.primary} />
          <Text style={styles.monthFilterText}>{getMonthLabel(monthFilter)}</Text>
          <TouchableOpacity onPress={() => setMonthFilter(null)}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Date filter banner */}
      {dateFilter ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="calendar" size={13} color="#2563eb" />
          <Text style={styles.dateFilterText}>Jobs on {formatDate(dateFilter)}</Text>
          <TouchableOpacity onPress={() => setDateFilter(null)}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Week filter banner */}
      {weekFilter ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="calendar" size={13} color="#2563eb" />
          <Text style={styles.dateFilterText}>{weekFilter.start} – {weekFilter.end}</Text>
          <TouchableOpacity onPress={() => setWeekFilter(null)}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Invoice Needed filter banner */}
      {filter === 'Invoice Needed' ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="alert-circle" size={13} color="#7c3aed" />
          <Text style={[styles.dateFilterText, { color: '#7c3aed' }]}>Invoice Needed — past target date, not invoiced</Text>
          <TouchableOpacity onPress={() => setFilter('All')}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Scheduled With/No Crew banner (hidden filters from Dashboard pipeline boxes) */}
      {filter === 'Scheduled With Crew' ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="people" size={13} color={colors.primary} />
          <Text style={[styles.dateFilterText, { color: colors.primary }]}>Scheduled — crew assigned</Text>
          <TouchableOpacity onPress={() => setFilter('All')}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}
      {filter === 'Scheduled No Crew' ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="alert-circle" size={13} color="#d97706" />
          <Text style={[styles.dateFilterText, { color: '#d97706' }]}>Scheduled — no crew assigned</Text>
          <TouchableOpacity onPress={() => setFilter('All')}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Crew pay filter banner */}
      {crewPayFilter ? (
        <View style={styles.dateFilterBanner}>
          <Ionicons name="cash-outline" size={13} color={crewPayFilter === 'paid' ? colors.primary : '#d97706'} />
          <Text style={[styles.dateFilterText, { color: crewPayFilter === 'paid' ? colors.primary : '#d97706' }]}>
            {crewPayFilter === 'paid' ? 'Crew already paid' : 'Crew not yet paid'}
          </Text>
          <TouchableOpacity onPress={() => setCrewPayFilter(null)}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* List */}
      {loading ? (
        <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
          {[0,1,2,3,4].map((i) => <SkeletonCard key={i} />)}
        </ScrollView>
      ) : (
        <FlatList
          data={filtered.slice(0, visibleCount)}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          windowSize={5}
          maxToRenderPerBatch={10}
          initialNumToRender={PAGE_SIZE}
          removeClippedSubviews
          onEndReachedThreshold={0.4}
          onEndReached={() => setVisibleCount((c) => c + PAGE_SIZE)}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="briefcase-outline" size={52} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No jobs found</Text>
              <Text style={styles.emptySub}>
                {jobs.length === 0
                  ? 'Import a backup in the Admin tab to load your jobs.'
                  : 'Try a different filter or search term.'}
              </Text>
            </View>
          }
          ListFooterComponent={<View style={{ height: 16 }} />}
          renderItem={({ item: job }) => {
            const sc       = statusStyle(job.status);
            const info     = crewInfo(job.crewId);
            const dateStr  = job.targetDate || job.scheduledDate;
            const hasDate  = !!dateStr;
            const crewPay  = info ? calcCrewPay(job) : null;
            const crewPaid = !!job.crewPaidAt;
            const crewColor = info ? (crewPaid ? '#16a34a' : '#dc2626') : '#dc2626';
            const hasPhotos = (job.photoCount > 0) || (job.photos && job.photos.length > 0);
            return (
              <View style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={styles.cardHeaderRow}>
                    {job.jobId ? (
                      <Text style={styles.jobIdLabel}>Job {job.jobId}</Text>
                    ) : null}
                    <View style={styles.cardTopRight}>
                      <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                        <Text style={[styles.statusText, { color: sc.fg }]}>{job.status || 'Active'}</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.editBtn}
                        onPress={() => navigation.navigate('JobForm', { jobId: job.id })}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Ionicons name="pencil-outline" size={14} color={colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <Text style={styles.jobTitle} numberOfLines={2}>{job.projectName || 'Untitled Job'}</Text>
                </View>

                {job.jobType ? (
                  <View style={styles.typePill}>
                    <Text style={styles.typeText}>{job.jobType}</Text>
                  </View>
                ) : null}

                {job.billToName ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="person-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.metaText}>{job.billToName}</Text>
                  </View>
                ) : null}

                {job.jobLocationAddress ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="location-outline" size={13} color="#2563eb" />
                    <Text style={styles.metaText} numberOfLines={1}>{job.jobLocationAddress}</Text>
                  </View>
                ) : null}

                <View style={styles.divider} />

                <View style={styles.cardBottom}>
                  <View style={styles.metaRow}>
                    <Ionicons
                      name={hasDate ? 'calendar-outline' : 'calendar-clear-outline'}
                      size={13}
                      color={hasDate ? colors.primary : colors.textMuted}
                    />
                    <Text style={[styles.metaText, !hasDate && styles.mutedText]}>
                      {hasDate ? formatDate(dateStr) : 'Not scheduled'}
                    </Text>
                  </View>

                  <View style={styles.metaRow}>
                    <Ionicons
                      name={info ? 'people-outline' : 'people-circle-outline'}
                      size={13}
                      color={crewColor}
                    />
                    {info ? (
                      <>
                        <Text style={[styles.metaText, { color: crewColor, fontWeight: '600' }]} numberOfLines={1}>
                          {info.name} ({info.count})
                        </Text>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: crewPay == null ? '#dc2626' : crewColor, marginLeft: 2 }}>
                          · {fmtPay(crewPay ?? 0)}{crewPaid ? ' (Paid)' : ''}
                        </Text>
                      </>
                    ) : (
                      <Text style={[styles.metaText, { color: '#dc2626', fontWeight: '600' }]}>
                        No Crew Assigned
                      </Text>
                    )}
                  </View>

                  <View style={styles.photosBadge}>
                    <Ionicons name="camera-outline" size={12} color={hasPhotos ? colors.textMuted : '#dc2626'} />
                    {hasPhotos && (
                      <Text style={styles.photosBadgeText}>{job.photoCount ?? job.photos.length}</Text>
                    )}
                  </View>

                  {job.invoiceTotal != null && (
                    <TouchableOpacity
                      onPress={() => navigation.navigate('Invoice', { preselectedJobId: job.id })}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.invoiceTotal, styles.invoiceTotalLink]}>
                        ${Number(job.invoiceTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  headerBadge: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  headerBadgeText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  newJobBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginLeft: 'auto',
  },
  newJobBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary },

  filterBar: { marginTop: 10, flexShrink: 0 },
  filterContent: { paddingHorizontal: 16, gap: 8, paddingVertical: 10, alignItems: 'center' },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterTabActive: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  filterTabText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, lineHeight: 18 },
  filterTabTextActive: { color: '#fff' },

  listContent: { padding: 16, gap: 12 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  cardTop: { marginBottom: 6 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 2 },
  cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  jobIdLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 2,
  },
  jobTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  statusText: { fontSize: 11, fontWeight: '700' },
  editBtn: {
    padding: 4,
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
  },

  typePill: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0fdf4',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 8,
  },
  typeText: { fontSize: 11, fontWeight: '600', color: colors.primary },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  metaText: { fontSize: 13, color: colors.textSecondary, flex: 1 },
  mutedText: { color: colors.textMuted },
  linkText: { color: '#2563eb', textDecorationLine: 'underline' },

  divider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 10 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  invoiceTotal: { marginLeft: 'auto', fontSize: 14, fontWeight: '700', color: colors.primary },
  invoiceTotalLink: { textDecorationLine: 'underline' },

  photosBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  photosBadgeText: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },

  emptyState: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 270 },

  loadMoreBtn: { alignItems: 'center', paddingVertical: 16 },
  loadMoreText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  monthFilterBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f0fdf4',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#bbf7d0',
  },
  monthFilterText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.primary },

  dateFilterBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#dbeafe',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#bfdbfe',
  },
  dateFilterText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#2563eb' },
});
