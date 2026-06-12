import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView,
  ScrollView, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useAppData } from '../context/AppDataContext';
import { colors } from '../theme/colors';
import { formatPhoneDisplay } from '../utils/phoneUtils';

function getCurrentWeekFriday() {
  const today = new Date();
  const day = today.getDay();
  const daysToFri = ((day - 5 + 7) % 7);
  const fri = new Date(today);
  fri.setDate(today.getDate() - daysToFri);
  fri.setHours(0, 0, 0, 0);
  return fri;
}

function isCurrentWeek(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return false;
  const fri = getCurrentWeekFriday();
  const thu = new Date(fri);
  thu.setDate(fri.getDate() + 6);
  thu.setHours(23, 59, 59, 999);
  return d >= fri && d <= thu;
}

function formatShortDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CrewsScreen() {
  const navigation = useNavigation();
  const { crews, activeJobs: jobs } = useAppData();
  const [refreshing, setRefreshing] = useState(false);

  // Derived: per-crew "most recent paid" date. Recomputes only when crews or
  // jobs actually change (the context references are stable across renders).
  const paidMap = useMemo(() => {
    const map = {};
    for (const crew of crews) {
      const paidJobs = jobs.filter(
        (j) => j.crewId === crew.id && j.crewPaidAt,
      );
      map[crew.id] = paidJobs.length === 0
        ? null
        : paidJobs.reduce((latest, j) => (j.crewPaidAt > latest ? j.crewPaidAt : latest), '');
    }
    return map;
  }, [crews, jobs]);

  // Pull-to-refresh is now a visual confirmation — context subscriptions are
  // already live, so the data is current. The brief spinner reassures the user.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 500);
  }, []);

  const openDetail = (crew) => navigation.navigate('CrewDetail', { crewId: crew.id });
  const openAdd    = ()     => navigation.navigate('CrewForm',   { crewId: null });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Crews</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {crews.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={52} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No crews yet</Text>
            <Text style={styles.emptySub}>Tap + to add your first crew.</Text>
          </View>
        ) : (
          crews.map((crew) => {
            // New crew model: crewSize is total headcount incl. lead.
            const crewSize    = crew.crewSize != null ? crew.crewSize : 1;
            const lastPaidAt  = paidMap[crew.id];
            const paidThisWeek = isCurrentWeek(lastPaidAt);

            return (
            <TouchableOpacity key={crew.id} style={styles.card} onPress={() => openDetail(crew)} activeOpacity={0.75}>
              <View style={styles.accentBar} />

              <View style={styles.cardInner}>
                <View style={styles.cardTop}>
                  <Text style={styles.crewName}>{crew.name}</Text>
                  <View style={styles.memberBadge}>
                    <Ionicons name="people" size={13} color={colors.primary} />
                    <Text style={styles.memberCount}>{crewSize}</Text>
                  </View>
                </View>

                {crew.lead?.name ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="person-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.metaText}>{crew.lead.name}</Text>
                  </View>
                ) : null}

                <View style={styles.metaRow}>
                  <Ionicons name="people-outline" size={13} color={colors.textMuted} />
                  <Text style={styles.metaText}>{crewSize} member{crewSize === 1 ? '' : 's'}</Text>
                </View>

                {crew.lead?.mobile ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="call-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.metaText}>{formatPhoneDisplay(crew.lead.mobile)}</Text>
                  </View>
                ) : null}

                <View style={styles.metaRow}>
                  <Ionicons
                    name={paidThisWeek ? 'checkmark-circle' : 'cash-outline'}
                    size={13}
                    color={paidThisWeek ? '#16a34a' : '#dc2626'}
                  />
                  {lastPaidAt ? (
                    <Text style={[styles.metaText, paidThisWeek ? styles.paidGreen : styles.paidRed]}>
                      {paidThisWeek ? '✓ ' : ''}{formatShortDate(lastPaidAt)}
                    </Text>
                  ) : (
                    <Text style={[styles.metaText, styles.paidRed]}>Never Paid</Text>
                  )}
                </View>

              </View>

              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={styles.chevron} />
            </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  addBtn: {
    backgroundColor: colors.primary,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },

  list: { padding: 16, gap: 12 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  accentBar: { width: 4, alignSelf: 'stretch', backgroundColor: colors.primary },
  cardInner: { flex: 1, padding: 14 },
  chevron: { paddingRight: 12 },

  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  crewName: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, flex: 1 },
  memberBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#f0fdf4', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  memberCount: { fontSize: 12, fontWeight: '700', color: colors.primary },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  metaText: { fontSize: 13, color: colors.textSecondary },
  paidGreen: { color: '#16a34a', fontWeight: '600' },
  paidRed:   { color: '#dc2626', fontWeight: '600' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary },
});
