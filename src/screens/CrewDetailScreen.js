import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeCrews, subscribeJobs, subscribeExpenses, saveJob, saveExpense } from '../services/db';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';

// ── Week helpers (Friday → Thursday) ──────────────────────────────────────────

function getWeekRange(offset = 0) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = today.getDay();
  const daysToFri = (day + 2) % 7;
  const friday = new Date(today);
  friday.setDate(today.getDate() - daysToFri + offset * 7);
  const thursday = new Date(friday);
  thursday.setDate(friday.getDate() + 6);
  thursday.setHours(23, 59, 59, 999);
  return { start: friday, end: thursday };
}

function isInWeek(dateStr, { start, end }) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  return d >= start && d <= end;
}

function formatWeekLabel({ start, end }) {
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
}

function fmt$(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function CrewDetailScreen() {
  const navigation = useNavigation();
  const { crewId } = useRoute().params;

  const [crew, setCrew]         = useState(null);
  const [jobs, setJobs]         = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [paying, setPaying]     = useState(false);

  useEffect(() => {
    const unsubCrews = subscribeCrews((crewList) => {
      setCrew(crewList.find((c) => c.id === crewId) || null);
    });
    const unsubJobs = subscribeJobs((jobList) => {
      setJobs(jobList.filter((j) => j.crewId === crewId));
    });
    const unsubExp = subscribeExpenses(setExpenses);
    return () => { unsubCrews(); unsubJobs(); unsubExp(); };
  }, [crewId]);

  if (!crew) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  // ── Week data ──
  const week       = getWeekRange(weekOffset);
  const weekJobs   = jobs.filter((j) => isInWeek(j.targetDate || j.scheduledDate, week));
  const allPaid    = weekJobs.length > 0 && weekJobs.every((j) => j.crewPaid);

  const weekPay = weekJobs.reduce((sum, job) => {
    const jobPay = expenses
      .filter((e) => e.jobId === job.id && e.isCrewCost)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return sum + jobPay;
  }, 0);

  const jobPay = (jobId) =>
    expenses
      .filter((e) => e.jobId === jobId && e.isCrewCost)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // ── Pay crew ──
  const handlePayCrew = () => {
    if (weekJobs.length === 0) return;
    const unpaid = weekJobs.filter((j) => !j.crewPaid);
    if (unpaid.length === 0) { Alert.alert('Already Paid', 'All jobs this week are already marked as paid.'); return; }

    Alert.alert(
      'Pay Crew',
      `Mark ${unpaid.length} job${unpaid.length !== 1 ? 's' : ''} as crew-paid for ${formatWeekLabel(week)}?\n\nTotal: ${fmt$(weekPay)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm', style: 'default',
          onPress: async () => {
            try {
              setPaying(true);
              const today = new Date().toISOString().slice(0, 10);
              await Promise.all(
                unpaid.map((j) => saveJob({ ...j, crewPaid: true, crewPaidAt: today })),
              );
              if (weekPay > 0) {
                const newExp = {
                  id:          generateId(),
                  type:        'company',
                  date:        today,
                  amount:      weekPay,
                  category:    'Subcontractors & Labor',
                  description: `Crew Pay - ${crew.name} - ${formatWeekLabel(week)}`,
                  isCrewCost:  true,
                  addToInvoice: false,
                  createdAt:   today,
                };
                await saveExpense(newExp);
              }
              logActivity('crew_paid', `Paid crew: ${crew.name} - ${formatWeekLabel(week)} ($${weekPay})`);
              // subscriptions auto-update UI
            } catch (err) {
              Alert.alert('Error', 'Could not save payment: ' + err.message);
            } finally {
              setPaying(false);
            }
          },
        },
      ]
    );
  };

  // ── Render ──
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topNav}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Crews</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => navigation.navigate('CrewForm', { crewId: crew.id })}
          style={styles.editBtn}
        >
          <Text style={styles.editText}>Edit</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.crewHeader}>
          <View style={styles.crewAvatar}>
            <Text style={styles.crewAvatarText}>
              {(crew.name || 'C').charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.crewName}>{crew.name}</Text>
            <Text style={styles.crewSub}>{(crew.members || []).length} member{crew.members?.length !== 1 ? 's' : ''}</Text>
          </View>
        </View>

        <SectionTitle title="Lead" />
        <View style={styles.card}>
          <InfoRow icon="person"      label="Name"   value={crew.lead?.name}   />
          <InfoRow icon="call"        label="Mobile" value={crew.lead?.mobile} divider />
          <InfoRow icon="mail"        label="Email"  value={crew.lead?.email}  divider />
          {crew.lead?.comment ? (
            <InfoRow icon="chatbubble" label="Note"  value={crew.lead.comment} divider />
          ) : null}
        </View>

        <SectionTitle title="Members" />
        <View style={styles.card}>
          {(crew.members || []).length === 0 ? (
            <Text style={styles.noMembers}>No members added.</Text>
          ) : (
            (crew.members || []).map((m, i) => (
              <View key={i} style={[styles.memberRow, i > 0 && styles.memberDivider]}>
                <View style={styles.memberBullet} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.memberName}>{m.name || '—'}</Text>
                  {m.mobile ? <Text style={styles.memberSub}>{m.mobile}</Text> : null}
                </View>
              </View>
            ))
          )}
        </View>

        <SectionTitle title="Pay Crew" />

        <View style={styles.weekNav}>
          <TouchableOpacity onPress={() => setWeekOffset((o) => o - 1)} style={styles.weekArrow}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.weekLabel}>{formatWeekLabel(week)}</Text>
          <TouchableOpacity
            onPress={() => setWeekOffset((o) => o + 1)}
            style={styles.weekArrow}
            disabled={weekOffset >= 0}
          >
            <Ionicons name="chevron-forward" size={20} color={weekOffset >= 0 ? colors.textMuted : colors.primary} />
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          {weekJobs.length === 0 ? (
            <Text style={styles.noMembers}>No jobs scheduled this week.</Text>
          ) : (
            weekJobs.map((job, i) => {
              const pay = jobPay(job.id);
              return (
                <View key={job.id} style={[styles.jobRow, i > 0 && styles.memberDivider]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jobTitle} numberOfLines={1}>
                      {job.projectName || 'Untitled Job'}
                    </Text>
                    <Text style={styles.jobDate}>
                      {job.targetDate || job.scheduledDate || '—'}
                    </Text>
                  </View>
                  <View style={styles.jobRight}>
                    <Text style={styles.jobPay}>{pay > 0 ? fmt$(pay) : '—'}</Text>
                    {job.crewPaid && (
                      <View style={styles.paidBadge}>
                        <Text style={styles.paidBadgeText}>Paid</Text>
                      </View>
                    )}
                  </View>
                </View>
              );
            })
          )}

          {weekJobs.length > 0 && (
            <>
              <View style={styles.totalDivider} />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total crew pay</Text>
                <Text style={styles.totalAmount}>{fmt$(weekPay)}</Text>
              </View>
            </>
          )}
        </View>

        {weekJobs.length > 0 && (
          weekOffset < 0 ? (
            allPaid ? (
              <PaidSummary weekJobs={weekJobs} weekPay={weekPay} />
            ) : (
              <View style={styles.notPaidBanner}>
                <Ionicons name="alert-circle-outline" size={20} color="#dc2626" />
                <Text style={styles.notPaidText}>Not Paid</Text>
              </View>
            )
          ) : (
            <TouchableOpacity
              style={[styles.payBtn, (allPaid || paying) && styles.payBtnDisabled]}
              onPress={handlePayCrew}
              disabled={allPaid || paying}
            >
              {paying ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name={allPaid ? 'checkmark-circle' : 'cash-outline'} size={18} color="#fff" />
                  <Text style={styles.payBtnText}>{allPaid ? 'Crew Paid' : 'Pay Crew'}</Text>
                </>
              )}
            </TouchableOpacity>
          )
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionTitle({ title }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function PaidSummary({ weekJobs, weekPay }) {
  const paidAt = weekJobs.find((j) => j.crewPaid && j.crewPaidAt)?.crewPaidAt;
  const dateStr = paidAt
    ? new Date(paidAt + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  return (
    <View style={styles.paidSummaryBox}>
      <Ionicons name="checkmark-circle" size={22} color="#16a34a" />
      <Text style={styles.paidSummaryText}>
        Paid{dateStr ? ` ${dateStr}` : ''}{weekPay > 0 ? `: ${fmt$(weekPay)}` : ''}
      </Text>
    </View>
  );
}

function InfoRow({ icon, label, value, divider }) {
  return (
    <>
      {divider && <View style={styles.infoDivider} />}
      <View style={styles.infoRow}>
        <Ionicons name={`${icon}-outline`} size={15} color={colors.primary} style={styles.infoIcon} />
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue} numberOfLines={1}>{value || '—'}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16 },

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
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  editBtn: { paddingHorizontal: 4 },
  editText: { fontSize: 16, color: colors.primary, fontWeight: '600' },

  crewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  crewAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crewAvatarText: { fontSize: 24, fontWeight: '800', color: '#fff' },
  crewName: { fontSize: 18, fontWeight: '800', color: colors.textPrimary },
  crewSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 4,
    marginTop: 4,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },

  infoDivider: { height: 1, backgroundColor: '#f3f4f6' },
  infoRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 8 },
  infoIcon: { width: 20 },
  infoLabel: { width: 54, fontSize: 13, color: colors.textMuted, fontWeight: '500' },
  infoValue: { flex: 1, fontSize: 14, color: colors.textPrimary, fontWeight: '500', textAlign: 'right' },

  noMembers: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },

  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 10 },
  memberDivider: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  memberBullet: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  memberName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  memberSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  weekArrow: { padding: 6 },
  weekLabel: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },

  jobRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10 },
  jobTitle: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  jobDate: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  jobRight: { alignItems: 'flex-end', gap: 4 },
  jobPay: { fontSize: 14, fontWeight: '700', color: colors.primary },
  paidBadge: { backgroundColor: '#dcfce7', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  paidBadgeText: { fontSize: 10, fontWeight: '700', color: colors.primary },

  totalDivider: { height: 1, backgroundColor: '#e5e7eb', marginTop: 4 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  totalLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  totalAmount: { fontSize: 16, fontWeight: '800', color: colors.primary },

  payBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  payBtnDisabled: { backgroundColor: '#6b7280', shadowOpacity: 0 },
  payBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  paidSummaryBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f0fdf4',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  paidSummaryText: { fontSize: 16, fontWeight: '700', color: '#16a34a' },

  notPaidBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  notPaidText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },
});
