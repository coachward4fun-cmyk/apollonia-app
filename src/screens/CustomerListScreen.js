import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView,
  ScrollView, TouchableOpacity, RefreshControl, TextInput, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeCustomers, subscribeJobs, getCustomers, getJobs, saveCustomer, unarchiveCustomer } from '../services/db';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';

const PREDEFINED = ['Sam Ward', 'Kathleen Ward', 'Shamrock Roofing Nebraska'];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function CustomerListScreen() {
  const navigation = useNavigation();
  const [customersRaw,  setCustomersRaw]  = useState([]);
  const [jobs,          setJobs]          = useState([]);
  const [refreshing,    setRefreshing]    = useState(false);
  const [search,        setSearch]        = useState('');
  const [showArchived,  setShowArchived]  = useState(false);
  const [restoringName, setRestoringName] = useState(null);
  const seeded = useRef(false);

  const handleRestore = useCallback(async (customerName) => {
    setRestoringName(customerName);
    try {
      await unarchiveCustomer(customerName);
      logActivity('customer_restored', `Customer ${customerName} was restored`);
    } catch {
      // subscription will reflect the current state
    } finally {
      setRestoringName(null);
    }
  }, []);

  // Set up real-time subscriptions
  useEffect(() => {
    // Seed missing customers once on mount, then subscribe
    const seedAndSubscribe = async () => {
      try {
        const [savedCustomers, savedJobs] = await Promise.all([getCustomers(), getJobs()]);

        const customerMap = {};
        for (const c of savedCustomers) {
          if (c.name) customerMap[c.name] = c;
        }

        const toSave = [];

        for (const name of PREDEFINED) {
          if (!customerMap[name]) {
            const c = { id: generateId(), name, address: '', email: '', salesperson: '', updatedAt: new Date().toISOString() };
            customerMap[name] = c;
            toSave.push(c);
          }
        }

        for (const job of savedJobs) {
          const n = job.billToName?.trim();
          if (!n || customerMap[n]) continue;
          const c = {
            id:          generateId(),
            name:        n,
            address:     job.billToAddress || '',
            email:       job.email || '',
            salesperson: job.salesperson || '',
            updatedAt:   new Date().toISOString(),
          };
          customerMap[n] = c;
          toSave.push(c);
        }

        if (toSave.length > 0) {
          await Promise.all(toSave.map(saveCustomer));
        }
        seeded.current = true;
      } catch { /* non-blocking */ }
    };

    if (!seeded.current) {
      seedAndSubscribe();
    }

    const unsubCust = subscribeCustomers(setCustomersRaw);
    const unsubJobs = subscribeJobs(setJobs);
    return () => { unsubCust(); unsubJobs(); };
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const { activeCustomers, archivedCustomers } = useMemo(() => {
    const customerMap = {};
    for (const c of customersRaw) {
      if (c.name) customerMap[c.name] = c;
    }
    const jobCounts = {};
    for (const job of jobs) {
      const n = job.billToName?.trim();
      if (n) jobCounts[n] = (jobCounts[n] || 0) + 1;
    }
    const all = Object.values(customerMap)
      .map((c) => ({ ...c, jobCount: jobCounts[c.name] || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      activeCustomers:   all.filter((c) => !c.archived),
      archivedCustomers: all.filter((c) => c.archived),
    };
  }, [customersRaw, jobs]);

  const displayList = showArchived ? archivedCustomers : activeCustomers;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return displayList;
    return displayList.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q),
    );
  }, [displayList, search]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topNav}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Settings</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>{showArchived ? 'Archived' : 'Customers'}</Text>
        <TouchableOpacity
          style={styles.navRight}
          onPress={() => { setShowArchived((v) => !v); setSearch(''); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name={showArchived ? 'people-outline' : 'eye-off-outline'}
            size={19}
            color={showArchived ? colors.primary : archivedCustomers.length > 0 ? '#b45309' : colors.textMuted}
          />
          {!showArchived && archivedCustomers.length > 0 && (
            <View style={styles.archiveBadge}>
              <Text style={styles.archiveBadgeText}>{archivedCustomers.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={colors.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name, email, or address…"
          placeholderTextColor={colors.textMuted}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name={showArchived ? 'eye-off-outline' : 'person-circle-outline'} size={52} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {search ? 'No matches' : showArchived ? 'No archived customers' : 'No customers yet'}
            </Text>
            <Text style={styles.emptySub}>
              {search
                ? 'Try a different search term.'
                : showArchived
                  ? 'Hidden customers will appear here.'
                  : 'Customers are pulled from your job records.'}
            </Text>
          </View>
        ) : (
          filtered.map((c) => (
            <TouchableOpacity
              key={c.id || c.name}
              style={[styles.card, c.archived && styles.cardArchived]}
              onPress={() => navigation.navigate('CustomerEdit', { customerName: c.name })}
              activeOpacity={0.75}
            >
              <View style={[styles.avatar, c.archived && styles.avatarArchived]}>
                <Text style={styles.avatarText}>{c.name.charAt(0).toUpperCase()}</Text>
              </View>

              <View style={styles.cardBody}>
                <Text style={styles.customerName}>{c.name}</Text>
                {c.address ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="location-outline" size={12} color={colors.textMuted} />
                    <Text style={styles.metaText} numberOfLines={1}>{c.address}</Text>
                  </View>
                ) : null}
                {c.email ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="mail-outline" size={12} color={colors.textMuted} />
                    <Text style={styles.metaText} numberOfLines={1}>{c.email}</Text>
                  </View>
                ) : null}
                {c.salesperson ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="person-outline" size={12} color={colors.textMuted} />
                    <Text style={styles.metaText} numberOfLines={1}>{c.salesperson}</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.cardRight}>
                {c.archived ? (
                  <TouchableOpacity
                    style={styles.restoreBtn}
                    onPress={() => handleRestore(c.name)}
                    disabled={restoringName === c.name}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    {restoringName === c.name
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <>
                          <Ionicons name="eye-outline" size={13} color={colors.primary} />
                          <Text style={styles.restoreBtnText}>Restore</Text>
                        </>
                    }
                  </TouchableOpacity>
                ) : (
                  <>
                    <View style={styles.jobsBadge}>
                      <Ionicons name="construct-outline" size={11} color={colors.primary} />
                      <Text style={styles.jobsBadgeText}>{c.jobCount}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                  </>
                )}
              </View>
            </TouchableOpacity>
          ))
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  topNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, width: 80 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  navTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  navRight: { width: 80, alignItems: 'flex-end', justifyContent: 'center' },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: 6,
  },

  list: { padding: 16, gap: 10 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: { fontSize: 20, fontWeight: '800', color: '#fff' },
  cardBody: { flex: 1 },
  customerName: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 3 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: { fontSize: 12, color: colors.textSecondary, flex: 1 },

  cardRight: { alignItems: 'flex-end', gap: 6, flexShrink: 0 },
  jobsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  jobsBadgeText: { fontSize: 12, fontWeight: '700', color: colors.primary },

  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },

  cardArchived: { opacity: 0.72 },
  avatarArchived: { backgroundColor: '#9ca3af' },

  archiveBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#b45309',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  archiveBadgeText: { fontSize: 10, fontWeight: '800', color: '#fff' },

  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  restoreBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
});
