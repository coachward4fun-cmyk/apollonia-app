import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  TextInput,
  Linking,
} from 'react-native';
import { subscribeJobs, subscribeCrews } from '../services/db';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

const FILTERS = ['All', 'Not Scheduled', 'Scheduled', 'Invoice Ready', 'Invoice Sent', 'Paid'];

function normalizeFilter(f) {
  if (!f) return null;
  const lf = (f || '').toLowerCase();
  if (lf === 'all') return 'All';
  if (lf === 'not scheduled') return 'Not Scheduled';
  if (lf === 'scheduled') return 'Scheduled';
  if (lf === 'invoice ready') return 'Invoice Ready';
  if (lf === 'invoice sent') return 'Invoice Sent';
  if (lf === 'invoice paid' || lf === 'paid' || lf === 'completed') return 'Paid';
  return 'All';
}

const STATUS_COLORS = {
  'not scheduled':  { bg: '#f3f4f6', fg: '#6b7280' },
  'scheduled':      { bg: '#dbeafe', fg: '#2563eb' },
  'in progress':    { bg: '#dcfce7', fg: colors.primary },
  'invoice ready':  { bg: '#dbeafe', fg: '#2563eb' },
  'invoice sent':   { bg: '#fef3c7', fg: '#d97706' },
  'invoice paid':   { bg: '#dcfce7', fg: colors.primary },
  'completed':      { bg: '#f3f4f6', fg: '#6b7280' },
};

function statusStyle(status) {
  return STATUS_COLORS[(status || '').toLowerCase()] || { bg: '#f3f4f6', fg: '#6b7280' };
}

function jobMatchesFilter(job, filter) {
  const status  = (job.status || '').toLowerCase();
  const hasDate = !!(job.targetDate || job.scheduledDate);
  if (filter === 'All') return true;
  if (filter === 'Not Scheduled') return !hasDate || status === 'not scheduled';
  if (filter === 'Scheduled') return hasDate && status !== 'not scheduled';
  if (filter === 'Invoice Ready') return status === 'invoice ready';
  if (filter === 'Invoice Sent') return status === 'invoice sent';
  if (filter === 'Paid') return status === 'invoice paid' || status === 'completed';
  return true;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function openMapAddress(address) {
  const encoded = encodeURIComponent(address);
  Linking.openURL(`maps://maps.apple.com/?q=${encoded}`).catch(() => {
    Linking.openURL(`https://maps.apple.com/?q=${encoded}`).catch(() => {});
  });
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

  const [jobs,       setJobs]       = useState([]);
  const [crews,      setCrews]      = useState([]);
  const [filter,     setFilter]     = useState('All');
  const [search,     setSearch]     = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [monthFilter, setMonthFilter] = useState(null);
  const [dateFilter,  setDateFilter]  = useState(null);

  // Real-time Firestore subscriptions
  useEffect(() => {
    const unsubJobs  = subscribeJobs((data) => setJobs(data));
    const unsubCrews = subscribeCrews((data) => setCrews(data));
    return () => { unsubJobs(); unsubCrews(); };
  }, []);

  // Apply filter from navigation params
  useEffect(() => {
    const incoming      = route.params?.filter;
    const incomingMonth = route.params?.month;
    const incomingDate  = route.params?.date;
    if (incoming != null) {
      setFilter(normalizeFilter(incoming));
      navigation.setParams({ filter: null });
    }
    if (incomingMonth !== undefined && incomingMonth !== null) {
      setMonthFilter(incomingMonth || null);
      setDateFilter(null);
      if (incoming == null) setFilter('All');
      navigation.setParams({ month: null });
    }
    if (incomingDate) {
      setDateFilter(incomingDate);
      setMonthFilter(null);
      if (incoming == null) setFilter('All');
      navigation.setParams({ date: null });
    }
  }, [route.params?.filter, route.params?.month, route.params?.date]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const crewInfo = useCallback((crewId) => {
    const c = crews.find((c) => c.id === crewId);
    if (!c) return null;
    const leadCount = c.lead?.name?.trim() ? 1 : 0;
    const memberCount = (c.members || []).filter((m) => m.name?.trim()).length;
    return { name: c.name, count: leadCount + memberCount };
  }, [crews]);

  const sorted = [...jobs].sort((a, b) => {
    if (!a.targetDate && !b.targetDate) return 0;
    if (!a.targetDate) return 1;
    if (!b.targetDate) return -1;
    return b.targetDate.localeCompare(a.targetDate);
  });

  const filtered = sorted.filter((job) => {
    if (dateFilter && job.targetDate !== dateFilter) return false;
    if (monthFilter && !(job.targetDate || '').startsWith(monthFilter)) return false;
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
  });

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
          <TouchableOpacity key={f} style={[styles.filterTab, filter === f && styles.filterTabActive]} onPress={() => setFilter(f)}>
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

      {/* List */}
      <ScrollView
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {filtered.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="briefcase-outline" size={52} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No jobs found</Text>
            <Text style={styles.emptySub}>
              {jobs.length === 0
                ? 'Import a backup in the Admin tab to load your jobs.'
                : 'Try a different filter or search term.'}
            </Text>
          </View>
        ) : (
          filtered.map((job) => {
            const sc      = statusStyle(job.status);
            const info    = crewInfo(job.crewId);
            const dateStr = job.targetDate || job.scheduledDate;
            const hasDate = !!dateStr;

            return (
              <View key={job.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <Text style={styles.jobTitle} numberOfLines={2}>{job.projectName || 'Untitled Job'}</Text>
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
                  <TouchableOpacity style={styles.metaRow} onPress={() => openMapAddress(job.jobLocationAddress)} activeOpacity={0.7}>
                    <Ionicons name="location-outline" size={13} color="#2563eb" />
                    <Text style={[styles.metaText, styles.linkText]} numberOfLines={1}>{job.jobLocationAddress}</Text>
                  </TouchableOpacity>
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
                      color={info ? '#16a34a' : '#dc2626'}
                    />
                    {info ? (
                      <Text style={[styles.metaText, { color: '#16a34a', fontWeight: '600' }]}>
                        {info.name} ({info.count})
                      </Text>
                    ) : (
                      <Text style={[styles.metaText, { color: '#dc2626', fontWeight: '600' }]}>
                        No Crew Assigned
                      </Text>
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
          })
        )}
        <View style={{ height: 16 }} />
      </ScrollView>
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
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 8 },
  cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  jobTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.textPrimary },
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

  emptyState: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 270 },

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
