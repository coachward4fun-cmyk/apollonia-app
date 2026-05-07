import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Modal, TextInput, KeyboardAvoidingView,
  Platform, Alert, RefreshControl, ActivityIndicator,
} from 'react-native';
import { sendInvoiceEmail } from '../utils/sendInvoiceEmail';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeJobs, subscribeCrews, saveJob, getExpenses } from '../services/db';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';

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

const STATUS_STYLE = {
  'not scheduled':  { bg: '#f3f4f6', fg: '#6b7280' },
  'scheduled':      { bg: '#dbeafe', fg: '#2563eb' },
  'in progress':    { bg: '#dcfce7', fg: colors.primary },
  'invoice ready':  { bg: '#dbeafe', fg: '#2563eb' },
  'invoice sent':   { bg: '#fef3c7', fg: '#d97706' },
  'invoice paid':   { bg: '#dcfce7', fg: colors.primary },
  'completed':      { bg: '#f3f4f6', fg: '#6b7280' },
};

function statusStyle(s) {
  return STATUS_STYLE[(s || '').toLowerCase()] || { bg: '#f3f4f6', fg: '#6b7280' };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function addDays(dateStr, n) {
  const d = new Date((dateStr || today()) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtWhole(n) {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

function fmtDecimal(n) {
  if (!n && n !== 0) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function lineTotal(item) {
  return (parseFloat(item.qty) || 0) * (parseFloat(item.unitPrice) || 0);
}

function calcTotals(items) {
  const subtotal = items.reduce((s, item) => s + lineTotal(item), 0);
  const tax      = subtotal * 0.07;
  const total    = subtotal + tax;
  return { subtotal, tax, total };
}

function generateInvoiceNumber(jobs) {
  const d   = new Date();
  const yy  = String(d.getFullYear()).slice(2);
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  const ddd = String(doy).padStart(3, '0');
  const n   = (jobs.filter((j) => j.invoiceTotal != null).length + 1).toString().padStart(3, '0');
  return `${yy}${ddd}-${n}`;
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function InvoiceScreen() {
  const navigation   = useNavigation();
  const route        = useRoute();

  const [jobs,           setJobs]          = useState([]);
  const [crews,          setCrews]         = useState([]);
  const [refreshing,     setRefreshing]    = useState(false);
  const [showWizard,     setShowWizard]    = useState(false);
  const [showJobPicker,  setShowJobPicker] = useState(false);
  const [selectedJobId,  setSelectedJobId] = useState(null);
  const [statusFilter,   setStatusFilter]  = useState(null);

  useEffect(() => {
    const unsubJobs  = subscribeJobs(setJobs);
    const unsubCrews = subscribeCrews(setCrews);
    return () => { unsubJobs(); unsubCrews(); };
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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  const crewMap = Object.fromEntries(crews.map((c) => [c.id, c.name]));

  const allSorted = [
    ...jobs.filter((j) => j.invoiceTotal != null).sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || '')),
    ...jobs.filter((j) => j.invoiceTotal == null).sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || '')),
  ];

  const displayedJobs = statusFilter
    ? allSorted.filter((j) => (j.status || '').toLowerCase() === statusFilter.toLowerCase())
    : allSorted;

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;

  const handleEditJob = (jobId) => {
    setSelectedJobId(jobId);
    setShowWizard(true);
  };

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

      {statusFilter ? (
        <View style={styles.filterBanner}>
          <Ionicons name="filter" size={13} color="#2563eb" />
          <Text style={styles.filterBannerText}>
            Filtered: {statusFilter.replace(/\b\w/g, (c) => c.toUpperCase())}
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
            <Text style={styles.emptyTitle}>{statusFilter ? 'No matching jobs' : 'No jobs yet'}</Text>
            <Text style={styles.emptySub}>
              {statusFilter
                ? 'No jobs match this filter. Tap × to clear.'
                : 'Add jobs from the Jobs screen, then return here to create invoices.'}
            </Text>
          </View>
        ) : (
          displayedJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              crewName={crewMap[job.crewId] || null}
              onEdit={() => handleEditJob(job.id)}
            />
          ))
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
        jobs={jobs}
        preselectedJob={selectedJob}
        onClose={() => { setShowWizard(false); setSelectedJobId(null); }}
        onSave={handleSaveInvoice}
        onEditJob={(jobId) => {
          setShowWizard(false);
          setSelectedJobId(null);
          navigation.navigate('Jobs', {
            screen: 'JobForm',
            params: { jobId, returnToInvoice: true },
          });
        }}
      />
    </SafeAreaView>
  );
}

// ── JobCard ────────────────────────────────────────────────────────────────────

function JobCard({ job, crewName, onEdit }) {
  const sc         = statusStyle(job.status);
  const isInvoiced = job.invoiceTotal != null;
  const hasPhotos  = Array.isArray(job.photos) && job.photos.length > 0;

  return (
    <View style={styles.jobCard}>
      <View style={styles.jobCardTop}>
        <Text style={styles.jobCardTitle} numberOfLines={1}>{job.projectName || 'Untitled'}</Text>
        <View style={styles.jobCardTopRight}>
          {hasPhotos && (
            <Ionicons name="camera" size={15} color={colors.textMuted} style={{ marginRight: 6 }} />
          )}
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.fg }]}>{job.status || '—'}</Text>
          </View>
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

      <TouchableOpacity style={styles.editIconBtn} onPress={onEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="pencil-outline" size={16} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

// ── JobPickerModal ─────────────────────────────────────────────────────────────

function JobPickerModal({ visible, jobs, onSelect, onClose }) {
  const selectableJobs = [...jobs]
    .filter((j) => (j.status || '').toLowerCase() !== 'invoice paid')
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
                    <Text style={styles.pickerJobTitle} numberOfLines={1}>
                      {job.projectName || 'Untitled Job'}
                    </Text>
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

function InvoiceWizard({ visible, jobs, preselectedJob, onClose, onSave, onEditJob }) {
  const [step,      setStep]      = useState(2);
  const [selJob,    setSelJob]    = useState(null);
  const [invNumber, setInvNumber] = useState('');
  const [invDate,   setInvDate]   = useState(today());
  const [dueDate,   setDueDate]   = useState(addDays(today(), 30));
  const [lineItems, setLineItems] = useState(DEFAULT_LINE_ITEMS.map((i) => ({ ...i })));
  const [saving,    setSaving]    = useState(false);
  const [sending,   setSending]   = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!visible || !preselectedJob) return;

    const init = async () => {
      setSelJob(preselectedJob);
      setStep(2);
      setInvNumber(preselectedJob.invoiceNumber || generateInvoiceNumber(jobs));
      setInvDate(preselectedJob.invoiceDate || today());
      setDueDate(preselectedJob.dueDate || addDays(today(), 30));

      if (preselectedJob.lineItems && preselectedJob.lineItems.length > 0) {
        setLineItems(preselectedJob.lineItems.map((i) => ({
          description: i.description,
          qty:         String(i.qty ?? 0),
          unitPrice:   String(i.unitPrice ?? 0),
        })));
        return;
      }

      const baseItems = DEFAULT_LINE_ITEMS.map((i) => ({ ...i }));

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
    setLineItems(DEFAULT_LINE_ITEMS.map((i) => ({ ...i })));
    setSaving(false);
    setSending(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleNext = () => {
    if (step === 2) {
      if (!invNumber.trim()) { Alert.alert('Required', 'Enter an invoice number.'); return; }
    }
    setStep((s) => s + 1);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const handleBack = () => {
    if (step === 2) { handleClose(); return; }
    setStep((s) => s - 1);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const updateItem = (index, field, value) => {
    setLineItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  const removeItem = (index) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const buildUpdatedJob = () => {
    const { total } = calcTotals(lineItems);
    return {
      ...selJob,
      status:        'Invoice Ready',
      invoiceNumber: invNumber.trim(),
      invoiceDate:   invDate,
      dueDate:       dueDate,
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
    setSaving(true);
    await onSave(buildUpdatedJob());
    reset();
  };

  const handleSaveAndSend = async () => {
    if (!selJob) return;
    if (!selJob.email) {
      Alert.alert('No Email Address', 'This customer has no email address on file. Add one to the job before sending.');
      return;
    }
    setSending(true);
    const updatedJob = buildUpdatedJob();
    try {
      await onSave(updatedJob);
      await sendInvoiceEmail(updatedJob, invNumber.trim(), invDate, dueDate, updatedJob.lineItems);
      logActivity('invoice_sent', `Invoice #${invNumber.trim()} sent to ${selJob.email}`);
      reset();
      Alert.alert('Email Sent ✓', `Invoice emailed to ${selJob.email}.`);
    } catch (err) {
      Alert.alert('Email Failed', err.message || 'Could not send the email. Invoice was saved.');
    } finally {
      setSending(false);
    }
  };

  const { subtotal, tax, total } = calcTotals(lineItems);

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
          <View style={{ width: 34 }} />
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView ref={scrollRef} contentContainerStyle={styles.wizardContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {step === 2 && selJob && (
              <>
                <View style={styles.detailJobCard}>
                  <Text style={styles.detailJobName}>{selJob.projectName}</Text>
                  <Text style={styles.detailJobCustomer}>{selJob.billToName}</Text>
                  {selJob.jobLocationAddress ? <Text style={styles.detailJobAddr}>{selJob.jobLocationAddress}</Text> : null}
                  {selJob.email ? <Text style={styles.detailJobEmail}>{selJob.email}</Text> : null}
                </View>

                <TouchableOpacity
                  style={styles.editJobLink}
                  onPress={() => onEditJob && onEditJob(selJob.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="pencil-outline" size={14} color="#2563eb" />
                  <Text style={styles.editJobLinkText}>Edit Job Details</Text>
                </TouchableOpacity>

                <FormSection title="INVOICE NUMBER">
                  <TextInput
                    style={styles.detailInput}
                    value={invNumber}
                    onChangeText={setInvNumber}
                    placeholder="e.g. 26123-001"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    returnKeyType="next"
                  />
                </FormSection>

                <FormSection title="INVOICE DATE">
                  <TextInput
                    style={styles.detailInput}
                    value={invDate}
                    onChangeText={(v) => { setInvDate(v); setDueDate(addDays(v, 30)); }}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    returnKeyType="next"
                  />
                </FormSection>

                <FormSection title="DUE DATE">
                  <TextInput
                    style={styles.detailInput}
                    value={dueDate}
                    onChangeText={setDueDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    returnKeyType="done"
                  />
                </FormSection>

                <NextButton label="Next: Line Items →" onPress={handleNext} />
              </>
            )}

            {step === 3 && (
              <>
                <Text style={styles.lineItemsHint}>Edit quantities and prices. Lines with qty 0 are excluded.</Text>

                {lineItems.map((item, i) => {
                  const lt = lineTotal(item);
                  return (
                    <View key={i} style={[styles.lineItemCard, item._isExpense && styles.lineItemCardExpense]}>
                      <View style={styles.lineItemDescRow}>
                        {item._isExpense ? (
                          <TextInput
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
                        <TouchableOpacity
                          onPress={() => removeItem(i)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.lineItemRemoveBtn}
                        >
                          <Ionicons name="close-circle" size={17} color="#9ca3af" />
                        </TouchableOpacity>
                      </View>
                      <View style={styles.lineItemRow}>
                        <View style={styles.lineItemField}>
                          <Text style={styles.lineItemFieldLabel}>Qty</Text>
                          <TextInput
                            style={styles.lineItemInput}
                            value={item.qty}
                            onChangeText={(v) => updateItem(i, 'qty', v)}
                            keyboardType="decimal-pad"
                            selectTextOnFocus
                          />
                        </View>
                        <Text style={styles.lineItemTimes}>×</Text>
                        <View style={styles.lineItemField}>
                          <Text style={styles.lineItemFieldLabel}>Price</Text>
                          <View style={styles.lineItemPriceWrap}>
                            <Text style={styles.lineItemDollar}>$</Text>
                            <TextInput
                              style={styles.lineItemInput}
                              value={item.unitPrice}
                              onChangeText={(v) => updateItem(i, 'unitPrice', v)}
                              keyboardType="decimal-pad"
                              selectTextOnFocus
                            />
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

                <View style={styles.subtotalBar}>
                  <Text style={styles.subtotalLabel}>Subtotal</Text>
                  <Text style={styles.subtotalValue}>{fmtDecimal(subtotal)}</Text>
                </View>

                <NextButton label="Next: Preview →" onPress={handleNext} />
              </>
            )}

            {step === 4 && selJob && (
              <>
                <View style={styles.previewHeader}>
                  <View>
                    <Text style={styles.previewCompany}>Apollonia Construction</Text>
                    <Text style={styles.previewCompanySub}>Omaha, NE</Text>
                  </View>
                  <View style={styles.previewInvoiceLabel}>
                    <Text style={styles.previewInvoiceLabelText}>INVOICE</Text>
                  </View>
                </View>

                <View style={styles.previewMetaRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.previewMetaHead}>Bill To</Text>
                    <Text style={styles.previewMetaVal}>{selJob.billToName}</Text>
                    {selJob.billToAddress ? <Text style={styles.previewMetaSub}>{selJob.billToAddress}</Text> : null}
                    {selJob.email ? <Text style={styles.previewMetaSub}>{selJob.email}</Text> : null}
                  </View>
                  <View style={styles.previewMetaRight}>
                    <PreviewRow label="Invoice #" value={invNumber} />
                    <PreviewRow label="Date"      value={formatDate(invDate)} />
                    <PreviewRow label="Due"       value={formatDate(dueDate)} />
                  </View>
                </View>

                <View style={styles.previewProjectCard}>
                  <Text style={styles.previewMetaHead}>Project</Text>
                  <Text style={styles.previewMetaVal}>{selJob.projectName}</Text>
                  {selJob.jobLocationAddress ? <Text style={styles.previewMetaSub}>{selJob.jobLocationAddress}</Text> : null}
                </View>

                <View style={styles.previewTable}>
                  <View style={[styles.previewTableRow, styles.previewTableHead]}>
                    <Text style={[styles.previewTableCell, { flex: 1 }]}>Description</Text>
                    <Text style={[styles.previewTableCell, { flex: 0, width: 50, textAlign: 'center' }]}>Qty</Text>
                    <Text style={[styles.previewTableCell, styles.previewTableRight, { flex: 0, width: 80 }]}>Price</Text>
                    <Text style={[styles.previewTableCell, styles.previewTableRight, { flex: 0, width: 80 }]}>Total</Text>
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

                <View style={styles.totalsCard}>
                  <TotalRow label="Subtotal" value={fmtDecimal(subtotal)} />
                  <TotalRow label="Tax (7%)"  value={fmtDecimal(tax)} />
                  <View style={styles.totalsDivider} />
                  <TotalRow label="Total" value={fmtDecimal(total)} bold />
                </View>

                <View style={styles.saveBtnRow}>
                  <TouchableOpacity
                    style={[styles.saveBtnOutline, (saving || sending) && styles.saveBtnDisabled]}
                    onPress={handleSave}
                    disabled={saving || sending}
                  >
                    {saving
                      ? <ActivityIndicator color={colors.primary} size="small" />
                      : <>
                          <Ionicons name="save-outline" size={18} color={colors.primary} />
                          <Text style={styles.saveBtnOutlineText}>Save</Text>
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
                          <Text style={styles.saveBtnText}>Save & Send</Text>
                        </>}
                  </TouchableOpacity>
                </View>
              </>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
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
      <Text style={styles.previewRowValue}>{value}</Text>
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
  jobCardTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  statusText: { fontSize: 11, fontWeight: '700' },
  jobCardCustomer: { fontSize: 13, color: colors.textSecondary, marginBottom: 3 },
  jobCardCrew: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  invoiceSummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  invoiceSummaryText: { fontSize: 12, color: colors.textMuted },
  editIconBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    padding: 6,
  },
  editJobLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    marginBottom: 16,
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
  detailJobName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  detailJobCustomer: { fontSize: 13, color: '#bbf7d0', marginTop: 2 },
  detailJobAddr: { fontSize: 12, color: '#86efac', marginTop: 2 },
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

  nextBtn: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  nextBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

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

  subtotalBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#f0fdf4', borderRadius: 10, paddingHorizontal: 16,
    paddingVertical: 12, marginTop: 8, marginBottom: 16,
  },
  subtotalLabel: { fontSize: 14, fontWeight: '600', color: colors.primary },
  subtotalValue: { fontSize: 16, fontWeight: '800', color: colors.primary },

  previewHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    backgroundColor: colors.primary, borderRadius: 12, padding: 16, marginBottom: 12,
  },
  previewCompany: { fontSize: 16, fontWeight: '800', color: '#fff' },
  previewCompanySub: { fontSize: 12, color: '#bbf7d0', marginTop: 2 },
  previewInvoiceLabel: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  previewInvoiceLabelText: { fontSize: 12, fontWeight: '800', color: '#fff', letterSpacing: 1 },

  previewMetaRow: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10 },
  previewMetaRight: { alignItems: 'flex-end', gap: 4 },
  previewMetaHead: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 4, letterSpacing: 0.5 },
  previewMetaVal: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  previewMetaSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  previewRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  previewRowLabel: { fontSize: 11, color: colors.textMuted, width: 52, textAlign: 'right' },
  previewRowValue: { fontSize: 12, fontWeight: '600', color: colors.textPrimary },

  previewProjectCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10 },

  previewTable: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', marginBottom: 10 },
  previewTableRow: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  previewTableHead: { backgroundColor: '#f9fafb' },
  previewTableCell: { flex: 1, fontSize: 11, color: colors.textPrimary },
  previewTableRight: { textAlign: 'right', fontWeight: '600' },

  totalsCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 16 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  totalLabel: { fontSize: 14, color: colors.textSecondary },
  totalValue: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  totalLabelBold: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  totalValueBold: { fontSize: 18, fontWeight: '800', color: colors.primary },
  totalsDivider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 8 },

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
  pickerJobTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  pickerJobCustomer: { fontSize: 13, color: colors.textSecondary, marginBottom: 4 },
  pickerJobDateRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickerJobDate: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  pickerJobDateMuted: { fontSize: 12, color: '#d1d5db', fontStyle: 'italic' },
  pickerEmpty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  pickerEmptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  pickerEmptySub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
});
