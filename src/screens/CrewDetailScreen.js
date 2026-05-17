import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeJobs, subscribeExpenses, saveJob, saveExpense } from '../services/db';
import { useAppData } from '../context/AppDataContext';
import { logActivity } from '../services/activityLog';
import { openInMaps } from '../utils/openInMaps';
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

  const { crews } = useAppData();
  const crew = crews.find((c) => c.id === crewId) || null;

  const [jobs,     setJobs]     = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [paying,   setPaying]   = useState(false);

  useEffect(() => {
    const unsubJobs = subscribeJobs((jobList) => {
      setJobs(jobList.filter((j) => j.crewId === crewId && !j.archivedForCustomer));
    });
    const unsubExp = subscribeExpenses(setExpenses);
    return () => { unsubJobs(); unsubExp(); };
  }, [crewId]);

  if (!crew) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  // ── Week data ──
  const week     = getWeekRange(weekOffset);
  const weekJobs = jobs.filter((j) => isInWeek(j.targetDate || j.scheduledDate, week));

  const jobPay = (job) => {
    if (job.crewCost != null && job.crewCost > 0) return job.crewCost;
    if (job.crewLeads != null || job.leadDailyRate != null) {
      const leads   = (job.crewLeads   || 0) * (job.leadDailyRate   || 0);
      const helpers = (job.crewHelpers || 0) * (job.helperDailyRate || 0);
      const workers = (job.crewWorkers || 0) * (job.workerDailyRate || 0);
      const days    = parseFloat(job.estimatedDuration) || 1;
      return (leads + helpers + workers) * days;
    }
    return null;
  };

  const totalCrewCost = weekJobs.reduce((sum, j) => sum + (jobPay(j) ?? 0), 0);
  const paidCrewCost  = weekJobs.filter((j) => !!j.crewPaidAt).reduce((sum, j) => sum + (jobPay(j) ?? 0), 0);
  const owedCrewCost  = totalCrewCost - paidCrewCost;

  // ── Pay crew ──
  const handlePayCrew = () => {
    const toPay = weekJobs.filter((j) => !j.crewPaidAt);
    if (toPay.length === 0 || owedCrewCost <= 0) return;

    Alert.alert(
      `Pay ${crew.name}`,
      `Pay ${fmt$(owedCrewCost)} for ${toPay.length} job${toPay.length !== 1 ? 's' : ''} in ${formatWeekLabel(week)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm', style: 'default',
          onPress: async () => {
            try {
              setPaying(true);
              const today = new Date().toISOString().slice(0, 10);
              await Promise.all(
                toPay.map((j) => saveJob({ ...j, crewPaid: true, crewPaidAt: today })),
              );
              if (owedCrewCost > 0) {
                await saveExpense({
                  id:           generateId(),
                  type:         'company',
                  date:         today,
                  amount:       owedCrewCost,
                  category:     'Subcontractors & Labor',
                  description:  `Crew Pay - ${crew.name} - ${formatWeekLabel(week)}`,
                  crewName:     crew.name,
                  isCrewCost:   true,
                  addToInvoice: false,
                  createdAt:    today,
                });
              }
              logActivity(
                'crew_paid',
                `Paid ${crew.name} ${fmt$(owedCrewCost)} for ${toPay.length} job${toPay.length !== 1 ? 's' : ''}`,
              );
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

        {/* Week navigation */}
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

        {/* Job list */}
        <View style={styles.card}>
          {weekJobs.length === 0 ? (
            <Text style={styles.noMembers}>No jobs scheduled this week.</Text>
          ) : (
            weekJobs.map((job, i) => {
              const pay    = jobPay(job);
              const isPaid = !!job.crewPaidAt;
              return (
                <View key={job.id} style={[styles.jobRow, i > 0 && styles.memberDivider]}>
                  <Ionicons
                    name={isPaid ? 'checkmark-circle' : 'close-circle'}
                    size={20}
                    color={isPaid ? '#16a34a' : '#dc2626'}
                    style={{ marginTop: 2 }}
                  />
                  <View style={{ flex: 1 }}>
                    {job.jobId ? (
                      <Text style={styles.jobIdLabel}>Job {job.jobId}</Text>
                    ) : null}
                    <Text style={styles.jobTitle} numberOfLines={1}>
                      {job.projectName || 'Untitled Job'}
                    </Text>
                    <Text style={styles.jobMeta} numberOfLines={1}>
                      {[job.targetDate, job.billToName].filter(Boolean).join(' · ')}
                    </Text>
                    {job.jobLocationAddress ? (
                      <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => openInMaps(job.jobLocationAddress)} activeOpacity={0.7}>
                        <Text style={[styles.jobMeta, { color: '#2563eb', flex: 1 }]} numberOfLines={1}>{job.jobLocationAddress}</Text>
                        <Ionicons name="earth-outline" size={13} color="#16a34a" />
                      </TouchableOpacity>
                    ) : null}
                    {job.status ? (
                      <View style={styles.statusChip}>
                        <Text style={styles.statusChipText}>{job.status}</Text>
                      </View>
                    ) : null}
                  </View>
                  {pay === null ? (
                    <Text style={styles.jobPayNotSet}>Cost Not Set</Text>
                  ) : (
                    <Text style={[styles.jobPay, isPaid ? styles.jobPayPaid : styles.jobPayOwed]}>
                      {fmt$(pay)}
                    </Text>
                  )}
                </View>
              );
            })
          )}
        </View>

        {/* Three totals */}
        {weekJobs.length > 0 && (
          <View style={styles.totalsCard}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total Crew $ All Jobs</Text>
              <Text style={styles.totalValue}>{fmt$(totalCrewCost)}</Text>
            </View>
            <View style={styles.totalDivider} />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>$ Paid to Crew</Text>
              <Text style={[styles.totalValue, styles.totalPaid]}>{fmt$(paidCrewCost)}</Text>
            </View>
            <View style={styles.totalDivider} />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabelOwed}>$ Owed to Crew</Text>
              <Text style={[styles.totalValue, owedCrewCost > 0 ? styles.totalOwed : styles.totalZero]}>
                {fmt$(owedCrewCost)}
              </Text>
            </View>
          </View>
        )}

        {/* Pay button */}
        {weekJobs.length > 0 && (
          <TouchableOpacity
            style={[styles.payBtn, (owedCrewCost <= 0 || paying) && styles.payBtnDisabled]}
            onPress={handlePayCrew}
            disabled={owedCrewCost <= 0 || paying}
          >
            {paying ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="cash-outline" size={18} color="#fff" />
                <Text style={styles.payBtnText}>
                  {owedCrewCost > 0 ? `Pay Crew ${fmt$(owedCrewCost)}` : 'Pay Crew'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionTitle({ title }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
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
    marginBottom: 12,
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

  jobRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    gap: 10,
  },
  jobIdLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 1,
  },
  jobTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  jobMeta:  { fontSize: 11, color: colors.textMuted, marginBottom: 1 },
  statusChip: {
    alignSelf: 'flex-start',
    backgroundColor: '#f3f4f6',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 4,
  },
  statusChipText: { fontSize: 10, fontWeight: '600', color: colors.textSecondary },
  jobPay:        { fontSize: 13, fontWeight: '700', marginTop: 2 },
  jobPayPaid:    { color: '#16a34a' },
  jobPayOwed:    { color: '#dc2626' },
  jobPayNotSet:  { fontSize: 11, fontWeight: '600', color: '#dc2626', marginTop: 2, textAlign: 'right' },

  totalsCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  totalDivider: { height: 1, backgroundColor: '#f3f4f6' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
  },
  totalLabel:     { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  totalLabelOwed: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  totalValue:     { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  totalPaid:      { color: '#16a34a' },
  totalOwed:      { color: '#dc2626', fontSize: 16 },
  totalZero:      { color: colors.textMuted },

  payBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    marginBottom: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  payBtnDisabled: { backgroundColor: '#9ca3af', shadowOpacity: 0 },
  payBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
