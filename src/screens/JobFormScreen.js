import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, TextInput, KeyboardAvoidingView, Platform,
  Alert, ActivityIndicator, Modal, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { getJobs, saveJob, deleteJob, assignJobId, getJobTypes, getExpenses, saveCustomer } from '../services/db';
import { useAppData } from '../context/AppDataContext';
import { uploadJobPhoto, deleteStoragePhoto, storagePathFromUrl } from '../services/storageService';
import * as ImagePicker from 'expo-image-picker';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../utils/permissions';
import { useNavigation, useRoute } from '@react-navigation/native';
import { InteractionManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAuth } from '../context/AuthContext';
import DatePickerField from '../components/DatePickerField';
import AddressAutocomplete from '../components/AddressAutocomplete';
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

  const crews    = contextCrews.length > 0 ? contextCrews : [];
  const jobTypes = contextJobTypes.length > 0 ? contextJobTypes.map((t) => t.name) : FALLBACK_JOB_TYPES;
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState('');
  const [seqId,    setSeqId]    = useState(null); // "YY-####" job ID

  const [projectName,        setProjectName]        = useState('');
  const [jobType,            setJobType]            = useState(isEdit ? '' : 'Roofing');
  const [status,             setStatus]             = useState('Not Scheduled');
  const [targetDate,         setTargetDate]         = useState('');
  const [billToName,         setBillToName]         = useState('');
  const [billToAddress,      setBillToAddress]      = useState('');
  const [email,              setEmail]              = useState('');
  const [jobLocationAddress, setJobLocationAddress] = useState('');
  const [crewId,             setCrewId]             = useState('');
  const [salesperson,        setSalesperson]        = useState('');
  const [estimatedDuration,  setEstimatedDuration]  = useState('1');
  const [invoiceNumber,      setInvoiceNumber]      = useState('');
  const [invoiceDate,        setInvoiceDate]        = useState('');
  const [dueDate,            setDueDate]            = useState('');
  const [invoiceTotal,       setInvoiceTotal]       = useState('');
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
            setTargetDate(job.targetDate || '');
            setBillToName(job.billToName || '');
            setBillToAddress(job.billToAddress || '');
            setEmail(job.email || '');
            setJobLocationAddress(job.jobLocationAddress || '');
            setCrewId(job.crewId || '');
            setSalesperson(job.salesperson || '');
            setEstimatedDuration(job.estimatedDuration || '1');
            setInvoiceNumber(job.invoiceNumber || '');
            setInvoiceDate(job.invoiceDate || '');
            setDueDate(job.dueDate || '');
            setInvoiceTotal(job.invoiceTotal != null ? String(job.invoiceTotal) : '');
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
              setPhotos(job.photos.map((url) => ({
                key:        url.split('/').pop().split('?')[0] || generateId(),
                uri:        url,
                storageUrl: url,
                uploading:  false,
                failed:     false,
              })));
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
          if (prefill.jobType)            setJobType(prefill.jobType);
          if (prefill.jobLocationAddress) setJobLocationAddress(prefill.jobLocationAddress);
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
        map[n] = { id: n, name: n, address: j.billToAddress || '', email: j.email || '', salesperson: j.salesperson || '' };
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

  // Clearing the target date while status is "Scheduled" violates the business
  // rule that Scheduled requires a date — auto-downgrade to "Not Scheduled" so
  // the form stays in a consistent state without waiting for the save guard.
  const handleTargetDateChange = useCallback((next) => {
    setTargetDate(next || '');
    if (!String(next || '').trim() && status === 'Scheduled') {
      setStatus('Not Scheduled');
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

      // Collect final photo URLs. For photos still uploading, await their promises
      // (all in parallel via Promise.all so we don't serialize waiting).
      const photoUrlPromises = photos.map(async (photo) => {
        if (photo.storageUrl) return photo.storageUrl;
        if (photo.uploading && uploadPromisesRef.current[photo.key]) {
          return uploadPromisesRef.current[photo.key]; // already a promise
        }
        return null; // failed — exclude
      });
      const rawUrls    = await Promise.all(photoUrlPromises);
      const photoUrls  = rawUrls.filter(Boolean);

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
        jobLocationAddress: jobLocationAddress.trim(),
        crewId:             crewId || '',
        salesperson:        salesperson.trim(),
        estimatedDuration:  estimatedDuration.trim(),
        invoiceNumber:      invoiceNumber.trim(),
        invoiceDate:        invoiceDate.trim(),
        dueDate:            dueDate.trim(),
        invoiceTotal:       invoiceTotal ? parseFloat(invoiceTotal) : null,
        notes:              notes.trim(),
        photos:             photoUrls,
        photoCount:         photoUrls.length,
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
          salesperson: salesperson.trim(),
          updatedAt:   new Date().toISOString(),
        }).catch((err) => console.warn('[JobForm] saveCustomer failed:', err.message));
        setIsNewCustomer(false);
      }

      const seqLabel = currentSeqId ? ` [${currentSeqId}]` : '';
      logActivity(isEdit ? 'job_updated' : 'job_created', `${isEdit ? 'Updated' : 'Created'} job: ${jobData.projectName}${seqLabel}`);

      // Delete any Storage photos the user explicitly removed
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
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save job.');
    } finally {
      setSaving(false);
    }
  };

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

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="PROJECT NAME *" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={projectName} onChangeText={setProjectName} placeholder="e.g. Front Yard Concrete" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="JOB TYPE" />
              <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowJobTypePicker(true)}>
                <Text style={jobType ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
                  {jobType || 'Select job type…'}
                </Text>
                <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="STATUS" />
              <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowStatusPicker(true)}>
                <Text style={status ? styles.pickerBtnValue : styles.pickerBtnPlaceholder}>{status || 'Select status…'}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="TARGET DATE" />
              <DatePickerField value={targetDate} onChange={handleTargetDateChange} placeholder="Select target date…" />
            </View>
          </View>

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="ESTIMATED DURATION DAYS" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={estimatedDuration} onChangeText={setEstimatedDuration} placeholder="e.g. 2" placeholderTextColor={colors.textMuted} returnKeyType="next" keyboardType="numbers-and-punctuation" />
              </View>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
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
            </View>
          </View>

          {/* Crew Assignment & Pay — internal only, never shown on invoice */}
          <FormLabel text="CREW ASSIGNMENT & PAY (INTERNAL)" />
          <View style={styles.crewCostCard}>
            <View style={styles.crewCostRow}>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Leads</Text>
                <TextInput
                  style={styles.crewCostInput}
                  value={crewLeads}
                  onChangeText={setCrewLeads}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Helpers</Text>
                <TextInput
                  style={styles.crewCostInput}
                  value={crewHelpers}
                  onChangeText={setCrewHelpers}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
              </View>
              <View style={styles.crewCostField}>
                <Text style={styles.crewCostLabel}># of Workers</Text>
                <TextInput
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
                  <TextInput
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
                  <TextInput
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
                  <TextInput
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

          <FormLabel text="CUSTOMER / BILL TO" />
          <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowCustomerPicker(true)}>
            <Text style={billToName ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
              {isNewCustomer ? 'New Customer' : (billToName || 'Select or add customer…')}
            </Text>
            {billToName && !isNewCustomer ? (
              <TouchableOpacity
                onPress={() => { setBillToName(''); setBillToAddress(''); setEmail(''); setSalesperson(''); setIsNewCustomer(false); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : (
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            )}
          </TouchableOpacity>

          {/* Name field shown for new customer or when no customer selected */}
          {(isNewCustomer || !billToName) && (
            <>
              <FormLabel text="CUSTOMER NAME" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={billToName} onChangeText={setBillToName} placeholder="Full customer name" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </>
          )}

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="BILLING ADDRESS" />
              <AddressAutocomplete
                value={billToAddress}
                onChangeText={setBillToAddress}
                placeholder="123 Main St, City, State"
                placeholderTextColor={colors.textMuted}
              />
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="CUSTOMER EMAIL" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="customer@example.com" placeholderTextColor={colors.textMuted} keyboardType="email-address" autoCapitalize="none" returnKeyType="next" />
              </View>
            </View>
          </View>

          <FormLabel text="JOB LOCATION ADDRESS" />
          <AddressAutocomplete
            value={jobLocationAddress}
            onChangeText={setJobLocationAddress}
            placeholder="Site address"
            placeholderTextColor={colors.textMuted}
          />

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="SALESPERSON" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={salesperson} onChangeText={setSalesperson} placeholder="Name" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="INVOICE NUMBER" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={invoiceNumber} onChangeText={setInvoiceNumber} placeholder="e.g. 26120-001" placeholderTextColor={colors.textMuted} returnKeyType="next" autoCapitalize="none" />
              </View>
            </View>
          </View>

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="INVOICE DATE" />
              <DatePickerField value={invoiceDate} onChange={setInvoiceDate} placeholder="Select invoice date…" />
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="DUE DATE" />
              <DatePickerField value={dueDate} onChange={setDueDate} placeholder="Select due date…" />
            </View>
          </View>

          <FormLabel text="INVOICE TOTAL" />
          <View style={styles.inputCard}>
            <Text style={styles.inputPrefix}>$</Text>
            <TextInput style={[styles.input, { flex: 1 }]} value={invoiceTotal} onChangeText={setInvoiceTotal} placeholder="0.00" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" returnKeyType="next" />
          </View>

          <FormLabel text="NOTES" />
          <View style={styles.inputCard}>
            <TextInput style={[styles.input, styles.inputMultiTall]} value={notes} onChangeText={setNotes} placeholder="Additional notes…" placeholderTextColor={colors.textMuted} multiline returnKeyType="default" />
          </View>

          {isEdit && (
            <TouchableOpacity style={styles.editLineItemsBtn} onPress={handleOpenLineItems}>
              <Ionicons name="list-outline" size={16} color={colors.primary} />
              <Text style={styles.editLineItemsBtnText}>Edit Line Items</Text>
            </TouchableOpacity>
          )}

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
            <TextInput
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
                  setSalesperson(c.salesperson || '');
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
              setCrewLeads('1');
              setCrewHelpers('1');
              // totalSize = 1 lead + members.length; workers = totalSize - 2
              setCrewWorkers(String(Math.max(0, (picked.members || []).length - 1)));
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
                    <TextInput
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
                      <TextInput
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
                        <TextInput
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
                    <TextInput
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
        <View style={[styles.toast, toast.includes('SMS failed') && styles.toastError]} pointerEvents="none">
          <Ionicons name={toast.includes('SMS failed') ? 'warning-outline' : 'checkmark-circle'} size={18} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
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
  toastError: { backgroundColor: 'rgba(220,38,38,0.95)' },

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

  inputCard: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  inputPrefix:    { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  input:          { fontSize: 15, color: colors.textPrimary, paddingVertical: 14, flex: 1 },
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
