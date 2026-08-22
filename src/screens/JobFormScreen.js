import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Modal, useWindowDimensions, Linking,
} from 'react-native';
import AppTextInput from '../components/AppTextInput';
import { Image } from 'expo-image';
import { getJobs, saveJob, deleteJob, assignJobId, getJobTypes, getExpenses, saveExpense, saveCustomer } from '../services/db';
import { useAppData } from '../context/AppDataContext';
import { uploadJobPhoto, deleteStoragePhoto, storagePathFromUrl } from '../services/storageService';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../config/firebase';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../utils/permissions';
import { extractJobFromImage } from '../services/aiService';
import { useNavigation, useRoute } from '@react-navigation/native';
import { InteractionManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAuth } from '../context/AuthContext';
import DatePickerField from '../components/DatePickerField';
import AddressAutocomplete from '../components/AddressAutocomplete';
import RoofEstimateModal from '../components/RoofEstimateModal';
import { logActivity } from '../services/activityLog';
import { navigationRef } from '../utils/navigationRef';

const STATUSES = [
  'Not Scheduled', 'Scheduled', 'In Progress',
  'Invoice Ready', 'Invoice Sent', 'Invoice Paid', 'Cancelled',
];

const FALLBACK_JOB_TYPES = ['Roofing', 'Gutters', 'Siding', 'Concrete', 'Painting'];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmtCurrency(n) {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function FormLabel({ text }) {
  return <Text style={styles.formLabel}>{text}</Text>;
}

function SectionHeader({ text }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{text}</Text>
    </View>
  );
}

