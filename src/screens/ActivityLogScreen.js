import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, FlatList,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { db } from '../config/firebase';
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs,
} from 'firebase/firestore';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

const PAGE_SIZE = 25;
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

function formatTimestamp(ts) {
  if (!ts) return { date: '—', time: '' };
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d)) return { date: '—', time: '' };
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
  };
}

function formatAction(action) {
  return (action || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ActivityLogScreen() {
  const navigation = useNavigation();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchPage = useCallback(async (after = null) => {
    try {
      const col = collection(db, 'activityLog');
      const cutoff = new Date(Date.now() - TEN_DAYS_MS);
      let q = query(col, where('timestamp', '>=', cutoff), orderBy('timestamp', 'desc'), limit(PAGE_SIZE));
      if (after) q = query(col, where('timestamp', '>=', cutoff), orderBy('timestamp', 'desc'), startAfter(after), limit(PAGE_SIZE));

      const HIDDEN_ACTIONS = new Set(['signed_in', 'signed_out', 'sign_in', 'sign_out']);
      const snap = await getDocs(q);
      const docs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((d) => !HIDDEN_ACTIONS.has(d.action));

      if (after) {
        setEntries((prev) => [...prev, ...docs]);
      } else {
        setEntries(docs);
      }

      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.warn('[ActivityLog] fetch error:', err.message);
    }
  }, []);

  useEffect(() => {
    fetchPage(null).finally(() => setLoading(false));
  }, [fetchPage]);

  const handleLoadMore = async () => {
    if (!hasMore || loadingMore || !lastDoc) return;
    setLoadingMore(true);
    await fetchPage(lastDoc);
    setLoadingMore(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Activity Log</Text>
        <View style={{ width: 34 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="time-outline" size={52} color={colors.textMuted} />
          <Text style={styles.emptyText}>No activity recorded yet</Text>
        </View>
      ) : (
        <View style={[styles.tableCard, { margin: 16, flex: 1 }]}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeadCell, { width: 90 }]}>Date / Time</Text>
            <Text style={[styles.tableHeadCell, { width: 60 }]}>User</Text>
            <Text style={[styles.tableHeadCell, { flex: 1 }]}>Activity</Text>
          </View>
          <FlatList
            data={entries}
            keyExtractor={(item) => item.id}
            windowSize={5}
            maxToRenderPerBatch={10}
            initialNumToRender={20}
            removeClippedSubviews
            onEndReachedThreshold={0.3}
            onEndReached={handleLoadMore}
            ListFooterComponent={
              loadingMore
                ? <ActivityIndicator size="small" color={colors.primary} style={{ paddingVertical: 14 }} />
                : hasMore
                  ? <TouchableOpacity style={styles.loadMoreBtn} onPress={handleLoadMore}>
                      <Text style={styles.loadMoreText}>Load More</Text>
                    </TouchableOpacity>
                  : <View style={{ height: 8 }} />
            }
            renderItem={({ item: entry, index }) => {
              const ts = formatTimestamp(entry.timestamp);
              return (
                <View style={[styles.tableRow, index === entries.length - 1 && !hasMore && styles.tableRowLast]}>
                  <View style={{ width: 90 }}>
                    <Text style={[styles.tableCell, styles.cellDate]}>{ts.date}</Text>
                    {ts.time ? <Text style={[styles.tableCell, styles.cellTime]}>{ts.time}</Text> : null}
                  </View>
                  <Text style={[styles.tableCell, styles.cellUser, { width: 60 }]} numberOfLines={1}>
                    {entry.userName || entry.userEmail?.split('@')[0] || '—'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.tableCell, styles.cellAction]}>
                      {formatAction(entry.action)}
                    </Text>
                    {entry.details ? (
                      <Text style={styles.cellDetails} numberOfLines={3}>{entry.details}</Text>
                    ) : null}
                  </View>
                </View>
              );
            }}
          />
        </View>
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
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tableHeadCell: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'flex-start',
  },
  tableRowLast: { borderBottomWidth: 0 },
  tableCell: { fontSize: 12, color: colors.textPrimary },
  cellDate: { color: colors.textSecondary, lineHeight: 17 },
  cellTime: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  cellUser: { fontWeight: '700', color: colors.primary },
  cellAction: { fontWeight: '600', color: colors.textPrimary },
  cellDetails: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  loadMoreText: { fontSize: 14, fontWeight: '600', color: colors.primary },
});
