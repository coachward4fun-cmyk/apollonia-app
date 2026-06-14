import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Modal, KeyboardAvoidingView, Platform, Alert, RefreshControl, ActivityIndicator, Image,
} from 'react-native';
import AppTextInput from '../components/AppTextInput';
import DatePickerField from '../components/DatePickerField';
import { sendInvoiceEmail } from '../utils/sendInvoiceEmail';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { saveJob, getExpenses, getJobTypes, subscribeCompanyProfile, getNextInvoiceNumber } from '../services/db';
import { useAppData } from '../context/AppDataContext';
import {
  today, addDays, formatDate, fmtWhole, fmtDecimal, lineTotal, calcTotals, detectTaxRate,
} from '../utils/invoiceFormat';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';
import { statusStyle } from '../theme/statusColors';
import { openInMaps } from '../utils/openInMaps';
import { formatPhoneDisplay } from '../utils/phoneUtils';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_LINE_ITEMS = [
  { description: 'Install new shingles (Squares)', qty: '0',  unitPrice: '80'  },
  { description: 'Remove all shingles down to deck',      qty: '1',  unitPrice: '0'   },
  { description: 'Remove extra layer of shingles',        qty: '0',  unitPrice: '15'  },
  { description: 'Replace plywood',                        qty: '0',  unitPrice: '15'  },
  { description: 'Dump Fee Total Cost',                    qty: '1',  unitPrice: '469' },
  { description: 'Destination Fee',                        qty: '1',  unitPrice: '0'   },
  { description: 'Clean up and haul away all debris',     qty: '1',  unitPrice: '0'   },
];


// Helpers live in src/utils/invoiceFormat.js.

// ── Main screen ────────────────────────────────────────────────────────────────