function PickerSheet({ visible, title, items, onSelect, onClose }) {
  if (!visible) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.pickerSheet}>
        <View style={styles.pickerSheetHeader}>
          <Text style={styles.pickerSheetTitle}>{title}</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <ScrollView>
          {items.map((item) => (
            <TouchableOpacity key={item.key} style={styles.pickerItem} onPress={() => onSelect(item.key)}>
              <Text style={styles.pickerItemLabel}>{item.label}</Text>
              {item.sub ? <Text style={styles.pickerItemSub}>{item.sub}</Text> : null}
            </TouchableOpacity>
          ))}
          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export default function JobFormScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const jobId    = route.params?.jobId    ?? null;
  const returnTo = route.params?.returnTo ?? null;
  const prefill  = route.params?.prefill  ?? null;
  const isEdit   = !!jobId;
  const { canWrite } = useAuth();
  const { crews: contextCrews, jobTypes: contextJobTypes, customers: contextCustomers, activeJobs: contextActiveJobs } = useAppData();

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isPad       = Platform.OS === 'ios' && Platform.isPad;
  const thumbSize   = Math.floor((width - 32 - 12) / 3);

  // Stable job ID for this form instance — new jobs get an ID immediately so
  // background uploads have a path before the job is saved to Firestore.
  const jobInstanceId = useRef(jobId || generateId());

  // Track upload promises by photo key so we can await them on save.
  const uploadPromisesRef = useRef({});
  // Keys of photos removed while still uploading — completion handler cleans Storage.
  const cancelledKeysRef = useRef(new Set());
  // Status the job had when this form was opened — used to detect transitions
  // (currently: log a dedicated entry when status flips to "Invoice Paid").
  const originalStatusRef = useRef('');

  const crews    = contextCrews.length > 0 ? contextCrews : [];
  const jobTypes = contextJobTypes.length > 0 ? contextJobTypes.map((t) => t.name) : FALLBACK_JOB_TYPES;
  const [saving,    setSaving]    = useState(false);
  const [importing, setImporting] = useState(false); // photo→fields extraction in progress
  const [toast,     setToast]     = useState('');
  const [seqId,     setSeqId]     = useState(null); // "YY-####" job ID

  const [projectName,        setProjectName]        = useState('');
  const [jobType,            setJobType]            = useState(isEdit ? '' : 'Roofing');
  const [status,             setStatus]             = useState('Not Scheduled');
  const [targetDate,         setTargetDate]         = useState('');
  const [billToName,         setBillToName]         = useState('');
  const [billToAddress,      setBillToAddress]      = useState('');
  const [email,              setEmail]              = useState('');
  const [phone,              setPhone]              = useState('');
  const [jobLocationAddress, setJobLocationAddress] = useState('');
  const [crewId,             setCrewId]             = useState('');
  const [salesperson,        setSalesperson]        = useState('');
  const [estimatedDuration,  setEstimatedDuration]  = useState('1');
  const [invoiceNumber,      setInvoiceNumber]      = useState('');
  const [invoiceDate,        setInvoiceDate]        = useState('');
  const [dueDate,            setDueDate]            = useState('');
  const [invoiceTotal,       setInvoiceTotal]       = useState('');
  const [jobTotal,           setJobTotal]           = useState('');
  const [notes,              setNotes]              = useState('');

  const [crewLeads,    setCrewLeads]    = useState('1');
  const [crewHelpers,  setCrewHelpers]  = useState('1');
  const [crewWorkers,  setCrewWorkers]  = useState('0');
  const [leadRate,     setLeadRate]     = useState('350');
  const [helperRate,   setHelperRate]   = useState('150');
  const [workerRate,   setWorkerRate]   = useState('250');

  // Photo shape: { key, uri, storageUrl, uploading, failed }
  // key        – stable ID used to track upload promise and cancel state
  // uri        – display source: local file:// URI until upload completes, then storage URL
  // storageUrl – null until upload finishes, then the Firebase download URL
  // uploading  – true while upload is in progress
  // failed     – true if upload encountered an error
  const [photos,      setPhotos]      = useState([]);
  const [removedUrls, setRemovedUrls] = useState([]); // Storage URLs to delete after save

  // Firebase Storage URL of the most-recently-sent invoice PDF. Populated on
  // load from the job doc; powers the "View Invoice" link.
  const [invoicePdfUrl, setInvoicePdfUrl] = useState('');

  // AI roof estimate state — populated from the job doc on load.
  // roofEstimate.status can be 'pending' | 'complete' | 'failed' | undefined.
  const [roofEstimate,          setRoofEstimate]          = useState(null);
  const [aerialPhotoBase64,     setAerialPhotoBase64]     = useState('');
  const [streetViewPhotoBase64, setStreetViewPhotoBase64] = useState('');
  const [showEstimateModal,     setShowEstimateModal]     = useState(false);
  const [estimateLaunching,     setEstimateLaunching]     = useState(false);

  const [showStatusPicker,  setShowStatusPicker]  = useState(false);
  const [showCrewPicker,    setShowCrewPicker]    = useState(false);
  const [showJobTypePicker, setShowJobTypePicker] = useState(false);
  const [viewingPhoto,      setViewingPhoto]      = useState(null);


  const [showLineItemsModal, setShowLineItemsModal] = useState(false);
  const [editLineItems,      setEditLineItems]      = useState([]);
  const [editTaxRate,        setEditTaxRate]        = useState('7');
  const [lineItemsSaving,    setLineItemsSaving]    = useState(false);

  // Customer selector
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [customerSearch,     setCustomerSearch]     = useState('');
  const [isNewCustomer,      setIsNewCustomer]      = useState(false);
  // Each-job recurring expense picker — shown on first save when matching
  // company-recurring expenses exist. User selects which to copy onto this job.
  const [showRecurringPicker,  setShowRecurringPicker]  = useState(false);
  const [recurringCandidates,  setRecurringCandidates]  = useState([]);
  const [selectedRecurringIds, setSelectedRecurringIds] = useState(() => new Set());
  const [pendingNavInfo,       setPendingNavInfo]       = useState(null);

  useEffect(() => {
    async function loadData() {
      try {
        if (isEdit) {
          const jobs = await getJobs();
          const job  = jobs.find((j) => j.id === jobId);
          if (job) {
            setSeqId(job.jobId || null);
            setProjectName(job.projectName || '');
            setJobType(job.jobType || '');
            setStatus(job.status || 'Not Scheduled');
            originalStatusRef.current = job.status || '';
            setTargetDate(job.targetDate || '');
            setBillToName(job.billToName || '');
            setBillToAddress(job.billToAddress || '');
            setEmail(job.email || '');
            setPhone(job.phone || '');
            setJobLocationAddress(job.jobLocationAddress || '');
            // Sync the address-change watcher baseline. Synchronous ref write
            // happens before React re-renders, so the watcher's first run sees
            // matching values and doesn't fire a spurious alert.
            prevAddressRef.current = job.jobLocationAddress || '';
            setCrewId(job.crewId || '');
            setSalesperson(job.salesperson || '');
            setEstimatedDuration(job.estimatedDuration || '1');
            setInvoiceNumber(job.invoiceNumber || '');
            setInvoiceDate(job.invoiceDate || '');
            setDueDate(job.dueDate || '');
            setInvoiceTotal(job.invoiceTotal != null ? String(job.invoiceTotal) : '');
            // Job Total: prefer an explicit jobTotal; otherwise, when an
            // Apollonia invoice exists, seed it from the invoice total amount.
            setJobTotal(
              job.jobTotal != null ? String(job.jobTotal)
                : (job.invoicePdfUrl && job.invoiceTotal != null ? String(job.invoiceTotal) : ''),
            );
            setInvoicePdfUrl(job.invoicePdfUrl || '');
            setRoofEstimate(job.roofEstimate || null);
            setAerialPhotoBase64(job.aerialPhotoBase64 || '');
            setStreetViewPhotoBase64(job.streetViewPhotoBase64 || '');
            setNotes(job.notes || '');
            setCrewLeads(job.crewLeads != null ? String(job.crewLeads) : '1');
            setCrewHelpers(job.crewHelpers != null ? String(job.crewHelpers) : '1');
            if (job.crewWorkers != null) {
              setCrewWorkers(String(job.crewWorkers));
            } else if (job.crewId) {
              const assignedCrew = crews.find((c) => c.id === job.crewId);
              setCrewWorkers(assignedCrew ? String(Math.max(0, (assignedCrew.members || []).length - 1)) : '0');
            } else {
              setCrewWorkers('0');
            }
            setLeadRate(job.leadDailyRate   != null ? String(job.leadDailyRate)   : '350');
            setHelperRate(job.helperDailyRate != null ? String(job.helperDailyRate) : '150');
            setWorkerRate(job.workerDailyRate != null ? String(job.workerDailyRate) : '250');

            if (job.photos && job.photos.length > 0) {
              // Legacy entries are bare URL strings; newer (incl. AI-added) are
              // { uri, label, createdAt } objects. Normalize both shapes and
              // carry label/createdAt forward so the save path can round-trip
              // them — without this they'd be stripped on the next save.
              setPhotos(job.photos.map((entry) => {
                const isObj = typeof entry === 'object' && entry !== null;
                const url   = isObj ? (entry.uri || '') : entry;
                return {
                  key:        url.split('/').pop().split('?')[0] || generateId(),
                  uri:        url,
                  storageUrl: url,
                  uploading:  false,
                  failed:     false,
                  ...(isObj && entry.label     ? { label:     entry.label     } : {}),
                  ...(isObj && entry.createdAt ? { createdAt: entry.createdAt } : {}),
                };
              }));
            }

          }
        } else if (prefill) {
          // New job pre-filled from AI assistant (voice flow or smart create)
          if (prefill.billToName) {
            setBillToName(prefill.billToName);
            // Only mark as a brand-new customer when the caller hasn't already
            // resolved the customer against the existing list.
            setIsNewCustomer(!prefill.isExistingCustomer);
          }
          if (prefill.billToAddress)      setBillToAddress(prefill.billToAddress);
          if (prefill.email)              setEmail(prefill.email);
          if (prefill.phone)              setPhone(prefill.phone);
          if (prefill.jobType)            setJobType(prefill.jobType);
          if (prefill.jobLocationAddress) setJobLocationAddress(prefill.jobLocationAddress);
          prevAddressRef.current = prefill.jobLocationAddress || '';
          if (prefill.targetDate)         setTargetDate(prefill.targetDate);
          if (prefill.crewId)             setCrewId(prefill.crewId);
          if (prefill.salesperson)        setSalesperson(prefill.salesperson);
        }
      } catch { /* ignore */ }
    }
    loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Customer picker list — sourced from context (customers collection + any
  // historic billToName values found on active jobs). Recomputes only when the
  // upstream context references change; no Firestore reads on form open.
  const allCustomers = useMemo(() => {
    const map = {};
    for (const c of contextCustomers) {
      if (c.name && !c.archived) map[c.name] = c;
    }
    for (const j of contextActiveJobs) {
      const n = j.billToName?.trim();
      if (n && !map[n]) {
        map[n] = { id: n, name: n, address: j.billToAddress || '', email: j.email || '', phone: j.phone || '', salesperson: j.salesperson || '' };
      }
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [contextCustomers, contextActiveJobs]);

  // Start background uploads for an array of new photo entries.
  // Each upload resolves to the storage URL or null on failure.
  const startPhotoUploads = useCallback((newEntries) => {
    const id = jobInstanceId.current;
    for (const entry of newEntries) {
      const filename = entry.key + '.jpg';
      uploadPromisesRef.current[entry.key] = uploadJobPhoto(entry.uri, id, filename)
        .then((url) => {
          if (cancelledKeysRef.current.has(entry.key)) {
            // Photo was removed before upload finished — clean up Storage immediately
            const path = storagePathFromUrl(url);
            if (path) deleteStoragePhoto(path).catch((err) => console.warn('[JobForm] storage cleanup failed:', err.message));
            return null;
          }
          // Replace local URI with Firebase URL so the tile uses the durable URL
          setPhotos((prev) => prev.map((p) =>
            p.key === entry.key
              ? { ...p, storageUrl: url, uri: url, uploading: false }
              : p,
          ));
          return url;
        })
        .catch((err) => {
          console.warn('[JobForm] photo upload failed:', err.message);
          if (!cancelledKeysRef.current.has(entry.key)) {
            setPhotos((prev) => prev.map((p) =>
              p.key === entry.key ? { ...p, uploading: false, failed: true } : p,
            ));
            // Toast surfaces the failure — without it, the user only sees a small
            // red overlay on the tile and might miss it among other photos.
            setToast('Photo upload failed — tap the red icon to retry');
            setTimeout(() => setToast(''), 3500);
          }
          return null;
        });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry a single failed upload — clears the failed flag and re-runs the
  // standard upload pipeline for just that entry.
  const retryPhotoUpload = useCallback((photo) => {
    setPhotos((prev) => prev.map((p) =>
      p.key === photo.key ? { ...p, uploading: true, failed: false } : p,
    ));
    startPhotoUploads([{ key: photo.key, uri: photo.uri }]);
  }, [startPhotoUploads]);

  const handleAddPhotos = () => {
    Alert.alert('Add Photos', '', [
      { text: 'Take Photo',           onPress: pickFromCamera  },
      { text: 'Choose from Library',  onPress: pickFromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickFromLibrary = useCallback(async () => {
    if (photos.length >= 25) { Alert.alert('Limit Reached', 'Maximum 25 photos per job.'); return; }
    if (!(await requestPhotoLibraryPermission())) return;
    const remaining = 25 - photos.length;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1, // storageService compresses to 1200px / 0.70 quality
    });
    if (!result.canceled) {
      const newEntries = result.assets.map((a) => ({
        key:        Date.now() + '_' + Math.random().toString(36).slice(2),
        uri:        a.uri,
        storageUrl: null,
        uploading:  true,
        failed:     false,
      }));
      setPhotos((prev) => [...prev, ...newEntries].slice(0, 25));
      startPhotoUploads(newEntries);
    }
  }, [photos.length, startPhotoUploads]);

  const pickFromCamera = useCallback(async () => {
    if (photos.length >= 25) { Alert.alert('Limit Reached', 'Maximum 25 photos per job.'); return; }
    if (!(await requestCameraPermission())) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (!result.canceled) {
      const asset = result.assets[0];
      const entry = {
        key:        Date.now() + '_' + Math.random().toString(36).slice(2),
        uri:        asset.uri,
        storageUrl: null,
        uploading:  true,
        failed:     false,
      };
      setPhotos((prev) => [...prev, entry].slice(0, 25));
      startPhotoUploads([entry]);
    }
  }, [photos.length, startPhotoUploads]);

  // ── Import job details from a photo/screenshot (Claude Vision) ──────────────
  // Fills matching form fields from a subcontractor job-assignment screenshot.
  const applyImportedFields = useCallback((fields) => {
    if (!fields || typeof fields !== 'object') return;

    if (fields.projectName)        setProjectName(String(fields.projectName));
    if (fields.jobLocationAddress) setJobLocationAddress(String(fields.jobLocationAddress));
    if (fields.targetDate)         setTargetDate(String(fields.targetDate));
    if (fields.jobType)            setJobType(String(fields.jobType));
    if (fields.billToName)         setBillToName(String(fields.billToName));

    // Homeowner name is for notes only — prepend it to the instructions text.
    const noteParts = [];
    if (fields.homeownerName) noteParts.push(`Homeowner: ${String(fields.homeownerName)}`);
    if (fields.notes)         noteParts.push(String(fields.notes));
    if (noteParts.length)     setNotes(noteParts.join('\n'));

    // If the billing customer matches an existing customer, pull their profile.
    if (fields.billToName) {
      const target = String(fields.billToName).trim().toLowerCase();
      const match  = (contextCustomers || []).find(
        (c) => (c.name || '').trim().toLowerCase() === target,
      );
      if (match) {
        if (match.address)     setBillToAddress(match.address);
        if (match.email)       setEmail(match.email);
        if (match.phone)       setPhone(match.phone);
        if (match.salesperson) setSalesperson(match.salesperson);
      }
    }
  }, [contextCustomers]);

  const importFromPhoto = useCallback(async (source) => {
    try {
      let result;
      if (source === 'camera') {
        if (!(await requestCameraPermission())) return;
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
      } else {
        if (!(await requestPhotoLibraryPermission())) return;
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
      }
      if (result.canceled) return;

      setImporting(true);
      // Resize + JPEG-compress to base64 — keeps the vision payload small while
      // preserving enough resolution to read the screenshot text.
      const manipulated = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1280 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      const fields = await extractJobFromImage({ base64: manipulated.base64, mediaType: 'image/jpeg' });
      applyImportedFields(fields);
      setToast('Job imported — please review fields');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      Alert.alert('Import failed', err.message || 'Could not read the job details from that image.');
    } finally {
      setImporting(false);
    }
  }, [applyImportedFields]);

  const handleImportFromPhoto = useCallback(() => {
    Alert.alert('Import from Photo', 'Read job details from a screenshot.', [
      { text: 'Take Photo',          onPress: () => importFromPhoto('camera') },
      { text: 'Choose from Library', onPress: () => importFromPhoto('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [importFromPhoto]);

  const handleDeletePhoto = useCallback((index) => {
    Alert.alert('Remove Photo', 'Remove this photo from the job?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => {
          setPhotos((prev) => {
            const photo = prev[index];
            if (photo.storageUrl) {
              // Existing storage photo — queue for deletion after save
              setRemovedUrls((urls) => [...urls, photo.storageUrl]);
            }
            if (photo.uploading) {
              // Still in flight — completion handler will clean up Storage
              cancelledKeysRef.current.add(photo.key);
            }
            return prev.filter((_, i) => i !== index);
          });
        },
      },
    ]);
  }, []);

  // Back-fill empty contact fields on an EXISTING job from the customer
  // profile. Older jobs were created before some fields (phone, email) lived
  // on the customer doc, so reopening the form should hydrate any missing
  // values without ever overwriting what the job already has.
  const backFilledForRef = useRef(null);
  useEffect(() => {
    if (!isEdit) return;
    if (!billToName) return;
    if (backFilledForRef.current === billToName) return;
    const customer = contextCustomers.find(
      (c) => !c.archived && c.name?.toLowerCase() === billToName.toLowerCase(),
    );
    if (!customer) return;
    backFilledForRef.current = billToName;
    if (!billToAddress && customer.address)     setBillToAddress(customer.address);
    if (!email        && customer.email)        setEmail(customer.email);
    if (!phone        && customer.phone)        setPhone(customer.phone);
    if (!salesperson  && customer.salesperson)  setSalesperson(customer.salesperson);
  }, [isEdit, billToName, contextCustomers, billToAddress, email, phone, salesperson]);

  // Clearing the target date while status is "Scheduled" violates the business
  // rule that Scheduled requires a date — auto-downgrade to "Not Scheduled" so
  // the form stays in a consistent state without waiting for the save guard.
  // Inverse: setting a target date while status is "" or "Not Scheduled"
  // auto-upgrades to "Scheduled" (matches what the form does on initial save).
  const handleTargetDateChange = useCallback((next) => {
    const trimmed = String(next || '').trim();
    setTargetDate(next || '');
    if (!trimmed && status === 'Scheduled') {
      setStatus('Not Scheduled');
      return;
    }
    if (trimmed && (!status || status === 'Not Scheduled')) {
      setStatus('Scheduled');
    }
  }, [status]);

  const handleSave = async () => {
    if (!canWrite('jobs')) {
      Alert.alert('Access Restricted', 'Your role does not allow editing jobs.');
      return;
    }
    if (!projectName.trim()) {
      Alert.alert('Required', 'Project Name is required.');
      return;
    }
    if (status === 'Scheduled' && !targetDate.trim()) {
      Alert.alert('Target Date Required', 'A target date is required for Scheduled status. Set a target date or change the status.');
      return;
    }
    if (status === 'In Progress') {
      const td = targetDate.trim();
      const d  = new Date();
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!td || td > todayStr) {
        Alert.alert('Invalid Date', 'In Progress jobs must have a target date that is today or earlier.');
        return;
      }
    }

    // Guard against reverting a job's status backward after it's already been
    // invoiced/paid — the live Firestore value can be ahead of this form's
    // local `status` state if it was advanced elsewhere (a batch send, Mark
    // Paid) while this screen was open. Unlike the invoice wizard's silent
    // preserve, this is a deliberate status-field edit, so confirm rather
    // than silently drop it.
    const liveStatus = contextActiveJobs.find((j) => j.id === jobInstanceId.current)?.status || '';
    const effectiveStatusForCheck = (!isEdit && targetDate.trim() && (!status || status === 'Not Scheduled'))
      ? 'Scheduled'
      : (status || 'Not Scheduled');
    const liveIdx   = STATUSES.indexOf(liveStatus);
    const targetIdx = STATUSES.indexOf(effectiveStatusForCheck);
    const isBackwardFromInvoiced =
      (liveStatus === 'Invoice Sent' || liveStatus === 'Invoice Paid')
      && liveIdx !== -1 && targetIdx !== -1 && targetIdx < liveIdx;

    if (isBackwardFromInvoiced) {
      Alert.alert(
        'Status Change',
        'This job has already been invoiced. Are you sure you want to change the status?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change Status', style: 'destructive', onPress: () => doSave() },
        ],
      );
      return;
    }

    doSave();
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const id = jobInstanceId.current;

      let currentSeqId = seqId;
      if (!isEdit && !currentSeqId) {
        try {
          currentSeqId = await assignJobId();
          setSeqId(currentSeqId);
        } catch (err) {
          console.warn('[JobForm] assignJobId failed:', err.message);
        }
      }

      // Collect final photo entries as objects so label/createdAt round-trip
      // through saves (instead of being stripped to bare URL strings). Still
      // awaits any in-flight uploads in parallel — failed photos are excluded.
      const photoEntryPromises = photos.map(async (photo) => {
        let url = photo.storageUrl;
        if (!url && photo.uploading && uploadPromisesRef.current[photo.key]) {
          url = await uploadPromisesRef.current[photo.key];
        }
        if (!url) return null; // failed upload — exclude
        return {
          uri: url,
          ...(photo.label     ? { label:     photo.label     } : {}),
          ...(photo.createdAt ? { createdAt: photo.createdAt } : {}),
        };
      });
      const rawEntries   = await Promise.all(photoEntryPromises);
      const photoEntries = rawEntries.filter(Boolean);

      // On new jobs with a target date, auto-promote the default "Not Scheduled"
      // status to "Scheduled". Edits and user-chosen statuses are left alone.
      const effectiveStatus = (!isEdit && targetDate.trim() && (!status || status === 'Not Scheduled'))
        ? 'Scheduled'
        : (status || 'Not Scheduled');

      const jobData = {
        id,
        ...(currentSeqId ? { jobId: currentSeqId } : {}),
        projectName:        projectName.trim(),
        jobType:            jobType.trim(),
        status:             effectiveStatus,
        targetDate:         targetDate.trim(),
        billToName:         billToName.trim(),
        billToAddress:      billToAddress.trim(),
        email:              email.trim(),
        phone:              phone.trim(),
        jobLocationAddress: jobLocationAddress.trim(),
        crewId:             crewId || '',
        salesperson:        salesperson.trim(),
        estimatedDuration:  estimatedDuration.trim(),
        invoiceNumber:      invoiceNumber.trim(),
        invoiceDate:        invoiceDate.trim(),
        dueDate:            dueDate.trim(),
        invoiceTotal:       invoiceTotal ? parseFloat(invoiceTotal) : null,
        jobTotal:           jobTotal ? parseFloat(jobTotal) : null,
        notes:              notes.trim(),
        photos:             photoEntries,
        photoCount:         photoEntries.length,
        crewLeads:          parseInt(crewLeads)    || 0,
        crewHelpers:        parseInt(crewHelpers)  || 0,
        crewWorkers:        parseInt(crewWorkers)  || 0,
        leadDailyRate:      parseFloat(leadRate)   || 0,
        helperDailyRate:    parseFloat(helperRate) || 0,
        workerDailyRate:    parseFloat(workerRate) || 0,
        crewCost:           crewCostTotal,
      };

      await saveJob(jobData);

      // Save new customer to customers collection if "NEW CUSTOMER" was selected
      if (isNewCustomer && billToName.trim()) {
        const custId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        saveCustomer({
          id:          custId,
          name:        billToName.trim(),
          address:     billToAddress.trim(),
          email:       email.trim(),
          phone:       phone.trim(),
          salesperson: salesperson.trim(),
          updatedAt:   new Date().toISOString(),
        }).catch((err) => console.warn('[JobForm] saveCustomer failed:', err.message));
        setIsNewCustomer(false);
      }

      const seqLabel = currentSeqId ? ` [${currentSeqId}]` : '';
      logActivity(isEdit ? 'job_updated' : 'job_created', `${isEdit ? 'Updated' : 'Created'} job: ${jobData.projectName}${seqLabel}`);

      if (effectiveStatus === 'Invoice Paid' && originalStatusRef.current !== 'Invoice Paid') {
        logActivity('invoice_paid', `Invoice paid — ${jobData.projectName || 'job'}${jobData.billToName ? ` (${jobData.billToName})` : ''}${seqLabel}`);
        originalStatusRef.current = 'Invoice Paid';
      }

      // First-time save → check for "Each Job" recurring company expenses.
      // If any exist, hand off to the picker modal; the modal's Confirm/Skip
      // path will run the photo cleanup + navigation tail.
      if (!isEdit) {
        try {
          const allExp = await getExpenses();
          const candidates = allExp.filter(
            (e) => e.recurring === true && e.recurringFrequency === 'each_job',
          );
          if (candidates.length > 0) {
            setRecurringCandidates(candidates);
            setSelectedRecurringIds(new Set(candidates.map((e) => e.id)));
            setPendingNavInfo({ id, returnTo });
            setShowRecurringPicker(true);
            return; // bail out — modal will finalize
          }
        } catch (err) {
          console.warn('[JobForm] recurring-expense lookup failed:', err.message);
        }
      }

      finalizeAfterSave(id, returnTo);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save job.');
    } finally {
      setSaving(false);
    }
  };

  // Photo cleanup + navigation tail shared by direct-save path and the
  // recurring-expense picker's Confirm / Skip paths.
  const finalizeAfterSave = useCallback((id, returnTo) => {
    for (const url of removedUrls) {
      const path = storagePathFromUrl(url);
      if (path) deleteStoragePhoto(path).catch(() => {});
    }
    setRemovedUrls([]);

    if (returnTo === 'invoiceDetails' || returnTo === 'invoicePreview') {
      navigation.goBack();
      InteractionManager.runAfterInteractions(() => {
        navigationRef.navigate('Invoice', { preselectedJobId: id });
      });
    } else {
      setToast('Job saved');
      setTimeout(() => {
        setToast('');
        navigation.goBack();
      }, 700);
    }
  }, [removedUrls, navigation]);

  // ── AI Roof Estimator ──────────────────────────────────────────────────────
  //
  // Tap "Get Estimate" → geocode address → flip status to 'pending' in
  // Firestore + locally → fire the roofEstimator callable (NOT awaited).
  // The Cloud Function does the slow work in the background and writes the
  // final roofEstimate + photos to the job doc, then pushes a notification.
  // The user is told to expect the push; the form will reflect the new state
  // next time it loads the job.

  const runRoofEstimate = useCallback(async () => {
    const trimmed = jobLocationAddress.trim();
    if (!trimmed) {
      Alert.alert('Address Required', 'Add the job location address before requesting an estimate.');
      return;
    }
    setEstimateLaunching(true);
    try {
      const jobId = jobInstanceId.current;
      const pendingEstimate = { status: 'pending' };

      // Optimistic write — button flips to "Estimating…" immediately.
      try {
        await saveJob({ id: jobId, roofEstimate: pendingEstimate });
      } catch (writeErr) {
        console.warn('[RoofEstimate] could not write pending state:', writeErr.message);
      }
      setRoofEstimate(pendingEstimate);

      // Fire-and-forget — the Cloud Function geocodes server-side using the
      // function's GOOGLE_MAPS_KEY (the client key was being blocked). The
      // estimate takes 10-30s; result + push surface the outcome on completion.
      httpsCallable(functions, 'roofEstimator')({
        jobId,
        address: trimmed,
      }).catch((err) => {
        console.warn('[RoofEstimate] callable failed:', err?.message || err);
      });

      setToast("Estimating in background — you'll be notified when done.");
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not start the roof estimate.');
    } finally {
      setEstimateLaunching(false);
    }
  }, [jobLocationAddress]);

  const handleGetEstimate = useCallback(() => {
    if (roofEstimate?.status === 'complete') {
      Alert.alert(
        'Replace Estimate?',
        'An estimate already exists. Replace it?',
        [
          { text: 'Cancel',  style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: runRoofEstimate },
        ],
      );
      return;
    }
    runRoofEstimate();
  }, [roofEstimate, runRoofEstimate]);

  const handleApplyEstimateToLineItems = useCallback(async () => {
    if (!roofEstimate || roofEstimate.status !== 'complete') return;
    const squares = Number(roofEstimate.squares) || 0;
    if (squares <= 0) return;
    try {
      const jobs = await getJobs();
      const job  = jobs.find((j) => j.id === jobInstanceId.current);
      const existing = (job?.lineItems || []).map((i) => ({
        description: i.description,
        qty:         Number(i.qty) || 0,
        unitPrice:   Number(i.unitPrice) || 0,
      }));
      const idx = existing.findIndex((i) => /roof/i.test(i.description || ''));
      let nextItems;
      if (idx >= 0) {
        nextItems = existing.map((item, i) => i === idx ? { ...item, qty: squares } : item);
      } else {
        nextItems = [...existing, { description: 'Roofing (estimated)', qty: squares, unitPrice: 0 }];
      }
      await saveJob({ id: jobInstanceId.current, lineItems: nextItems });
      setShowEstimateModal(false);
      setToast('Line items updated');
      setTimeout(() => setToast(''), 1500);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not update line items.');
    }
  }, [roofEstimate]);

  // Shared between the modal "Discard Estimate" button and the address-change
  // alert's "Remove" action. Removes roofEstimate + base64 fields from the job,
  // strips AI photos from the photos array, cleans up Storage best-effort,
  // and resets local state. Set closeModal=true when called from the modal.
  const clearRoofEstimate = useCallback(async ({ closeModal = false } = {}) => {
    try {
      const jobs = await getJobs();
      const job  = jobs.find((j) => j.id === jobInstanceId.current);
      const currentPhotos = job?.photos || [];

      // URLs of AI-added photos so we can purge them from Storage afterwards.
      const aiUrls = currentPhotos
        .filter((p) => typeof p === 'object' && p && (p.label === 'AI Aerial View' || p.label === 'AI Street View'))
        .map((p) => p.uri)
        .filter(Boolean);

      const filteredPhotos = currentPhotos.filter((p) => {
        if (typeof p === 'string') return true;
        return p?.label !== 'AI Aerial View' && p?.label !== 'AI Street View';
      });

      await saveJob({
        id:                   jobInstanceId.current,
        roofEstimate:         null,
        aerialPhotoBase64:    '',
        streetViewPhotoBase64: '',
        photos:               filteredPhotos,
        photoCount:           filteredPhotos.length,
      });

      // Best-effort Storage cleanup so the AI files don't orphan.
      for (const url of aiUrls) {
        const path = storagePathFromUrl(url);
        if (path) deleteStoragePhoto(path).catch(() => {});
      }

      setRoofEstimate(null);
      setAerialPhotoBase64('');
      setStreetViewPhotoBase64('');
      setPhotos(filteredPhotos.map((entry) => {
        const isObj = typeof entry === 'object' && entry !== null;
        const url   = isObj ? (entry.uri || '') : entry;
        return {
          key:        url.split('/').pop().split('?')[0] || generateId(),
          uri:        url,
          storageUrl: url,
          uploading:  false,
          failed:     false,
          ...(isObj && entry.label     ? { label:     entry.label     } : {}),
          ...(isObj && entry.createdAt ? { createdAt: entry.createdAt } : {}),
        };
      }));

      if (closeModal) setShowEstimateModal(false);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not discard the estimate.');
    }
  }, []);

  const handleDiscardEstimate = useCallback(() => {
    Alert.alert(
      'Discard Estimate',
      'Discard this estimate? The aerial and street view photos will also be removed from the job.',
      [
        { text: 'Cancel',  style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => clearRoofEstimate({ closeModal: true }) },
      ],
    );
  }, [clearRoofEstimate]);

  // CHANGE 3 — Address-change watcher fires only on blur (when the user
  // commits/leaves the address field), not on every keystroke. prevAddressRef
  // tracks the last committed address; we sync it in loadData so the first
  // blur after a fresh load is a no-op.
  const prevAddressRef = useRef('');
  const handleAddressBlur = useCallback(() => {
    if (jobLocationAddress === prevAddressRef.current) return;
    const status = roofEstimate?.status;
    if (status !== 'complete' && status !== 'failed') {
      // No estimate to invalidate — just track the new committed value.
      prevAddressRef.current = jobLocationAddress;
      return;
    }
    Alert.alert(
      'Address Changed',
      'Address changed — remove existing estimate and photos?',
      [
        {
          text: 'Cancel', style: 'cancel',
          onPress: () => setJobLocationAddress(prevAddressRef.current),
        },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            await clearRoofEstimate({ closeModal: false });
            prevAddressRef.current = jobLocationAddress;
          },
        },
      ],
    );
  }, [jobLocationAddress, roofEstimate, clearRoofEstimate]);

  // Show the estimate button only for roofing jobs with an address on file.
  const isRoofingJob   = /roof/i.test(jobType || '');
  const showEstimateBtn = isRoofingJob && jobLocationAddress.trim().length > 0;
  const estimateStatus = roofEstimate?.status;

  const toggleRecurringSelection = useCallback((expenseId) => {
    setSelectedRecurringIds((prev) => {
      const next = new Set(prev);
      if (next.has(expenseId)) next.delete(expenseId);
      else next.add(expenseId);
      return next;
    });
  }, []);

  const handleConfirmRecurring = useCallback(async () => {
    if (!pendingNavInfo) return;
    const { id: newJobId, returnTo } = pendingNavInfo;
    const todayIso = new Date().toISOString().slice(0, 10);
    for (const parent of recurringCandidates) {
      if (!selectedRecurringIds.has(parent.id)) continue;
      try {
        const childId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await saveExpense({
          id:                childId,
          type:              'job',
          jobId:             newJobId,
          jobName:           projectName.trim() || '',
          date:              todayIso,
          amount:            Number(parent.amount) || 0,
          description:       parent.description || '',
          category:          parent.category || 'Other',
          addToInvoice:      false,
          isCrewCost:        false,
          recurring:         false,
          recurringParentId: parent.id,
        });
      } catch (err) {
        console.warn('[JobForm] saveExpense (recurring child) failed:', err.message);
      }
    }
    setShowRecurringPicker(false);
    setRecurringCandidates([]);
    setSelectedRecurringIds(new Set());
    setPendingNavInfo(null);
    finalizeAfterSave(newJobId, returnTo);
  }, [pendingNavInfo, recurringCandidates, selectedRecurringIds, projectName, finalizeAfterSave]);

  const handleSkipRecurring = useCallback(() => {
    if (!pendingNavInfo) return;
    const { id: newJobId, returnTo } = pendingNavInfo;
    setShowRecurringPicker(false);
    setRecurringCandidates([]);
    setSelectedRecurringIds(new Set());
    setPendingNavInfo(null);
    finalizeAfterSave(newJobId, returnTo);
  }, [pendingNavInfo, finalizeAfterSave]);

  const handleDelete = () => {
    if (!canWrite('jobs')) {
      Alert.alert('Access Restricted', 'Your role does not allow deleting jobs.');
      return;
    }
    Alert.alert('Delete Job', 'Permanently delete this job?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await deleteJob(jobId);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  const handleOpenLineItems = async () => {
    try {
      const jobs = await getJobs();
      const job  = jobs.find((j) => j.id === jobId);
      if (job && job.lineItems && job.lineItems.length > 0) {
        setEditLineItems(job.lineItems.map((i) => ({
          description: i.description,
          qty:         String(i.qty ?? 0),
          unitPrice:   String(i.unitPrice ?? 0),
        })));
        setEditTaxRate(job.taxRate != null ? String(job.taxRate) : '7');
      } else {
        let baseItems = [];
        if (jobType) {
          try {
            const allTypes = await getJobTypes();
            const typeConfig = allTypes.find((t) => (t.name || '').toLowerCase() === jobType.toLowerCase());
            if (typeConfig && typeConfig.lineItems && typeConfig.lineItems.length > 0) {
              baseItems = typeConfig.lineItems.map((i) => ({
                description: i.description,
                qty:         String(i.qty ?? 0),
                unitPrice:   String(i.unitPrice ?? 0),
              }));
            }
          } catch { /* fall through */ }
        }
        try {
          const allExp = await getExpenses();
          const jobExp = allExp.filter((e) => e.jobId === jobId && e.addToInvoice === true);
          const expItems = jobExp.map((e) => ({
            description: e.description || e.category || 'Expense',
            qty:         '1',
            unitPrice:   String(e.amount || 0),
          }));
          setEditLineItems([...baseItems, ...expItems]);
        } catch {
          setEditLineItems(baseItems);
        }
        setEditTaxRate('7');
      }
    } catch { /* show empty */ }
    setShowLineItemsModal(true);
  };

  const handleSaveLineItems = async () => {
    setLineItemsSaving(true);
    try {
      const taxRateNum = parseFloat(editTaxRate) || 0;
      const cleanItems = editLineItems.map((i) => ({
        description: i.description,
        qty:         parseFloat(i.qty) || 0,
        unitPrice:   parseFloat(i.unitPrice) || 0,
      }));
      await saveJob({ id: jobInstanceId.current, lineItems: cleanItems, taxRate: taxRateNum });
      setToast('Line items saved');
      setTimeout(() => setToast(''), 1500);
      setShowLineItemsModal(false);
    } catch (err) {
      Alert.alert('Error', 'Could not save line items: ' + err.message);
    } finally {
      setLineItemsSaving(false);
    }
  };

  const selectedCrew = crews.find((c) => c.id === crewId);

  const filteredCustomers = (() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return allCustomers;
    return allCustomers.filter((c) => c.name.toLowerCase().includes(q));
  })();

  const crewCostTotal = (
    (parseFloat(crewLeads)   || 0) * (parseFloat(leadRate)   || 0) +
    (parseFloat(crewHelpers) || 0) * (parseFloat(helperRate) || 0) +
    (parseFloat(crewWorkers) || 0) * (parseFloat(workerRate) || 0)
  ) * (parseFloat(estimatedDuration) || 1);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => {
              if (returnTo === 'invoiceDetails' || returnTo === 'invoicePreview') {
                navigation.goBack();
                InteractionManager.runAfterInteractions(() => {
                  navigationRef.navigate('Invoice', { preselectedJobId: jobId });
                });
              } else {
                navigation.goBack();
              }
            }}
            style={styles.headerBtn}
          >
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isEdit ? 'Edit Job' : 'New Job'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.headerBtn}>
            {saving
              ? <ActivityIndicator color={colors.primary} size="small" />
              : <Text style={styles.headerSave}>Save</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={[styles.content, isPad && styles.contentPad]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {seqId ? (
            <Text style={styles.jobIdBadge}>Job {seqId}</Text>
          ) : null}

          {!isEdit && (
            <TouchableOpacity
              style={styles.importBtn}
              onPress={handleImportFromPhoto}
              disabled={importing}
              activeOpacity={0.7}
            >
              {importing ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Ionicons name="scan-outline" size={18} color={colors.primary} />
              )}
              <Text style={styles.importBtnText}>
                {importing ? 'Reading photo…' : 'Import from Photo'}
              </Text>
            </TouchableOpacity>
          )}

          {/* ── JOB INFO ──────────────────────────────────────────────── */}
          <SectionHeader text="JOB INFO" />

          <FormLabel text="PROJECT NAME *" />
          <View style={styles.inputCard}>
            <AppTextInput style={styles.input} value={projectName} onChangeText={setProjectName} placeholder="e.g. Front Yard Concrete" placeholderTextColor={colors.textMuted} returnKeyType="next" />
          </View>

          <FormLabel text="JOB TYPE" />
          <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowJobTypePicker(true)}>
            <Text style={jobType ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
              {jobType || 'Select job type…'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
          </TouchableOpacity>

          <FormLabel text="TARGET DATE" />
          <DatePickerField value={targetDate} onChange={handleTargetDateChange} placeholder="Select target date…" />

          <FormLabel text="STATUS" />
          <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowStatusPicker(true)}>
            <Text style={status ? styles.pickerBtnValue : styles.pickerBtnPlaceholder}>{status || 'Select status…'}</Text>
            <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
          </TouchableOpacity>

          <FormLabel text="CUSTOMER / BILL TO" />
          <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowCustomerPicker(true)}>
            <Text style={billToName ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
              {isNewCustomer ? 'New Customer' : (billToName || 'Select or add customer…')}
            </Text>
            {billToName && !isNewCustomer ? (
              <TouchableOpacity
                onPress={() => { setBillToName(''); setBillToAddress(''); setEmail(''); setPhone(''); setSalesperson(''); setIsNewCustomer(false); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : (
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            )}
          </TouchableOpacity>

          {/* Name field shown for new customer or when no customer selected.
              billToAddress / email / phone / salesperson are auto-populated in
              state on customer selection but intentionally NOT rendered here. */}
          {(isNewCustomer || !billToName) && (
            <>
              <FormLabel text="CUSTOMER NAME" />
              <View style={styles.inputCard}>
                <AppTextInput style={styles.input} value={billToName} onChangeText={setBillToName} placeholder="Full customer name" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </>
          )}

          <FormLabel text="JOB LOCATION ADDRESS" />
          <AddressAutocomplete
            value={jobLocationAddress}
            onChangeText={setJobLocationAddress}
            onBlur={handleAddressBlur}
            placeholder="Site address"
            placeholderTextColor={colors.textMuted}
          />

          {/* ── CREW ──────────────────────────────────────────────────── */}
          <SectionHeader text="CREW" />

          <FormLabel text="ESTIMATED DURATION DAYS" />
          <View style={styles.inputCard}>
            <AppTextInput style={styles.input} value={estimatedDuration} onChangeText={setEstimatedDuration} placeholder="e.g. 2" placeholderTextColor={colors.textMuted} returnKeyType="next" keyboardType="numbers-and-punctuation" />
          </View>

          <FormLabel text="CREW" />
          <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowCrewPicker(true)}>
            <Text style={crewId ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
              {selectedCrew ? selectedCrew.name : 'Select crew…'}
            </Text>
            {crewId ? (
              <TouchableOpacity onPress={() => setCrewId('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : (
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            )}
          </TouchableOpacity>

          {/* Crew Assignment & Pay — internal only, never shown on invoice */}
          <FormLabel text="CREW ASSIGNMENT & PAY (INTERNAL)" />
          <View style={styles.crewCostCard}>
            <View style={styles.crewCostRow}>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Leads</Text>
                <AppTextInput
                  style={styles.crewCostInput}
                  value={crewLeads}
                  onChangeText={setCrewLeads}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Helpers</Text>
                <AppTextInput
                  style={styles.crewCostInput}
                  value={crewHelpers}
                  onChangeText={setCrewHelpers}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Workers</Text>
                <AppTextInput
                  style={styles.crewCostInput}
                  value={crewWorkers}
                  onChangeText={setCrewWorkers}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
            </View>

            <View style={styles.crewCostDivider} />

            <View style={styles.crewCostRow}>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}>Lead $/Day</Text>
                <View style={styles.crewCostPriceRow}>
                  <Text style={styles.crewCostDollar}>$</Text>
                  <AppTextInput
                    style={styles.crewCostInput}
                    value={leadRate}
                    onChangeText={setLeadRate}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}>Helper $/Day</Text>
                <View style={styles.crewCostPriceRow}>
                  <Text style={styles.crewCostDollar}>$</Text>
                  <AppTextInput
                    style={styles.crewCostInput}
                    value={helperRate}
                    onChangeText={setHelperRate}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}>Worker $/Day</Text>
                <View style={styles.crewCostPriceRow}>
                  <Text style={styles.crewCostDollar}>$</Text>
                  <AppTextInput
                    style={styles.crewCostInput}
                    value={workerRate}
                    onChangeText={setWorkerRate}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
              </View>
            </View>

            <View style={styles.crewCostDivider} />

            <View style={styles.crewCostTotalRow}>
              <Text style={styles.crewCostTotalLabel}>Total Crew Cost</Text>
              <Text style={styles.crewCostTotalValue}>{fmtCurrency(crewCostTotal)}</Text>
            </View>
          </View>

          {/* ── INVOICE ───────────────────────────────────────────────── */}
          <SectionHeader text="INVOICE" />

          {/* Job Total — always editable. For customers paying preset amounts
              (e.g. Bulldog work orders) the user types it in manually; when an
              Apollonia invoice exists it's auto-populated from the invoice total
              on load but remains editable here. */}
          <FormLabel text="JOB TOTAL" />
          <View style={styles.inputCard}>
            <Text style={styles.inputPrefix}>$</Text>
            <AppTextInput style={[styles.input, { flex: 1 }]} value={jobTotal} onChangeText={setJobTotal} placeholder="0.00" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" returnKeyType="next" />
          </View>

          {invoicePdfUrl && (status === 'Invoice Sent' || status === 'Invoice Paid') && (
            <TouchableOpacity
              onPress={() => Linking.openURL(invoicePdfUrl).catch(() => Alert.alert('Cannot open', 'Could not open the invoice PDF.'))}
              style={styles.viewInvoiceLink}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.viewInvoiceLinkText}>View Invoice →</Text>
            </TouchableOpacity>
          )}

          {isEdit && (
            <TouchableOpacity style={styles.editLineItemsBtn} onPress={handleOpenLineItems}>
              <Ionicons name="list-outline" size={16} color={colors.primary} />
              <Text style={styles.editLineItemsBtnText}>Edit Line Items</Text>
            </TouchableOpacity>
          )}

          {/* ── NOTES & PHOTOS ────────────────────────────────────────── */}
          <SectionHeader text="NOTES & PHOTOS" />

          <FormLabel text="NOTES" />
          <View style={styles.inputCard}>
            <AppTextInput style={[styles.input, styles.inputMultiTall]} value={notes} onChangeText={setNotes} placeholder="Additional notes…" placeholderTextColor={colors.textMuted} multiline returnKeyType="default" />
          </View>

          {/* Photos */}
          <View style={styles.photosLabelRow}>
            <FormLabel text="PHOTOS" />
            <Text style={styles.photoCount}>{photos.length}/25</Text>
          </View>

          {photos.length < 25 && (
            <TouchableOpacity style={styles.addPhotoBtn} onPress={handleAddPhotos}>
              <Ionicons name="camera-outline" size={18} color={colors.primary} />
              <Text style={styles.addPhotoBtnText}>Add Photos</Text>
            </TouchableOpacity>
          )}

          {photos.length > 0 && (
            <View style={styles.photoGrid}>
              {photos.map((photo, i) => (
                <View key={photo.key} style={{ position: 'relative', width: thumbSize, height: thumbSize }}>

                  {/* Photo tile — tappable to view full screen (only when not uploading) */}
                  <TouchableOpacity
                    onPress={() => !photo.uploading && setViewingPhoto(photo.uri)}
                    activeOpacity={photo.uploading ? 1 : 0.85}
                  >
                    <Image
                      source={{ uri: photo.uri }}
                      style={{ width: thumbSize, height: thumbSize, borderRadius: 8 }}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={200}
                    />
                  </TouchableOpacity>

                  {/* Gray overlay + spinner while uploading to Firebase */}
                  {photo.uploading && (
                    <View style={styles.photoUploadingOverlay} pointerEvents="none">
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  )}

                  {/* Red overlay + cloud-offline icon if upload failed — tap to retry */}
                  {photo.failed && (
                    <TouchableOpacity
                      style={styles.photoErrorOverlay}
                      onPress={() => retryPhotoUpload(photo)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="refresh-outline" size={18} color="#fff" />
                      <Text style={styles.photoErrorText}>Retry</Text>
                    </TouchableOpacity>
                  )}

                  {/* Delete button */}
                  <TouchableOpacity
                    style={styles.photoDeleteBtn}
                    onPress={() => handleDeletePhoto(i)}
                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                  >
                    <Ionicons name="close-circle" size={22} color="#fff" />
                  </TouchableOpacity>

                </View>
              ))}
            </View>
          )}

          {isEdit && (
            <TouchableOpacity style={styles.deleteJobBtn} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={16} color="#dc2626" />
              <Text style={styles.deleteJobText}>Delete Job</Text>
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Customer picker modal with search */}
      <Modal
        visible={showCustomerPicker}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => { setShowCustomerPicker(false); setCustomerSearch(''); }}
      >
        <SafeAreaView style={styles.pickerSheet}>
          <View style={styles.pickerSheetHeader}>
            <Text style={styles.pickerSheetTitle}>Select Customer</Text>
            <TouchableOpacity onPress={() => { setShowCustomerPicker(false); setCustomerSearch(''); }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View style={styles.custSearchWrap}>
            <Ionicons name="search-outline" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
            <AppTextInput
              style={styles.custSearchInput}
              value={customerSearch}
              onChangeText={setCustomerSearch}
              placeholder="Search customers…"
              placeholderTextColor={colors.textMuted}
              autoFocus
              clearButtonMode="while-editing"
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            {/* NEW CUSTOMER option */}
            <TouchableOpacity
              style={[styles.pickerItem, styles.custNewRow]}
              onPress={() => {
                setIsNewCustomer(true);
                setBillToName('');
                setBillToAddress('');
                setEmail('');
                setSalesperson('');
                setCustomerSearch('');
                setShowCustomerPicker(false);
              }}
            >
              <Ionicons name="add-circle" size={18} color={colors.primary} />
              <Text style={styles.custNewLabel}>NEW CUSTOMER</Text>
            </TouchableOpacity>

            {filteredCustomers.map((c) => (
              <TouchableOpacity
                key={c.id || c.name}
                style={styles.pickerItem}
                onPress={() => {
                  setIsNewCustomer(false);
                  setBillToName(c.name);
                  setBillToAddress(c.address || '');
                  setEmail(c.email || '');
                  setPhone(c.phone || '');
                  setSalesperson(c.salesperson || '');
                  // Job Location Address is the physical job site, not the
                  // customer's billing address — leave it for manual entry.
                  setCustomerSearch('');
                  setShowCustomerPicker(false);
                }}
              >
                <Text style={styles.pickerItemLabel}>{c.name}</Text>
                {c.address ? <Text style={styles.pickerItemSub}>{c.address}</Text> : null}
              </TouchableOpacity>
            ))}

            {filteredCustomers.length === 0 && customerSearch.trim().length > 0 && (
              <TouchableOpacity
                style={[styles.pickerItem, styles.custNewRow]}
                onPress={() => {
                  setIsNewCustomer(true);
                  setBillToName(customerSearch.trim());
                  setBillToAddress('');
                  setEmail('');
                  setPhone('');
                  setSalesperson('');
                  setCustomerSearch('');
                  setShowCustomerPicker(false);
                }}
              >
                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                <Text style={styles.custNewLabel}>Add "{customerSearch.trim()}" as new customer</Text>
              </TouchableOpacity>
            )}

            <View style={{ height: 32 }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <PickerSheet
        visible={showStatusPicker}
        title="Select Status"
        onClose={() => setShowStatusPicker(false)}
        items={STATUSES.map((s) => ({ key: s, label: s }))}
        onSelect={(key) => {
          if (key === 'Scheduled' && !targetDate.trim()) {
            Alert.alert('Target Date Required', 'A target date is required for Scheduled status. Set a target date first, or pick a different status.');
            setShowStatusPicker(false);
            return;
          }
          setStatus(key);
          setShowStatusPicker(false);
        }}
      />

      <PickerSheet
        visible={showJobTypePicker}
        title="Select Job Type"
        onClose={() => setShowJobTypePicker(false)}
        items={jobTypes.map((t) => ({ key: t, label: t }))}
        onSelect={(key) => { setJobType(key); setShowJobTypePicker(false); }}
      />

      <PickerSheet
        visible={showCrewPicker}
        title="Select Crew"
        onClose={() => setShowCrewPicker(false)}
        items={[
          { key: '', label: 'No Crew Assigned' },
          ...crews.map((c) => ({ key: c.id, label: c.name, sub: c.lead?.name || '' })),
        ]}
        onSelect={(key) => {
          setCrewId(key);
          setShowCrewPicker(false);
          if (key) {
            const picked = crews.find((c) => c.id === key);
            if (picked) {
              // New crew model: crewSize is total headcount incl. lead. Default
              // allocation is 1 lead + 1 helper + the rest as workers. The helper
              // only applies when the crew is big enough (crewSize >= 2) — a
              // 1-person crew is just the lead. Fall back to members.length + 1
              // for any pre-migration crew doc.
              const crewSize = picked.crewSize != null
                ? picked.crewSize
                : ((picked.members || []).length + 1);
              setCrewLeads('1');
              setCrewHelpers(crewSize >= 2 ? '1' : '0');
              setCrewWorkers(String(Math.max(0, crewSize - 2)));
              setLeadRate(String(picked.leadDailyRate     != null ? picked.leadDailyRate     : 300));
              setWorkerRate(String(picked.workerDailyRate != null ? picked.workerDailyRate   : 250));
              setHelperRate(String(picked.helperDailyRate != null ? picked.helperDailyRate   : 150));
            }
          }
        }}
      />

      <Modal
        visible={showLineItemsModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowLineItemsModal(false)}
      >
        <SafeAreaView style={styles.pickerSheet}>
          <View style={styles.pickerSheetHeader}>
            <Text style={styles.pickerSheetTitle}>Edit Line Items</Text>
            <TouchableOpacity onPress={() => setShowLineItemsModal(false)}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              {editLineItems.map((item, index) => (
                <View key={index} style={styles.liCard}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <AppTextInput
                      style={[styles.liInput, { flex: 1, textAlign: 'left' }]}
                      value={item.description}
                      onChangeText={(v) => setEditLineItems((prev) => prev.map((it, i) => i === index ? { ...it, description: v } : it))}
                      placeholder="Description…"
                      placeholderTextColor={colors.textMuted}
                    />
                    <TouchableOpacity onPress={() => setEditLineItems((prev) => prev.filter((_, i) => i !== index))}>
                      <Ionicons name="close-circle" size={20} color="#dc2626" />
                    </TouchableOpacity>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ alignItems: 'center', gap: 2 }}>
                      <Text style={styles.liFieldLabel}>Qty</Text>
                      <AppTextInput
                        style={styles.liInput}
                        value={String(item.qty)}
                        onChangeText={(v) => setEditLineItems((prev) => prev.map((it, i) => i === index ? { ...it, qty: v } : it))}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                    <Text style={{ fontSize: 14, color: colors.textMuted }}>×</Text>
                    <View style={{ alignItems: 'center', gap: 2 }}>
                      <Text style={styles.liFieldLabel}>Unit Price</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontSize: 13, color: colors.textSecondary, marginRight: 2 }}>$</Text>
                        <AppTextInput
                          style={styles.liInput}
                          value={String(item.unitPrice)}
                          onChangeText={(v) => setEditLineItems((prev) => prev.map((it, i) => i === index ? { ...it, unitPrice: v } : it))}
                          keyboardType="decimal-pad"
                          selectTextOnFocus
                        />
                      </View>
                    </View>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textMuted, marginLeft: 'auto' }}>
                      {fmtCurrency((parseFloat(item.qty) || 0) * (parseFloat(item.unitPrice) || 0))}
                    </Text>
                  </View>
                </View>
              ))}

              <TouchableOpacity
                style={styles.addLiBtn}
                onPress={() => setEditLineItems((prev) => [...prev, { description: '', qty: '1', unitPrice: '0' }])}
              >
                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                <Text style={styles.addLiBtnText}>Add Line Item</Text>
              </TouchableOpacity>

              <View style={styles.liTaxCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary }}>Tax Rate</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <AppTextInput
                      style={styles.liInput}
                      value={editTaxRate}
                      onChangeText={setEditTaxRate}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSecondary }}>%</Text>
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.saveLiBtn, lineItemsSaving && { opacity: 0.6 }]}
                onPress={handleSaveLineItems}
                disabled={lineItemsSaving}
              >
                {lineItemsSaving
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.saveLiBtnText}>Save Line Items</Text>
                }
              </TouchableOpacity>

              <View style={{ height: 32 }} />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <Modal visible={viewingPhoto !== null} transparent animationType="fade" onRequestClose={() => setViewingPhoto(null)}>
        <View style={styles.photoViewerBg}>
          <TouchableOpacity style={styles.photoViewerClose} onPress={() => setViewingPhoto(null)}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          {viewingPhoto && (
            <Image
              source={{ uri: viewingPhoto }}
              style={{ width, height: width * 1.2, maxHeight: height }}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={200}
            />
          )}
        </View>
      </Modal>

      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={18} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/* Each-job recurring expense picker — shown after first save of a new job
          when matching company-recurring expenses exist. */}
      <Modal
        visible={showRecurringPicker}
        transparent
        animationType="fade"
        onRequestClose={handleSkipRecurring}
      >
        <View style={styles.recurringBackdrop}>
          <View style={styles.recurringSheet}>
            <Text style={styles.recurringTitle}>Add recurring expenses?</Text>
            <Text style={styles.recurringSub}>
              Select which recurring expenses to attach to this job. Each becomes a job expense (not billed to the customer).
            </Text>
            <ScrollView style={styles.recurringList} showsVerticalScrollIndicator={false}>
              {recurringCandidates.map((exp) => {
                const checked = selectedRecurringIds.has(exp.id);
                return (
                  <TouchableOpacity
                    key={exp.id}
                    style={styles.recurringRow}
                    onPress={() => toggleRecurringSelection(exp.id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={checked ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={checked ? colors.primary : colors.textMuted}
                    />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.recurringRowDesc} numberOfLines={1}>
                        {exp.description || exp.category || 'Expense'}
                      </Text>
                      {exp.category ? (
                        <Text style={styles.recurringRowSub} numberOfLines={1}>{exp.category}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.recurringRowAmount}>
                      ${Math.round(Number(exp.amount) || 0).toLocaleString('en-US')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.recurringBtnRow}>
              <TouchableOpacity style={[styles.recurringBtn, styles.recurringBtnSkip]} onPress={handleSkipRecurring}>
                <Text style={styles.recurringBtnSkipText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.recurringBtn, styles.recurringBtnConfirm]} onPress={handleConfirmRecurring}>
                <Text style={styles.recurringBtnConfirmText}>
                  Add {selectedRecurringIds.size} expense{selectedRecurringIds.size === 1 ? '' : 's'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <RoofEstimateModal
        visible={showEstimateModal}
        roofEstimate={roofEstimate}
        aerialPhotoBase64={aerialPhotoBase64}
        streetViewPhotoBase64={streetViewPhotoBase64}
        jobId={jobInstanceId.current}
        onClose={() => setShowEstimateModal(false)}
        onDiscard={handleDiscardEstimate}
        onApplyToLineItems={handleApplyEstimateToLineItems}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  toast: {
    position: 'absolute',
    bottom: 48, left: 24, right: 24,
    backgroundColor: 'rgba(22,163,74,0.95)',
    borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 6, elevation: 6,
  },
  toastText:  { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Each-job recurring expense picker
  recurringBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: 20,
  },
  recurringSheet: {
    width: '100%', maxWidth: 420, maxHeight: '80%',
    backgroundColor: '#fff', borderRadius: 16, padding: 18,
  },
  recurringTitle: { fontSize: 18, fontWeight: '800', color: '#111827', textAlign: 'center' },
  recurringSub:   { fontSize: 13, color: '#6b7280', textAlign: 'center', marginTop: 6, marginBottom: 14, lineHeight: 18 },
  recurringList:  { flexGrow: 0 },
  recurringRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: 10, marginBottom: 6,
    backgroundColor: '#f9fafb',
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  recurringRowDesc:  { fontSize: 14, fontWeight: '600', color: '#111827' },
  recurringRowSub:   { fontSize: 11, color: '#6b7280', marginTop: 2 },
  recurringRowAmount:{ fontSize: 14, fontWeight: '700', color: '#111827', marginLeft: 8 },
  recurringBtnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  recurringBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  recurringBtnSkip:        { backgroundColor: '#f3f4f6' },
  recurringBtnSkipText:    { fontSize: 14, fontWeight: '700', color: '#374151' },
  recurringBtnConfirm:     { backgroundColor: colors.primary },
  recurringBtnConfirmText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  headerBtn:   { minWidth: 60 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  headerSave:  { fontSize: 16, fontWeight: '700', color: colors.primary, textAlign: 'right' },

  content:    { padding: 16 },
  contentPad: { maxWidth: 800, alignSelf: 'center', width: '100%' },

  jobIdBadge: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5, marginBottom: 4, marginLeft: 4,
  },

  formRow:  { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  formCell: { flex: 1 },

  formLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    letterSpacing: 0.8, marginBottom: 6, marginTop: 14, marginLeft: 4,
  },

  sectionHeader: {
    marginTop: 26, marginBottom: 2,
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontSize: 13, fontWeight: '800', color: colors.textPrimary,
    letterSpacing: 1.2,
  },

  readOnlyValue: { fontSize: 15, color: colors.textPrimary, paddingVertical: 14, flex: 1, fontWeight: '600' },

  inputCard: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  inputPrefix:    { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  input:          { fontSize: 15, color: colors.textPrimary, paddingVertical: 14, flex: 1 },
  phoneCallBtn:   { paddingHorizontal: 8, paddingVertical: 4 },
  viewInvoiceLink: { paddingHorizontal: 4, paddingVertical: 8, marginTop: 4, marginBottom: 4 },
  viewInvoiceLinkText: { fontSize: 14, color: '#16a34a', fontWeight: '700' },

  // AI Roof Estimator
  roofEstimateRow: { marginTop: 10, marginBottom: 4 },
  roofEstimateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  roofEstimateBtnIdle:     { backgroundColor: '#16a34a' },
  roofEstimateBtnPending:  { backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  roofEstimateBtnComplete: { backgroundColor: '#2563eb' },
  roofEstimateBtnFailed:   { backgroundColor: '#dc2626' },
  roofEstimateBtnText:     { fontSize: 14, fontWeight: '700' },
  roofEstimateBtnTextPending: { color: colors.textMuted },

  inputMulti:     { minHeight: 60, textAlignVertical: 'top', paddingTop: 14 },
  inputMultiTall: { minHeight: 90, textAlignVertical: 'top', paddingTop: 14 },

  pickerBtn: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  pickerBtnValue:       { fontSize: 15, color: colors.textPrimary, flex: 1 },
  pickerBtnPlaceholder: { fontSize: 15, color: colors.textMuted, flex: 1 },

  crewCostCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  crewCostRow: { flexDirection: 'row', gap: 8 },
  crewCostField: { flex: 1, alignItems: 'center', gap: 6 },
  crewCostLabel: {
    fontSize: 10, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center',
  },
  crewCostInput: {
    backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 8, paddingVertical: 8, fontSize: 15, fontWeight: '700',
    color: colors.textPrimary, textAlign: 'center', width: '100%',
  },
  crewCostPriceRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  crewCostDollar: { fontSize: 13, color: colors.textSecondary, marginRight: 2 },
  crewCostDivider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 12 },
  crewCostTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  crewCostTotalLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  crewCostTotalValue: { fontSize: 16, fontWeight: '800', color: colors.primary },

  photosLabelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, marginBottom: 6, marginHorizontal: 4,
  },
  photoCount: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

  addPhotoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#f0fdf4', borderRadius: 12, paddingVertical: 13,
    borderWidth: 1.5, borderColor: '#86efac', borderStyle: 'dashed', marginBottom: 10,
  },
  addPhotoBtnText: { fontSize: 15, fontWeight: '600', color: colors.primary },

  importBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#f0fdf4', borderRadius: 12, paddingVertical: 13,
    borderWidth: 1.5, borderColor: '#86efac', borderStyle: 'dashed', marginBottom: 14,
  },
  importBtnText: { fontSize: 15, fontWeight: '700', color: colors.primary },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },

  photoDeleteBtn: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12,
  },

  // Semi-transparent dark overlay with spinner shown while uploading to Firebase
  photoUploadingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Red overlay shown when upload fails
  photoErrorOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(220,38,38,0.55)',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
  },
  photoErrorText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },

  deleteJobBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 24, paddingVertical: 14, borderRadius: 12,
    borderWidth: 1, borderColor: '#fecaca', backgroundColor: '#fff5f5',
  },
  deleteJobText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },

  pickerSheet: { flex: 1, backgroundColor: '#f9fafb' },
  pickerSheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  pickerSheetTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  pickerItem: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  pickerItemLabel: { fontSize: 15, color: colors.textPrimary, fontWeight: '500' },
  pickerItemSub:   { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  photoViewerBg: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.93)',
    justifyContent: 'center', alignItems: 'center',
  },
  photoViewerClose: {
    position: 'absolute', top: 60, right: 20, zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 6,
  },

  editLineItemsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 20, marginBottom: 6, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1.5, borderColor: colors.primary, backgroundColor: '#f0fdf4',
  },
  editLineItemsBtnText: { fontSize: 15, fontWeight: '700', color: colors.primary },

  custSearchWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
    paddingHorizontal: 14, paddingVertical: 8,
  },
  custSearchInput: { flex: 1, fontSize: 15, color: colors.textPrimary, paddingVertical: 6 },
  custNewRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#f0fdf4', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  custNewLabel: { fontSize: 15, fontWeight: '700', color: colors.primary },

  liCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  liInput: {
    backgroundColor: '#f9fafb', borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb',
    paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, fontWeight: '600',
    color: colors.textPrimary, minWidth: 52, textAlign: 'center',
  },
  liFieldLabel: { fontSize: 9, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase' },
  addLiBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    paddingVertical: 12, marginVertical: 8,
  },
  addLiBtnText: { fontSize: 14, fontWeight: '600', color: colors.primary },
  liTaxCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  saveLiBtn: {
    backgroundColor: colors.primary, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  saveLiBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