export default function InvoiceScreen() {
  const navigation   = useNavigation();
  const route        = useRoute();
  const { activeJobs: jobs, crews, customers } = useAppData();

  const [companyProfile, setCompanyProfile] = useState(null);
  const [refreshing,     setRefreshing]    = useState(false);
  const [showWizard,     setShowWizard]    = useState(false);
  const [showJobPicker,  setShowJobPicker] = useState(false);
  const [selectedJobId,  setSelectedJobId] = useState(null);
  const [statusFilter,   setStatusFilter]  = useState(null);
  const [invMode,        setInvMode]       = useState('all');
  const [invPage,        setInvPage]       = useState(1);

  useEffect(() => {
    const unsubProfile = subscribeCompanyProfile(setCompanyProfile);
    return () => { unsubProfile(); };
  }, []);

  useEffect(() => {
    const incoming = route.params?.filter;
    if (incoming !== undefined && incoming !== null) {
      setStatusFilter(incoming);
      navigation.setParams({ filter: null });
    }
  }, [route.params?.filter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const jobId = route.params?.preselectedJobId;
    if (!jobId || jobs.length === 0) return;
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    setSelectedJobId(jobId);
    setShowWizard(true);
    navigation.setParams({ preselectedJobId: null });
  }, [route.params?.preselectedJobId, jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setInvPage(1); }, [invMode, statusFilter]);

  // Reset any blocking state when the screen regains focus (e.g., returning
  // from Edit Job after saving line items). Without this, leftover modal /
  // loading state from the InvoiceWizard could leave the screen unscrollable.
  useFocusEffect(
    useCallback(() => {
      console.log('[InvoiceScreen] focus — state:', {
        refreshing,
        showWizard,
        showJobPicker,
        selectedJobId,
        statusFilter,
        invMode,
        invPage,
        preselectedJobId: route.params?.preselectedJobId ?? null,
      });
      setRefreshing(false);
      setShowJobPicker(false);
      // Do NOT reset showWizard / selectedJobId here — the preselectedJobId
      // effect below intentionally reopens the wizard when returning from
      // Edit Job, and we don't want to fight that.
    }, []) // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const crewMap = Object.fromEntries(crews.map((c) => [c.id, c.name]));

  const invoicedJobs = [...jobs]
    .filter((j) => !!j.invoiceNumber)
    .sort((a, b) => (b.invoiceDate || b.targetDate || '').localeCompare(a.invoiceDate || a.targetDate || ''));

  const modeFiltered = invMode === 'unpaid'
    ? invoicedJobs.filter((j) => {
        const s = (j.status || '').toLowerCase();
        return s !== 'invoice paid' && s !== 'cancelled';
      })
    : invMode === 'paid'
    ? invoicedJobs.filter((j) => (j.status || '').toLowerCase() === 'invoice paid')
    : invoicedJobs;

  // 'pastDue' is a date-based filter, not a status — show invoices whose
  // dueDate has passed and aren't yet paid or cancelled.
  const isPastDueFilter = statusFilter === 'pastDue';
  const todayStrLocal = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const displayedJobs = isPastDueFilter
    ? modeFiltered.filter((j) => {
        if (!j.dueDate) return false;
        if (j.dueDate >= todayStrLocal) return false;
        const s = (j.status || '').toLowerCase();
        return s !== 'invoice paid' && s !== 'cancelled';
      })
    : statusFilter
      ? modeFiltered.filter((j) => (j.status || '').toLowerCase() === statusFilter.toLowerCase())
      : modeFiltered;

  const visibleJobs = displayedJobs.slice(0, invPage * 25);
  const hasMoreJobs = visibleJobs.length < displayedJobs.length;

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;

  const handleEditJob = (jobId) => {
    setSelectedJobId(jobId);
    setShowWizard(true);
  };

  // Quick "Mark Paid" tap on an Invoice Sent card — confirms, writes, and lets
  // the live jobs subscription refresh the badge + button visibility.
  const handleMarkPaid = useCallback((job) => {
    Alert.alert(
      'Mark as Paid',
      `Mark "${job.projectName || 'this invoice'}" as paid?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark Paid',
          style: 'default',
          onPress: async () => {
            try {
              await saveJob({ id: job.id, status: 'Invoice Paid' });
              logActivity('invoice_paid', `Invoice paid — ${job.projectName || 'job'}${job.billToName ? ` (${job.billToName})` : ''}${job.jobId ? ` [${job.jobId}]` : ''}`);
            } catch (err) {
              Alert.alert('Error', err.message || 'Could not update invoice.');
            }
          },
        },
      ],
    );
  }, []);

  const handlePickerSelect = (job) => {
    setShowJobPicker(false);
    setSelectedJobId(job.id);
    setShowWizard(true);
  };

  const handleSaveInvoice = useCallback(async (updatedJob) => {
    try {
      await saveJob(updatedJob);
      logActivity('invoice_created', `Invoice #${updatedJob.invoiceNumber} for ${updatedJob.projectName || updatedJob.billToName || 'job'}`);
      setSelectedJobId(null);
      setShowWizard(false);
    } catch (err) {
      Alert.alert('Error', 'Could not save invoice: ' + err.message);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Invoices</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowJobPicker(true)}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={styles.invModeToggle}>
        <TouchableOpacity
          style={[styles.invModeBtn, invMode === 'all' && styles.invModeBtnActive]}
          onPress={() => setInvMode('all')}
        >
          <Text style={[styles.invModeBtnText, invMode === 'all' && styles.invModeBtnTextActive]}>All</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.invModeBtn, invMode === 'unpaid' && styles.invModeBtnActive]}
          onPress={() => setInvMode('unpaid')}
        >
          <Text style={[styles.invModeBtnText, invMode === 'unpaid' && styles.invModeBtnTextActive]}>Unpaid</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.invModeBtn, invMode === 'paid' && styles.invModeBtnActive]}
          onPress={() => setInvMode('paid')}
        >
          <Text style={[styles.invModeBtnText, invMode === 'paid' && styles.invModeBtnTextActive]}>Paid</Text>
        </TouchableOpacity>
      </View>

      {statusFilter ? (
        <View style={styles.filterBanner}>
          <Ionicons name="filter" size={13} color="#2563eb" />
          <Text style={styles.filterBannerText}>
            Filtered: {statusFilter === 'pastDue'
              ? 'Past Due Invoices'
              : statusFilter.replace(/\b\w/g, (c) => c.toUpperCase())}
          </Text>
          <TouchableOpacity onPress={() => setStatusFilter(null)} style={styles.filterBannerClear}>
            <Ionicons name="close-circle" size={15} color="#6b7280" />
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={styles.listContent}
      >
        {displayedJobs.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={52} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {invMode === 'unpaid' ? 'No unpaid invoices' : invMode === 'paid' ? 'No paid invoices' : 'No invoices yet'}
            </Text>
            <Text style={styles.emptySub}>
              {invMode === 'unpaid'
                ? 'All invoices are paid or cancelled.'
                : invMode === 'paid'
                ? 'No invoices have been marked as paid yet.'
                : 'Create an invoice by tapping +.'}
            </Text>
          </View>
        ) : (
          <>
            {visibleJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                crewName={crewMap[job.crewId] || null}
                onEdit={() => handleEditJob(job.id)}
                onMarkPaid={() => handleMarkPaid(job)}
                onViewInvoice={() => handleEditJob(job.id)}
              />
            ))}
            {hasMoreJobs && (
              <TouchableOpacity
                style={styles.loadMoreBtn}
                onPress={() => setInvPage((p) => p + 1)}
              >
                <Text style={styles.loadMoreText}>Load More</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <View style={{ height: 32 }} />
      </ScrollView>

      <JobPickerModal
        visible={showJobPicker}
        jobs={jobs}
        onSelect={handlePickerSelect}
        onClose={() => setShowJobPicker(false)}
      />

      <InvoiceWizard
        visible={showWizard}
        companyProfile={companyProfile}
        customers={customers}
        preselectedJob={selectedJob}
        onClose={() => { setShowWizard(false); setSelectedJobId(null); }}
        onSave={handleSaveInvoice}
        onEditJob={(jobId) => {
          setShowWizard(false);
          setSelectedJobId(null);
          navigation.navigate('Jobs', {
            screen: 'JobForm',
            params: { jobId, returnTo: 'invoicePreview' },
          });
        }}
      />
    </SafeAreaView>
  );
}

// ── JobCard ────────────────────────────────────────────────────────────────────

function JobCard({ job, crewName, onEdit, onMarkPaid, onViewInvoice }) {
  const sc           = statusStyle(job.status);
  const isInvoiced   = job.invoiceTotal != null;
  const hasPhotos    = Array.isArray(job.photos) && job.photos.length > 0;
  const statusLower  = (job.status || '').toLowerCase();
  const isReady      = statusLower === 'invoice ready';
  const isSent       = statusLower === 'invoice sent';
  const isPaid       = statusLower === 'invoice paid';
  // Mark Paid only makes sense on Invoice Sent — paid invoices can't pay again
  // and ready ones haven't been sent yet.
  const showMarkPaid     = isSent && !!onMarkPaid;
  // View Invoice shows whenever a PDF has been generated for this job AND the
  // status is in the invoice lifecycle. Same pill is available pre-pay and
  // post-pay so the user can always reopen the wizard/preview.
  const showViewInvoice  = (isReady || isSent || isPaid) && !!job.invoicePdfUrl && !!onViewInvoice;

  return (
    <View style={styles.jobCard}>
      <View style={styles.jobCardTop}>
        <View style={{ flex: 1 }}>
          {job.jobId ? <Text style={styles.jobIdLabel}>Job {job.jobId}</Text> : null}
          <Text style={styles.jobCardTitle} numberOfLines={1}>{job.projectName || 'Untitled'}</Text>
        </View>
        <View style={styles.jobCardTopRight}>
          {hasPhotos && (
            <Ionicons name="camera" size={15} color={colors.textMuted} style={{ marginRight: 6 }} />
          )}
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.fg }]}>{job.status || '—'}</Text>
          </View>
          <TouchableOpacity style={styles.editIconBtn} onPress={onEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="pencil-outline" size={16} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {job.billToName ? <Text style={styles.jobCardCustomer}>{job.billToName}</Text> : null}

      {crewName
        ? <Text style={[styles.jobCardCrew, { color: '#16a34a' }]}>{crewName}</Text>
        : <Text style={[styles.jobCardCrew, { color: '#dc2626' }]}>No Crew Assigned</Text>
      }

      {isInvoiced && (
        <View style={styles.invoiceSummaryRow}>
          <Ionicons name="document-text-outline" size={12} color={colors.textMuted} />
          <Text style={styles.invoiceSummaryText}>
            #{job.invoiceNumber}  ·  {formatDate(job.invoiceDate)}  ·  {fmtWhole(job.invoiceTotal)}
          </Text>
        </View>
      )}

      {(showMarkPaid || showViewInvoice) && (
        <View style={styles.invoiceActionsRow}>
          {showMarkPaid && (
            <TouchableOpacity style={styles.markPaidPill} onPress={onMarkPaid} activeOpacity={0.85}>
              <Ionicons name="checkmark-circle" size={14} color="#fff" />
              <Text style={styles.markPaidPillText}>Mark Paid</Text>
            </TouchableOpacity>
          )}
          {showViewInvoice && (
            <TouchableOpacity style={styles.viewInvoicePill} onPress={onViewInvoice} activeOpacity={0.85}>
              <Ionicons name="document-text-outline" size={14} color="#fff" />
              <Text style={styles.viewInvoicePillText}>View Invoice</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ── JobPickerModal ─────────────────────────────────────────────────────────────

function JobPickerModal({ visible, jobs, onSelect, onClose }) {
  const selectableJobs = [...jobs]
    .filter((j) => {
      const s = (j.status || '').toLowerCase();
      return s !== 'invoice paid' && s !== 'cancelled';
    })
    .sort((a, b) => {
      if (!a.targetDate && !b.targetDate) return 0;
      if (!a.targetDate) return 1;
      if (!b.targetDate) return -1;
      return b.targetDate.localeCompare(a.targetDate);
    });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.pickerContainer}>
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>Select Job</Text>
          <TouchableOpacity onPress={onClose} style={styles.pickerClose}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.pickerList} showsVerticalScrollIndicator={false}>
          {selectableJobs.length === 0 ? (
            <View style={styles.pickerEmpty}>
              <Ionicons name="briefcase-outline" size={48} color={colors.textMuted} />
              <Text style={styles.pickerEmptyTitle}>No eligible jobs</Text>
              <Text style={styles.pickerEmptySub}>Jobs with unpaid status will appear here.</Text>
            </View>
          ) : (
            selectableJobs.map((job) => {
              const sc = statusStyle(job.status);
              return (
                <TouchableOpacity
                  key={job.id}
                  style={styles.pickerJobCard}
                  onPress={() => onSelect(job)}
                  activeOpacity={0.75}
                >
                  <View style={styles.pickerJobTop}>
                    <View style={{ flex: 1 }}>
                      {job.jobId ? <Text style={styles.pickerJobIdLabel}>Job {job.jobId}</Text> : null}
                      <Text style={styles.pickerJobTitle} numberOfLines={1}>
                        {job.projectName || 'Untitled Job'}
                      </Text>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                      <Text style={[styles.statusText, { color: sc.fg }]}>{job.status || '—'}</Text>
                    </View>
                  </View>
                  {job.billToName ? (
                    <Text style={styles.pickerJobCustomer}>{job.billToName}</Text>
                  ) : null}
                  {job.targetDate ? (
                    <View style={styles.pickerJobDateRow}>
                      <Ionicons name="calendar-outline" size={12} color={colors.textMuted} />
                      <Text style={styles.pickerJobDate}>{formatDate(job.targetDate)}</Text>
                    </View>
                  ) : (
                    <Text style={styles.pickerJobDateMuted}>No target date</Text>
                  )}
                </TouchableOpacity>
              );
            })
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── InvoiceWizard ──────────────────────────────────────────────────────────────

function InvoiceWizard({ visible, companyProfile, customers = [], preselectedJob, onClose, onSave, onEditJob }) {
  const [step,      setStep]      = useState(2);
  const [selJob,    setSelJob]    = useState(null);
  const [invNumber, setInvNumber] = useState('');
  const [invDate,   setInvDate]   = useState(today());
  const [dueDate,   setDueDate]   = useState(addDays(today(), 30));
  const [taxRate,   setTaxRate]   = useState('0');
  const [taxLabel,  setTaxLabel]  = useState('');
  const [lineItems, setLineItems] = useState(DEFAULT_LINE_ITEMS.map((i) => ({ ...i })));
  const [saving,       setSaving]       = useState(false);
  const [sending,      setSending]      = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [sendProgress,    setSendProgress]    = useState({ done: 0, total: 0 });
  const [toast,        setToast]        = useState('');
  const [fixedInvoice, setFixedInvoice] = useState(false);
  const scrollRef = useRef(null);
  const isPaid = (selJob?.status || '').toLowerCase() === 'invoice paid';

  useEffect(() => {
    if (!visible || !preselectedJob) return;

    const init = async () => {
      // Clear any blocking state left over from a prior wizard session. The
      // parent can flip `visible` to false without calling handleClose (e.g.,
      // when the user taps "Edit Job"), so reset() is bypassed and stale
      // confirm modals / spinners / toasts would otherwise persist and lock
      // the UI when the wizard reopens.
      setSaving(false);
      setSending(false);
      setShowSendConfirm(false);
      setSendProgress({ done: 0, total: 0 });
      setToast('');
      setFixedInvoice(false);

      setSelJob(preselectedJob);
      setStep(2);

      let nextNum = preselectedJob.invoiceNumber;
      if (!nextNum) {
        try {
          nextNum = await getNextInvoiceNumber();
        } catch (err) {
          console.warn('[Invoice] getNextInvoiceNumber failed:', err.message);
          nextNum = '';
        }
      }
      setInvNumber(nextNum);
      setInvDate(preselectedJob.invoiceDate || today());
      setDueDate(preselectedJob.dueDate || addDays(today(), 30));

      const customer = customers.find((c) => c.name === preselectedJob.billToName);
      const isRetail = customer?.retail === true; // unset/false/undefined = non-retail
      const detected = detectTaxRate(preselectedJob.jobLocationAddress, companyProfile?.taxRates);
      // Non-retail customers are always tax-exempt (Real Property improvement),
      // so force 0% regardless of any stale taxRate saved on the job from a
      // prior default. Only retail customers inherit the detected/saved rate.
      let savedRate;
      let savedLabel;
      if (isRetail) {
        savedRate  = preselectedJob.taxRate  != null ? preselectedJob.taxRate  : detected.rate;
        savedLabel = preselectedJob.taxLabel != null ? preselectedJob.taxLabel : detected.label;
      } else {
        savedRate  = 0;
        savedLabel = '';
      }
      setTaxRate(String(savedRate));
      setTaxLabel(savedLabel);

      if (preselectedJob.lineItems && preselectedJob.lineItems.length > 0) {
        setLineItems(preselectedJob.lineItems.map((i) => ({
          description: i.description,
          qty:         String(i.qty ?? 0),
          unitPrice:   String(i.unitPrice ?? 0),
        })));
        return;
      }

      let baseItems = [];
      if (preselectedJob.jobType) {
        try {
          const allTypes = await getJobTypes();
          const lName = (preselectedJob.jobType || '').toLowerCase();
          const typeConfig = allTypes.find((t) => (t.name || '').toLowerCase() === lName);
          if (typeConfig && typeConfig.lineItems && typeConfig.lineItems.length > 0) {
            baseItems = typeConfig.lineItems.map((i) => ({
              description: i.description,
              qty:         String(i.qty ?? 0),
              unitPrice:   String(i.unitPrice ?? 0),
            }));
          }
        } catch { /* fall through with empty base */ }
      }

      try {
        const allExp = await getExpenses();
        const jobExp = allExp.filter(
          (e) => e.jobId === preselectedJob.id && e.addToInvoice === true,
        );
        const expItems = jobExp.map((e) => ({
          description: e.description || e.category || 'Expense',
          qty:         '1',
          unitPrice:   String(e.amount || 0),
          _isExpense:  true,
          _expenseId:  e.id,
        }));
        setLineItems([...baseItems, ...expItems]);
      } catch {
        setLineItems(baseItems);
      }
    };

    init();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    setStep(2);
    setInvNumber('');
    setInvDate(today());
    setDueDate(addDays(today(), 30));
    setTaxRate('0');
    setTaxLabel('');
    setLineItems(DEFAULT_LINE_ITEMS.map((i) => ({ ...i })));
    setSaving(false);
    setSending(false);
    setToast('');
    setFixedInvoice(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleNext = () => {
    if (step === 2) {
      if (!isPaid && !invNumber.trim()) { Alert.alert('Required', 'Enter an invoice number.'); return; }
      if (fixedInvoice) {
        // Jump straight to preview — line items are carried over from original invoice.
        // Back from preview goes to step 3 (line items) so they can still be edited.
        const updatedJob = buildUpdatedJob('Invoice Ready');
        setSelJob(updatedJob);
        saveJob(updatedJob).catch((err) => {
          console.warn('[Invoice] interim save failed:', err.message);
          setToast(`Save failed — ${err.message || 'try again on the next step'}`);
          setTimeout(() => setToast(''), 3500);
        });
        setStep(4);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
        return;
      }
    }
    if (step === 3 && !isPaid) {
      const updatedJob = buildUpdatedJob('Invoice Ready');
      setSelJob(updatedJob);
      saveJob(updatedJob).catch((err) => {
        console.warn('[Invoice] interim save failed:', err.message);
        setToast(`Save failed — ${err.message || 'try again on the next step'}`);
        setTimeout(() => setToast(''), 3500);
      });
    }
    setStep((s) => s + 1);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const handleBack = () => {
    if (step === 2) { handleClose(); return; }
    setStep((s) => s - 1);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const handleSaveAndReturn = async () => {
    if (!selJob) return;
    const taxRateNum = parseFloat(taxRate) || 0;
    const cleanItems = lineItems.map((i) => ({
      description: i.description,
      qty:         parseFloat(i.qty) || 0,
      unitPrice:   parseFloat(i.unitPrice) || 0,
    }));
    try {
      await saveJob({ ...selJob, lineItems: cleanItems, taxRate: taxRateNum });
      setToast('Line items saved');
      setTimeout(handleClose, 1200);
    } catch (err) {
      Alert.alert('Error', 'Could not save line items: ' + err.message);
    }
  };

  const updateItem = (index, field, value) => {
    setLineItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  const removeItem = (index) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFixInvoice = useCallback(() => {
    if (!selJob) return;
    const newNum = invNumber + 'C';
    Alert.alert(
      'Create Corrected Invoice',
      `Create corrected invoice "${newNum}" with today's date, ready to edit and resend?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async () => {
            const newInvDate = today();
            const newDueDate = addDays(today(), 30);
            const correctedJob = {
              ...selJob,
              status:        'Invoice Ready',
              invoiceNumber: newNum,
              invoiceDate:   newInvDate,
              dueDate:       newDueDate,
            };
            setInvNumber(newNum);
            setInvDate(newInvDate);
            setDueDate(newDueDate);
            setSelJob(correctedJob);
            setFixedInvoice(true);
            try {
              await saveJob(correctedJob);
              logActivity('invoice_corrected', `Corrected invoice ${invNumber} → ${newNum} for ${selJob.projectName || selJob.billToName || 'job'}`);
            } catch (err) {
              Alert.alert('Error', 'Could not create corrected invoice: ' + err.message);
            }
          },
        },
      ],
    );
  }, [selJob, invNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildUpdatedJob = (status = 'Invoice Ready') => {
    const taxRateNum = parseFloat(taxRate) || 0;
    const { total } = calcTotals(lineItems, taxRateNum);
    return {
      ...selJob,
      status,
      invoiceNumber: invNumber.trim(),
      invoiceDate:   invDate,
      dueDate:       dueDate,
      taxRate:       taxRateNum,
      taxLabel:      taxLabel,
      invoiceTotal:  Math.round(total * 100) / 100,
      lineItems:     lineItems.map((i) => ({
        description: i.description,
        qty:         parseFloat(i.qty) || 0,
        unitPrice:   parseFloat(i.unitPrice) || 0,
      })),
    };
  };

  const handleSave = async () => {
    if (!selJob) return;
    if (isPaid) { reset(); onClose(); return; }
    setSaving(true);
    try {
      const saveDate   = today();
      const updatedJob = { ...buildUpdatedJob('Invoice Ready'), invoiceDate: saveDate, dueDate: addDays(saveDate, 30) };
      await saveJob(updatedJob);
      logActivity('invoice_created', `Invoice #${invNumber.trim()} for ${selJob.projectName || selJob.billToName || 'job'}`);
      setSaving(false);
      setToast('Invoice saved');
      setTimeout(() => { reset(); onClose(); }, 1500);
    } catch (err) {
      setSaving(false);
      Alert.alert('Error', 'Could not save invoice: ' + err.message);
    }
  };

  // Pre-flight: validate email then open the send confirmation modal. No
  // network calls happen until the user explicitly confirms.
  const handleSaveAndSend = () => {
    if (!selJob) return;
    if (!selJob.email) {
      Alert.alert('No Email Address', 'This customer has no email address on file. Add one to the job before sending.');
      return;
    }
    setShowSendConfirm(true);
  };

  // Actual send — called from the confirmation modal's "Send to Customer" button.
  const executeSendInvoice = async () => {
    if (!selJob) return;
    setShowSendConfirm(false);
    setSending(true);
    setSendProgress({ done: 0, total: 0 });
    const onProgress = (done, total) => setSendProgress({ done, total });

    if (isPaid) {
      // Resend locked invoice with exact saved values — no date override, no status change
      try {
        const sendResult = await sendInvoiceEmail(
          selJob,
          selJob.invoiceNumber || '',
          selJob.invoiceDate   || '',
          selJob.dueDate       || '',
          selJob.lineItems     || [],
          { onProgress },
        );
        if (sendResult?.pdfUrl) {
          await saveJob({
            id: selJob.id,
            invoicePdfUrl:        sendResult.pdfUrl,
            invoicePdfUploadedAt: new Date().toISOString(),
          });
        }
        setSending(false);
        setToast('Invoice resent');
        setTimeout(() => { reset(); onClose(); }, 2200);
      } catch (err) {
        setSending(false);
        Alert.alert('Email Failed', err.message || 'Could not send the email.');
      }
      return;
    }
    const saveDate    = today();
    const saveDue     = addDays(saveDate, 30);
    const invoiceData = { ...buildUpdatedJob('Invoice Ready'), invoiceDate: saveDate, dueDate: saveDue };
    try {
      // Send email first — only save if email succeeds
      const sendResult = await sendInvoiceEmail(invoiceData, invNumber.trim(), saveDate, saveDue, invoiceData.lineItems, { onProgress });
      // Email succeeded — save with Invoice Sent status (and the PDF URL if upload worked)
      const sentJob = {
        ...invoiceData,
        status: 'Invoice Sent',
        ...(sendResult?.pdfUrl
          ? { invoicePdfUrl: sendResult.pdfUrl, invoicePdfUploadedAt: new Date().toISOString() }
          : {}),
      };
      await saveJob(sentJob);
      logActivity('invoice_sent', `Sent invoice #${invNumber.trim()} — ${selJob.projectName || 'job'}${selJob.billToName ? ` (${selJob.billToName})` : ''} to ${selJob.email}`);
      setSending(false);
      setToast('Invoice sent and job status updated to Invoice Sent');
      setTimeout(() => { reset(); onClose(); }, 2200);
    } catch (err) {
      setSending(false);
      Alert.alert('Email Failed', err.message || 'Could not send the email. Invoice was not saved.');
    }
  };

  const taxRateNum = parseFloat(taxRate) || 0;
  const taxDisplay = `${taxRate}%${taxLabel ? ` - ${taxLabel}` : ''}`;
  const { subtotal, tax, total } = calcTotals(lineItems, taxRateNum);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <SafeAreaView style={styles.wizardContainer}>
        <View style={styles.wizardHeader}>
          <TouchableOpacity onPress={handleBack} style={styles.wizardBack}>
            <Ionicons name={step === 2 ? 'close' : 'chevron-back'} size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={styles.wizardTitleBlock}>
            <Text style={styles.wizardTitle}>{STEP_TITLES[step]}</Text>
            <StepDots step={step} total={4} />
          </View>
          {isPaid ? (
            <View style={styles.lockBadge}>
              <Ionicons name="lock-closed" size={12} color="#d97706" />
              <Text style={styles.lockBadgeText}>Invoice Locked · Paid</Text>
            </View>
          ) : (
            <View style={{ width: 34 }} />
          )}
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView ref={scrollRef} contentContainerStyle={styles.wizardContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {step === 2 && selJob && (
              <>
                {isPaid && (
                  <View style={styles.lockedBanner}>
                    <Ionicons name="lock-closed" size={14} color="#d97706" />
                    <Text style={styles.lockedBannerText}>Invoice Locked — Paid.</Text>
                    <TouchableOpacity style={styles.fixInvoiceBtn} onPress={handleFixInvoice}>
                      <Ionicons name="create-outline" size={13} color="#fff" />
                      <Text style={styles.fixInvoiceBtnText}>Fix Invoice</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View style={styles.detailJobCard}>
                  {selJob.jobId ? <Text style={styles.detailJobId}>Job {selJob.jobId}</Text> : null}
                  <Text style={styles.detailJobName}>{selJob.projectName}</Text>
                  <Text style={styles.detailJobCustomer}>{selJob.billToName}</Text>
                  {selJob.jobLocationAddress ? (
                    <TouchableOpacity style={styles.detailJobAddrRow} onPress={() => openInMaps(selJob.jobLocationAddress)} activeOpacity={0.7}>
                      <Text style={styles.detailJobAddr} numberOfLines={2}>{selJob.jobLocationAddress}</Text>
                      <Ionicons name="earth-outline" size={14} color="#16a34a" style={{ marginLeft: 4 }} />
                    </TouchableOpacity>
                  ) : null}
                  {selJob.email ? <Text style={styles.detailJobEmail}>{selJob.email}</Text> : null}
                </View>

                <View style={styles.editJobRow}>
                  <TouchableOpacity
                    style={styles.editJobLink}
                    onPress={() => onEditJob && onEditJob(selJob.id)}
                    activeOpacity={0.7}
                  >
                    {isPaid ? (
                      <Ionicons name="lock-closed" size={14} color="#d97706" />
                    ) : (
                      <Ionicons name="pencil-outline" size={14} color="#2563eb" />
                    )}
                    <Text style={[styles.editJobLinkText, isPaid && { color: '#d97706' }]}>
                      {isPaid ? 'Invoice Locked' : 'Edit Job Details'}
                    </Text>
                  </TouchableOpacity>
                  <View style={[styles.statusBadge, { backgroundColor: statusStyle(selJob.status).bg }]}>
                    <Text style={[styles.statusText, { color: statusStyle(selJob.status).fg }]}>
                      {selJob.status || '—'}
                    </Text>
                  </View>
                </View>

                <FormSection title="INVOICE NUMBER">
                  {isPaid ? (
                    <View style={styles.lockedField}>
                      <Text style={styles.lockedFieldText}>{invNumber}</Text>
                      <Ionicons name="lock-closed" size={12} color={colors.textMuted} />
                    </View>
                  ) : (
                    <AppTextInput
                      style={styles.detailInput}
                      value={invNumber}
                      onChangeText={setInvNumber}
                      placeholder="e.g. 26123-001"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      returnKeyType="next"
                    />
                  )}
                </FormSection>

                <View style={styles.formSection}>
                  <Text style={styles.formSectionLabel}>INVOICE DATE</Text>
                  <View pointerEvents={isPaid ? 'none' : 'auto'} style={isPaid ? { opacity: 0.65 } : undefined}>
                    <DatePickerField
                      value={invDate}
                      onChange={(v) => { setInvDate(v); if (v) setDueDate(addDays(v, 30)); }}
                      clearable={false}
                    />
                  </View>
                </View>

                <View style={styles.formSection}>
                  <Text style={styles.formSectionLabel}>DUE DATE</Text>
                  <View pointerEvents={isPaid ? 'none' : 'auto'} style={isPaid ? { opacity: 0.65 } : undefined}>
                    <DatePickerField
                      value={dueDate}
                      onChange={setDueDate}
                      clearable={false}
                    />
                  </View>
                </View>

                <FormSection title="TAX RATE (%)">
                  {isPaid ? (
                    <View style={styles.lockedField}>
                      <Text style={styles.lockedFieldText}>{taxRate}%{taxLabel ? ` - ${taxLabel}` : ''}</Text>
                      <Ionicons name="lock-closed" size={12} color={colors.textMuted} />
                    </View>
                  ) : (
                    <AppTextInput
                      style={styles.detailInput}
                      value={taxRate}
                      onChangeText={(v) => {
                        setTaxRate(v);
                        // When manually overriding, clear auto-detected label so it doesn't mislead
                      }}
                      placeholder="7"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                      returnKeyType="done"
                    />
                  )}
                </FormSection>
                {!isPaid && taxLabel ? (
                  <Text style={styles.taxHint}>Auto-detected: {taxLabel}</Text>
                ) : null}

                <NextButton
                  label={fixedInvoice ? 'Save & Preview Invoice →' : 'Next: Line Items →'}
                  onPress={handleNext}
                />
                {fixedInvoice && (
                  <TouchableOpacity
                    style={styles.editLineItemsLink}
                    onPress={() => { setFixedInvoice(false); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.editLineItemsLinkText}>Edit line items first →</Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            {step === 3 && (
              <>
                {isPaid && (
                  <View style={styles.lockedBanner}>
                    <Ionicons name="lock-closed" size={14} color="#d97706" />
                    <Text style={styles.lockedBannerText}>Invoice Locked — Paid. Line items cannot be edited.</Text>
                  </View>
                )}
                <Text style={styles.lineItemsHint}>
                  {isPaid ? 'These are the exact invoiced amounts.' : 'Edit quantities and prices. Lines with qty 0 are excluded.'}
                </Text>

                {lineItems.map((item, i) => {
                  const lt = lineTotal(item);
                  return (
                    <View key={i} style={[styles.lineItemCard, item._isExpense && styles.lineItemCardExpense]}>
                      <View style={styles.lineItemDescRow}>
                        {!isPaid && item._isExpense ? (
                          <AppTextInput
                            style={[styles.lineItemDesc, styles.lineItemDescInput]}
                            value={item.description}
                            onChangeText={(v) => updateItem(i, 'description', v)}
                            placeholder="Expense description"
                            placeholderTextColor={colors.textMuted}
                            returnKeyType="done"
                          />
                        ) : (
                          <Text style={styles.lineItemDesc}>{item.description}</Text>
                        )}
                        {!isPaid && (
                          <TouchableOpacity
                            onPress={() => removeItem(i)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={styles.lineItemRemoveBtn}
                          >
                            <Ionicons name="close-circle" size={17} color="#9ca3af" />
                          </TouchableOpacity>
                        )}
                      </View>
                      <View style={styles.lineItemRow}>
                        <View style={styles.lineItemField}>
                          <Text style={styles.lineItemFieldLabel}>Qty</Text>
                          {isPaid ? (
                            <Text style={[styles.lineItemInput, { color: colors.textSecondary }]}>{item.qty}</Text>
                          ) : (
                            <AppTextInput
                              style={styles.lineItemInput}
                              value={item.qty}
                              onChangeText={(v) => updateItem(i, 'qty', v)}
                              keyboardType="decimal-pad"
                              selectTextOnFocus
                            />
                          )}
                        </View>
                        <Text style={styles.lineItemTimes}>×</Text>
                        <View style={styles.lineItemField}>
                          <Text style={styles.lineItemFieldLabel}>Price</Text>
                          <View style={styles.lineItemPriceWrap}>
                            <Text style={styles.lineItemDollar}>$</Text>
                            {isPaid ? (
                              <Text style={[styles.lineItemInput, { color: colors.textSecondary }]}>{item.unitPrice}</Text>
                            ) : (
                              <AppTextInput
                                style={styles.lineItemInput}
                                value={item.unitPrice}
                                onChangeText={(v) => updateItem(i, 'unitPrice', v)}
                                keyboardType="decimal-pad"
                                selectTextOnFocus
                              />
                            )}
                          </View>
                        </View>
                        <Text style={styles.lineItemTimes}>=</Text>
                        <Text style={[styles.lineItemTotal, lt > 0 && styles.lineItemTotalActive]}>
                          {fmtWhole(lt)}
                        </Text>
                      </View>
                    </View>
                  );
                })}

                <View style={styles.taxSummaryCard}>
                  <View style={styles.taxRateRow}>
                    <Text style={styles.taxRateLabel}>Tax Rate</Text>
                    <View style={styles.taxRateInputWrap}>
                      {isPaid ? (
                        <Text style={[styles.taxRateInput, { color: colors.textSecondary, paddingVertical: 8 }]}>{taxRate}</Text>
                      ) : (
                        <AppTextInput
                          style={styles.taxRateInput}
                          value={taxRate}
                          onChangeText={setTaxRate}
                          keyboardType="decimal-pad"
                          selectTextOnFocus
                        />
                      )}
                      <Text style={styles.taxRatePct}>%</Text>
                    </View>
                  </View>
                  <View style={styles.taxSummaryDivider} />
                  <View style={styles.taxSummaryLine}>
                    <Text style={styles.taxSummaryLineLabel}>Subtotal</Text>
                    <Text style={styles.taxSummaryLineValue}>{fmtDecimal(subtotal)}</Text>
                  </View>
                  <View style={styles.taxSummaryLine}>
                    <Text style={styles.taxSummaryLineLabel}>Tax ({taxRate}%)</Text>
                    <Text style={styles.taxSummaryLineValue}>{fmtDecimal(tax)}</Text>
                  </View>
                  <View style={[styles.taxSummaryLine, styles.taxSummaryTotal]}>
                    <Text style={styles.taxSummaryTotalLabel}>Total</Text>
                    <Text style={styles.taxSummaryTotalValue}>{fmtDecimal(total)}</Text>
                  </View>
                </View>

                {!isPaid && (
                  <TouchableOpacity style={styles.saveReturnBtn} onPress={handleSaveAndReturn}>
                    <Text style={styles.saveReturnBtnText}>Save and Return</Text>
                  </TouchableOpacity>
                )}
                <NextButton label="Next: Preview →" onPress={handleNext} />
              </>
            )}

            {step === 4 && selJob && (
              <>
                <View style={styles.previewHeader}>
                  <View style={styles.previewHeaderLeft}>
                    {companyProfile?.logoUrl ? (
                      <Image
                        source={{ uri: companyProfile.logoUrl }}
                        style={styles.previewHeaderLogo}
                        resizeMode="contain"
                      />
                    ) : (
                      <View style={{ paddingHorizontal: 6 }}>
                        <Text style={styles.previewHeaderCompanyName} numberOfLines={1}>
                          {companyProfile?.companyName || '—'}
                        </Text>
                        {companyProfile?.address ? (
                          <Text style={styles.previewHeaderCompanyAddr} numberOfLines={1}>
                            {companyProfile.address}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </View>
                  <View style={styles.previewHeaderCenter}>
                    {companyProfile?.tagline ? (
                      <Text style={styles.previewHeaderTagline} numberOfLines={2}>
                        &ldquo;{companyProfile.tagline}&rdquo;
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.previewHeaderRight}>
                    <Text style={styles.previewHeaderInvoice}>INVOICE</Text>
                  </View>
                </View>

                <View style={styles.previewMetaRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.previewMetaHead}>Bill To</Text>
                    <Text style={styles.previewMetaVal}>{selJob.billToName}</Text>
                    {(selJob.billToAddress || selJob.email) ? (
                      <Text style={styles.previewMetaSub}>
                        {[selJob.billToAddress, selJob.email].filter(Boolean).join('  ')}
                      </Text>
                    ) : null}
                    {selJob.phone ? (
                      <Text style={styles.previewMetaSub}>{formatPhoneDisplay(selJob.phone)}</Text>
                    ) : null}
                  </View>
                  <View style={styles.previewMetaRight}>
                    <PreviewRow label="Invoice #" value={invNumber} />
                    <PreviewRow label="Date"      value={formatDate(invDate)} />
                    <PreviewRow label="Due"       value={formatDate(dueDate)} />
                  </View>
                </View>

                <View style={styles.previewProjectCard}>
                  <Text style={styles.previewMetaHead}>Project</Text>
                  {selJob.jobId ? <Text style={styles.previewJobIdLabel}>Job {selJob.jobId}</Text> : null}
                  <Text style={styles.previewMetaVal}>{selJob.projectName}</Text>
                  {selJob.jobLocationAddress ? (
                    <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => openInMaps(selJob.jobLocationAddress)} activeOpacity={0.7}>
                      <Text style={styles.previewMetaSub}>{selJob.jobLocationAddress}</Text>
                      <Ionicons name="earth-outline" size={12} color="#16a34a" />
                    </TouchableOpacity>
                  ) : null}
                  {selJob.targetDate ? <Text style={styles.previewMetaSub}>Job Date: {formatDate(selJob.targetDate)}</Text> : null}
                </View>

                <View style={styles.previewTable}>
                  <View style={[styles.previewTableRow, styles.previewTableHead]}>
                    <Text style={[styles.previewTableCell, styles.previewTableHeadCell, { flex: 1 }]}>Description</Text>
                    <Text style={[styles.previewTableCell, styles.previewTableHeadCell, { flex: 0, width: 50, textAlign: 'center' }]}>Qty</Text>
                    <Text style={[styles.previewTableCell, styles.previewTableHeadCell, styles.previewTableRight, { flex: 0, width: 80 }]}>Unit Price</Text>
                    <Text style={[styles.previewTableCell, styles.previewTableHeadCell, styles.previewTableRight, { flex: 0, width: 80 }]}>Total</Text>
                  </View>
                  {lineItems
                    .filter((item) => (parseFloat(item.qty) || 0) > 0)
                    .map((item, i) => (
                      <View key={i} style={styles.previewTableRow}>
                        <Text style={[styles.previewTableCell, { flex: 1 }]} numberOfLines={1} ellipsizeMode="clip">{item.description}</Text>
                        <Text style={[styles.previewTableCell, { flex: 0, width: 50, textAlign: 'center' }]} numberOfLines={1} ellipsizeMode="clip">{item.qty}</Text>
                        <Text style={[styles.previewTableCell, styles.previewTableRight, { flex: 0, width: 80 }]} numberOfLines={1} ellipsizeMode="clip">{fmtDecimal(item.unitPrice)}</Text>
                        <Text style={[styles.previewTableCell, styles.previewTableRight, { flex: 0, width: 80 }]} numberOfLines={1} ellipsizeMode="clip">{fmtDecimal(lineTotal(item))}</Text>
                      </View>
                    ))}
                </View>

                <View style={styles.previewBottomRow}>
                  <View style={styles.previewPaymentSide}>
                    <Text style={styles.previewMetaHead}>Send Payment To</Text>
                    <Text style={styles.previewMetaVal}>{companyProfile?.companyName || '—'}</Text>
                    {companyProfile?.address       ? <Text style={styles.previewMetaSub}>{companyProfile.address}</Text>       : null}
                    {companyProfile?.billingEmail  ? <Text style={styles.previewMetaSub}>{companyProfile.billingEmail}</Text>  : null}
                    {companyProfile?.phone         ? <Text style={styles.previewMetaSub}>{companyProfile.phone}</Text>         : null}
                  </View>
                  <View style={styles.previewTotalsSide}>
                    <TotalRow label="Subtotal" value={fmtDecimal(subtotal)} />
                    <View style={styles.totalRow}>
                      <View>
                        <Text style={styles.totalLabel}>Tax</Text>
                        <Text style={styles.taxSubLabel}>{taxDisplay}{taxRateNum === 0 ? ' *' : ''}</Text>
                      </View>
                      <Text style={styles.totalValue}>{fmtDecimal(tax)}</Text>
                    </View>
                    <View style={styles.totalsDivider} />
                    <View style={styles.totalDueBlock}>
                      <Text style={styles.totalValueBold}>{fmtDecimal(total)}</Text>
                      <Text style={styles.totalDueLabel}>Total Due</Text>
                    </View>
                  </View>
                </View>

                {taxRateNum === 0 && (
                  <Text style={styles.taxFootnote}>
                    * This invoice reflects non-retail services in support of Real Property improvement
                  </Text>
                )}

                <TouchableOpacity
                  style={styles.photosBtn}
                  onPress={() => onEditJob && onEditJob(selJob.id)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="camera-outline" size={18} color="#2563eb" />
                  <Text style={styles.photosBtnText}>View / Add Photos</Text>
                </TouchableOpacity>

                <View style={styles.saveBtnRow}>
                  <TouchableOpacity
                    style={[styles.saveBtnOutline, (saving || sending) && styles.saveBtnDisabled]}
                    onPress={isPaid ? handleClose : handleSave}
                    disabled={saving || sending}
                  >
                    {saving
                      ? <ActivityIndicator color={colors.primary} size="small" />
                      : <>
                          <Ionicons name={isPaid ? 'close-outline' : 'save-outline'} size={18} color={colors.primary} />
                          <Text style={styles.saveBtnOutlineText}>{isPaid ? 'Close' : 'Save'}</Text>
                        </>}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.saveBtn, (saving || sending) && styles.saveBtnDisabled]}
                    onPress={handleSaveAndSend}
                    disabled={saving || sending}
                  >
                    {sending
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <>
                          <Ionicons name="send-outline" size={18} color="#fff" />
                          <Text style={styles.saveBtnText}>{isPaid ? 'Resend Invoice' : 'Save & Send'}</Text>
                        </>}
                  </TouchableOpacity>
                </View>

                {sending && (
                  <View style={styles.sendingProgress}>
                    <ActivityIndicator size="small" color={colors.textMuted} />
                    <Text style={styles.sendingProgressText}>
                      {sendProgress.total > 0 && sendProgress.done < sendProgress.total
                        ? `Embedding photo ${sendProgress.done + 1} of ${sendProgress.total}…`
                        : 'Preparing invoice…'}
                    </Text>
                  </View>
                )}
              </>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>

        {toast ? (
          <View style={styles.toastWrap} pointerEvents="none">
            <Ionicons name="checkmark-circle" size={18} color="#fff" />
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        ) : null}

        {/* Send-to-customer confirmation modal — last gate before the email actually fires. */}
        <Modal
          visible={showSendConfirm}
          transparent
          animationType="fade"
          onRequestClose={() => setShowSendConfirm(false)}
        >
          <View style={styles.sendConfirmBackdrop}>
            <View style={styles.sendConfirmCard}>
              <View style={styles.sendConfirmIconWrap}>
                <Ionicons name="mail-outline" size={26} color={colors.primary} />
              </View>
              <Text style={styles.sendConfirmTitle}>Send invoice to customer?</Text>
              <Text style={styles.sendConfirmSub}>Review before sending. This will email the invoice and mark the job as Invoice Sent.</Text>

              <View style={styles.sendConfirmRow}>
                <Text style={styles.sendConfirmLabel}>To</Text>
                <Text style={styles.sendConfirmValue} numberOfLines={1}>{selJob?.email || '—'}</Text>
              </View>
              <View style={styles.sendConfirmRow}>
                <Text style={styles.sendConfirmLabel}>Invoice #</Text>
                <Text style={styles.sendConfirmValue}>{invNumber || '—'}</Text>
              </View>
              <View style={styles.sendConfirmRow}>
                <Text style={styles.sendConfirmLabel}>Total</Text>
                <Text style={[styles.sendConfirmValue, { color: colors.primary, fontWeight: '800' }]}>
                  {fmtDecimal(total)}
                </Text>
              </View>

              <View style={styles.sendConfirmBtnRow}>
                <TouchableOpacity
                  style={[styles.sendConfirmBtn, styles.sendConfirmBtnCancel]}
                  onPress={() => setShowSendConfirm(false)}
                >
                  <Text style={styles.sendConfirmBtnCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sendConfirmBtn, styles.sendConfirmBtnSend]}
                  onPress={executeSendInvoice}
                >
                  <Ionicons name="send" size={15} color="#fff" />
                  <Text style={styles.sendConfirmBtnSendText}>Send to Customer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

// ── Small components ───────────────────────────────────────────────────────────

const STEP_TITLES = {
  1: 'Select Job',
  2: 'Invoice Details',
  3: 'Line Items',
  4: 'Preview',
};

function StepDots({ step, total }) {
  return (
    <View style={styles.stepDots}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.stepDot, i + 1 === step && styles.stepDotActive, i + 1 < step && styles.stepDotDone]} />
      ))}
    </View>
  );
}

function FormSection({ title, children }) {
  return (
    <View style={styles.formSection}>
      <Text style={styles.formSectionLabel}>{title}</Text>
      <View style={styles.formSectionCard}>{children}</View>
    </View>
  );
}

function NextButton({ label, onPress }) {
  return (
    <TouchableOpacity style={styles.nextBtn} onPress={onPress}>
      <Text style={styles.nextBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function PreviewRow({ label, value }) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewRowLabel}>{label}</Text>
      <Text
        style={styles.previewRowValue}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontSize={8}
      >
        {value}
      </Text>
    </View>
  );
}

function TotalRow({ label, value, bold }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && styles.totalLabelBold]}>{label}</Text>
      <Text style={[styles.totalValue, bold && styles.totalValueBold]}>{value}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  addBtn: {
    backgroundColor: '#16a34a',
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invModeToggle: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
  },
  invModeBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  invModeBtnActive: { backgroundColor: colors.primary },
  invModeBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  invModeBtnTextActive: { color: '#fff' },

  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderRadius: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  loadMoreText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  filterBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#bfdbfe',
  },
  filterBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#2563eb' },
  filterBannerClear: { padding: 2 },

  listContent: { padding: 16, gap: 10 },

  jobCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 2,
    borderColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  jobCardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  jobCardTopRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  jobIdLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 2,
  },
  jobCardTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  statusText: { fontSize: 11, fontWeight: '700' },
  jobCardCustomer: { fontSize: 13, color: colors.textSecondary, marginBottom: 3 },
  jobCardCrew: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  invoiceSummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  invoiceSummaryText: { fontSize: 12, color: colors.textMuted },

  invoiceActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    alignSelf: 'flex-start', // left-justified — row hugs its content width
  },
  markPaidPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  markPaidPillText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  viewInvoicePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#2563eb',
  },
  viewInvoicePillText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  editIconBtn: {
    marginLeft: 6,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    padding: 6,
  },
  editJobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  editJobLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  editJobLinkText: { fontSize: 13, fontWeight: '600', color: '#2563eb' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 260 },

  wizardContainer: { flex: 1, backgroundColor: '#f9fafb' },
  wizardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  wizardBack: { width: 34, alignItems: 'center' },
  wizardTitleBlock: { flex: 1, alignItems: 'center', gap: 6 },
  wizardTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  stepDots: { flexDirection: 'row', gap: 6 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e5e7eb' },
  stepDotActive: { backgroundColor: colors.primary, width: 20 },
  stepDotDone: { backgroundColor: '#86efac' },
  wizardContent: { padding: 16 },

  detailJobCard: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, marginBottom: 20 },
  detailJobId: {
    fontSize: 10, fontWeight: '600', color: '#86efac',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 3,
  },
  detailJobName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  detailJobCustomer: { fontSize: 13, color: '#bbf7d0', marginTop: 2 },
  detailJobAddrRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  detailJobAddr: { fontSize: 12, color: '#86efac' },
  detailJobEmail: { fontSize: 12, color: '#fff', marginTop: 2 },

  formSection: { marginBottom: 14 },
  formSectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    letterSpacing: 0.8, marginBottom: 6, marginLeft: 4,
  },
  formSectionCard: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  detailInput: { fontSize: 15, color: colors.textPrimary, paddingVertical: 14 },
  taxHint: { fontSize: 12, color: colors.textMuted, marginTop: -10, marginBottom: 14, marginLeft: 4 },

  nextBtn: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  nextBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  saveReturnBtn: {
    borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 8,
  },
  saveReturnBtnText: { color: colors.primary, fontSize: 15, fontWeight: '700' },

  lineItemsHint: { fontSize: 12, color: colors.textMuted, marginBottom: 12, marginLeft: 4 },
  lineItemCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  lineItemCardExpense: { borderLeftWidth: 3, borderLeftColor: '#86efac' },
  lineItemDescRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 6 },
  lineItemDesc: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flex: 1 },
  lineItemDescInput: {
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
    paddingVertical: 2, fontWeight: '600',
  },
  lineItemRemoveBtn: { flexShrink: 0 },
  lineItemRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lineItemField: { alignItems: 'center', gap: 2 },
  lineItemFieldLabel: { fontSize: 9, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase' },
  lineItemInput: {
    backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, fontWeight: '600',
    color: colors.textPrimary, minWidth: 52, textAlign: 'center',
  },
  lineItemPriceWrap: { flexDirection: 'row', alignItems: 'center' },
  lineItemDollar: { fontSize: 13, color: colors.textSecondary, marginRight: 2 },
  lineItemTimes: { fontSize: 14, color: colors.textMuted, fontWeight: '500' },
  lineItemTotal: { fontSize: 14, fontWeight: '700', color: colors.textMuted, minWidth: 48, textAlign: 'right' },
  lineItemTotalActive: { color: colors.primary },

  taxSummaryCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  taxRateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  taxRateLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  taxRateInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  taxRateInput: {
    backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 10, paddingVertical: 6, fontSize: 15, fontWeight: '700',
    color: colors.textPrimary, minWidth: 64, textAlign: 'center',
  },
  taxRatePct: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  taxSummaryDivider: { height: 1, backgroundColor: '#e5e7eb', marginBottom: 10 },
  taxSummaryLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  taxSummaryLineLabel: { fontSize: 13, color: colors.textSecondary },
  taxSummaryLineValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  taxSummaryTotal: { marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  taxSummaryTotalLabel: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  taxSummaryTotalValue: { fontSize: 17, fontWeight: '800', color: colors.primary },

  // ── Invoice preview header — three sections matching PDF layout ─────────
  // Left (white): logo or company fallback. Center (green): italic tagline.
  // Right (white): "INVOICE" in dark green.
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 8,
    height: 60,
  },
  previewHeaderLeft: {
    width: 100,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.3)',
  },
  previewHeaderLogo: { width: 90, height: 50 },
  previewHeaderCompanyName: { fontSize: 11, fontWeight: '800', color: '#16a34a' },
  previewHeaderCompanyAddr: { fontSize: 9,  color: '#374151', marginTop: 2 },
  previewHeaderCenter: {
    flex: 1,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderLeftWidth:  1,
    borderLeftColor:  'rgba(255,255,255,0.3)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.3)',
  },
  previewHeaderTagline: {
    fontSize: 13,
    fontWeight: '700',
    fontStyle: 'italic',
    color: '#fff',
    textAlign: 'center',
    lineHeight: 16,
  },
  previewHeaderRight: {
    width: 90,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.3)',
  },
  previewHeaderInvoice: {
    fontSize: 16,
    fontWeight: '700',
    color: '#15803d',
    letterSpacing: 2,
  },

  previewPaymentCard: { backgroundColor: '#f0fdf4', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#86efac' },
  previewMetaRow: {
    flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 8, marginBottom: 0,
  },
  previewMetaRight: { alignItems: 'flex-end', gap: 4, minWidth: 150 },
  previewMetaHead: { fontSize: 9, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 4, letterSpacing: 0.5 },
  previewMetaVal: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  previewMetaSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  previewRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  previewRowLabel: { fontSize: 11, color: colors.textMuted, width: 52, textAlign: 'right' },
  previewRowValue: { fontSize: 12, fontWeight: '600', color: colors.textPrimary, flex: 1 },

  previewProjectCard: {
    backgroundColor: '#fff', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 8, marginBottom: 8,
  },
  previewJobIdLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 3,
  },

  previewBottomRow: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 8,
  },
  previewPaymentSide: { flex: 1 },
  previewTotalsSide: { flex: 1 },

  previewTable: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', marginBottom: 8 },
  previewTableRow: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  previewTableHead: { backgroundColor: '#f9fafb' },
  previewTableCell: { flex: 1, fontSize: 10, color: colors.textPrimary },
  previewTableHeadCell: { fontSize: 9, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  previewTableRight: { textAlign: 'right', fontWeight: '600' },

  totalsCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 16 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  totalLabel: { fontSize: 14, color: colors.textSecondary },
  totalValue: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  totalLabelBold: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  totalValueBold: { fontSize: 18, fontWeight: '800', color: colors.primary },
  taxSubLabel: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  taxFootnote: { fontSize: 10, fontStyle: 'italic', color: colors.textMuted, marginTop: 4, marginBottom: 12, lineHeight: 14 },
  totalsDivider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 8 },

  lockBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fef3c7', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5,
  },
  lockBadgeText: { fontSize: 10, fontWeight: '700', color: '#d97706', letterSpacing: 0.2 },

  lockedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fef3c7', borderRadius: 10, padding: 10,
    marginBottom: 14, borderWidth: 1, borderColor: '#fde68a',
  },
  lockedBannerText: { fontSize: 12, fontWeight: '600', color: '#d97706', flex: 1 },
  fixInvoiceBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#d97706', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, flexShrink: 0,
  },
  fixInvoiceBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  editLineItemsLink: { alignItems: 'center', marginTop: 10 },
  editLineItemsLinkText: { fontSize: 13, color: colors.textMuted, fontWeight: '500', textDecorationLine: 'underline' },

  lockedField: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14,
  },
  lockedFieldText: { fontSize: 15, color: colors.textSecondary },
  totalDueBlock: { alignItems: 'flex-end', paddingTop: 2 },
  totalDueLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginTop: 3 },

  photosBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, paddingVertical: 12, marginBottom: 10,
    borderRadius: 12, borderWidth: 1.5, borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  photosBtnText: { fontSize: 15, fontWeight: '700', color: '#2563eb' },
  saveBtnRow: { flexDirection: 'row', gap: 10 },
  saveBtnOutline: {
    flex: 1, borderWidth: 2, borderColor: colors.primary, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, paddingVertical: 14, backgroundColor: '#fff',
  },
  saveBtnOutlineText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  saveBtn: {
    flex: 1, backgroundColor: colors.primary, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 7, paddingVertical: 14,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
  },
  saveBtnDisabled: { opacity: 0.5, shadowOpacity: 0 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  sendingProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  sendingProgressText: { fontSize: 13, color: colors.textMuted },

  toastWrap: {
    position: 'absolute',
    bottom: 48,
    left: 20,
    right: 20,
    backgroundColor: colors.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 },

  sendConfirmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sendConfirmCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 22,
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 10,
  },
  sendConfirmIconWrap: {
    alignSelf: 'center',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0fdf4',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  sendConfirmTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 6,
  },
  sendConfirmSub: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
    marginBottom: 16,
  },
  sendConfirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 12,
  },
  sendConfirmLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4 },
  sendConfirmValue: { fontSize: 14, color: colors.textPrimary, flexShrink: 1, textAlign: 'right' },
  sendConfirmBtnRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  sendConfirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
  },
  sendConfirmBtnCancel:     { backgroundColor: '#f3f4f6' },
  sendConfirmBtnCancelText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  sendConfirmBtnSend:       { backgroundColor: colors.primary },
  sendConfirmBtnSendText:   { fontSize: 14, fontWeight: '800', color: '#fff' },

  pickerContainer: { flex: 1, backgroundColor: '#f9fafb' },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  pickerTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  pickerClose: { padding: 4 },
  pickerList: { padding: 16, gap: 10 },
  pickerJobCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  pickerJobTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  pickerJobIdLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 2,
  },
  pickerJobTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  pickerJobCustomer: { fontSize: 13, color: colors.textSecondary, marginBottom: 4 },
  pickerJobDateRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickerJobDate: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  pickerJobDateMuted: { fontSize: 12, color: '#d1d5db', fontStyle: 'italic' },
  pickerEmpty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  pickerEmptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  pickerEmptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },

});
