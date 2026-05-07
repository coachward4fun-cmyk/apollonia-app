import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, TextInput, KeyboardAvoidingView, Platform,
  Alert, ActivityIndicator, Modal, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import DateTimePicker from '@react-native-community/datetimepicker';
import { getCrews, getJobs, saveJob, deleteJob } from '../services/db';
import { uploadJobPhoto, jobPhotoPath, deleteStoragePhoto, storagePathFromUrl } from '../services/storageService';
import * as ImagePicker from 'expo-image-picker';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../utils/permissions';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../services/activityLog';

const STATUSES = [
  'Not Scheduled', 'Scheduled', 'In Progress',
  'Invoice Ready', 'Invoice Sent', 'Invoice Paid', 'Completed',
];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseStoredDate(str) {
  if (!str) return new Date();
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? new Date() : d;
}

function formatDateDisplay(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function dateToStorage(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

function DatePickerField({ value, onChange, placeholder }) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerValue = value ? parseStoredDate(value) : new Date();

  return (
    <>
      <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowPicker(true)} activeOpacity={0.7}>
        <Ionicons
          name="calendar-outline"
          size={16}
          color={value ? colors.primary : colors.textMuted}
          style={{ marginRight: 6 }}
        />
        <Text style={[{ flex: 1 }, value ? styles.pickerBtnValue : styles.pickerBtnPlaceholder]}>
          {value ? formatDateDisplay(value) : (placeholder || 'Select date…')}
        </Text>
        {value ? (
          <TouchableOpacity onPress={() => onChange('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        )}
      </TouchableOpacity>

      {showPicker && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setShowPicker(false)}>
          <View style={styles.datePickerOverlay}>
            <View style={styles.datePickerPopup}>
              <View style={styles.datePickerPopupHeader}>
                <Text style={styles.datePickerPopupTitle}>Select Date</Text>
                <TouchableOpacity onPress={() => setShowPicker(false)}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <DateTimePicker
                value={pickerValue}
                mode="date"
                display="inline"
                onChange={(event, selected) => {
                  if (selected) {
                    onChange(dateToStorage(selected));
                    setTimeout(() => setShowPicker(false), 150);
                  }
                }}
                accentColor={colors.primary}
                textColor="#111827"
              />
            </View>
          </View>
        </Modal>
      )}

      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={pickerValue}
          mode="date"
          display="default"
          onChange={(event, selected) => {
            setShowPicker(false);
            if (event.type !== 'dismissed' && selected) onChange(dateToStorage(selected));
          }}
        />
      )}
    </>
  );
}

export default function JobFormScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const jobId    = route.params?.jobId ?? null;
  const returnTo = route.params?.returnTo ?? null;
  const isEdit   = !!jobId;
  const { canWrite }   = useAuth();

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isPad       = Platform.OS === 'ios' && Platform.isPad;
  const thumbSize   = Math.floor((width - 32 - 12) / 3);

  const [crews, setCrews] = useState([]);
  const [saving, setSaving] = useState(false);
  const [toast,  setToast]  = useState('');

  const [projectName,        setProjectName]        = useState('');
  const [jobType,            setJobType]            = useState('');
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

  // photos: { uri, filename, isNew }
  // uri is a Firebase Storage download URL (existing) or local temp URI (new)
  const [photos,        setPhotos]        = useState([]);
  const [removedUrls,   setRemovedUrls]   = useState([]); // Storage URLs deleted before save
  const [viewingPhoto,  setViewingPhoto]  = useState(null);

  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [showCrewPicker,   setShowCrewPicker]   = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const crewList = await getCrews();
        setCrews(crewList);

        if (isEdit) {
          const jobs = await getJobs();
          const job = jobs.find((j) => j.id === jobId);
          if (job) {
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
            setEstimatedDuration(job.estimatedDuration || '');
            setInvoiceNumber(job.invoiceNumber || '');
            setInvoiceDate(job.invoiceDate || '');
            setDueDate(job.dueDate || '');
            setInvoiceTotal(job.invoiceTotal != null ? String(job.invoiceTotal) : '');
            setNotes(job.notes || '');

            if (job.photos && job.photos.length > 0) {
              setPhotos(job.photos.map((url) => ({
                uri: url,
                filename: url.split('/').pop().split('?')[0],
                isNew: false,
              })));
            }
          }
        }
      } catch { /* ignore */ }
    }
    loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddPhotos = () => {
    Alert.alert('Add Photos', '', [
      { text: 'Take Photo', onPress: pickFromCamera },
      { text: 'Choose from Library', onPress: pickFromLibrary },
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
      quality: 0.7,
    });
    if (!result.canceled) {
      const newPhotos = result.assets.map((a) => ({
        uri: a.uri,
        filename: Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg',
        isNew: true,
      }));
      setPhotos((prev) => [...prev, ...newPhotos].slice(0, 25));
    }
  }, [photos.length]);

  const pickFromCamera = useCallback(async () => {
    if (photos.length >= 25) { Alert.alert('Limit Reached', 'Maximum 25 photos per job.'); return; }
    if (!(await requestCameraPermission())) return;
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (!result.canceled) {
      const asset = result.assets[0];
      setPhotos((prev) => [...prev, {
        uri: asset.uri,
        filename: Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg',
        isNew: true,
      }]);
    }
  }, [photos.length]);

  const handleDeletePhoto = useCallback((index) => {
    Alert.alert('Remove Photo', 'Remove this photo from the job?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => {
          setPhotos((prev) => {
            const removed = prev[index];
            // Track existing Storage photos so we can delete them after save
            if (!removed.isNew) {
              setRemovedUrls((urls) => [...urls, removed.uri]);
            }
            return prev.filter((_, i) => i !== index);
          });
        },
      },
    ]);
  }, []);

  const handleSave = async () => {
    if (!canWrite('jobs')) {
      Alert.alert('Access Restricted', 'Your role does not allow editing jobs.');
      return;
    }
    if (!projectName.trim()) {
      Alert.alert('Required', 'Project Name is required.');
      return;
    }
    setSaving(true);
    try {
      const id = jobId || generateId();

      // Upload new photos (compressed) — keep existing Storage URLs unchanged
      const photoUrls = [];
      for (const photo of photos) {
        if (photo.isNew) {
          console.log('[JobForm] uploading photo', photo.filename);
          const url = await uploadJobPhoto(photo.uri, id, photo.filename);
          photoUrls.push(url);
        } else {
          photoUrls.push(photo.uri);
        }
      }

      const jobData = {
        id,
        projectName:        projectName.trim(),
        jobType:            jobType.trim(),
        status:             status || 'Not Scheduled',
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
      };

      await saveJob(jobData);
      logActivity(isEdit ? 'job_updated' : 'job_created', `${isEdit ? 'Updated' : 'Created'} job: ${jobData.projectName}`);

      // After successful save, delete any Storage photos the user removed
      for (const url of removedUrls) {
        const path = storagePathFromUrl(url);
        if (path) deleteStoragePhoto(path).catch(() => {});
      }
      setRemovedUrls([]);

      if (returnTo === 'invoiceDetails') {
        setToast('Job updated');
        setTimeout(() => {
          setToast('');
          // Use getParent() to navigate at the tab level, escaping the Jobs stack
          navigation.getParent()?.navigate('Invoice', { preselectedJobId: id });
        }, 1200);
      } else {
        navigation.goBack();
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

  const selectedCrew = crews.find((c) => c.id === crewId);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
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
          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="PROJECT NAME *" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={projectName} onChangeText={setProjectName} placeholder="e.g. Front Yard Concrete" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="JOB TYPE" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={jobType} onChangeText={setJobType} placeholder="e.g. Concrete, Roofing" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
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
              <DatePickerField value={targetDate} onChange={setTargetDate} placeholder="Select target date…" />
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

          <View style={isLandscape ? styles.formRow : null}>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="CUSTOMER / BILL TO" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={billToName} onChangeText={setBillToName} placeholder="Customer name" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={isLandscape ? styles.formCell : null}>
              <FormLabel text="CUSTOMER EMAIL" />
              <View style={styles.inputCard}>
                <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="customer@example.com" placeholderTextColor={colors.textMuted} keyboardType="email-address" autoCapitalize="none" returnKeyType="next" />
              </View>
            </View>
          </View>

          <FormLabel text="BILLING ADDRESS" />
          <View style={styles.inputCard}>
            <TextInput style={[styles.input, styles.inputMulti]} value={billToAddress} onChangeText={setBillToAddress} placeholder="123 Main St, City, State" placeholderTextColor={colors.textMuted} multiline returnKeyType="next" />
          </View>

          <FormLabel text="JOB LOCATION ADDRESS" />
          <View style={styles.inputCard}>
            <TextInput style={[styles.input, styles.inputMulti]} value={jobLocationAddress} onChangeText={setJobLocationAddress} placeholder="Site address" placeholderTextColor={colors.textMuted} multiline returnKeyType="next" />
          </View>

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
                <View key={i} style={{ position: 'relative', width: thumbSize, height: thumbSize }}>
                  <TouchableOpacity onPress={() => setViewingPhoto(photo.uri)} activeOpacity={0.85}>
                    <Image
                      source={{ uri: photo.uri }}
                      style={{ width: thumbSize, height: thumbSize, borderRadius: 8 }}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={250}
                      placeholder={require('../../assets/Apollonia_new.png')}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.photoDeleteBtn} onPress={() => handleDeletePhoto(i)}>
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

      <PickerSheet
        visible={showStatusPicker}
        title="Select Status"
        onClose={() => setShowStatusPicker(false)}
        items={STATUSES.map((s) => ({ key: s, label: s }))}
        onSelect={(key) => { setStatus(key); setShowStatusPicker(false); }}
      />

      <PickerSheet
        visible={showCrewPicker}
        title="Select Crew"
        onClose={() => setShowCrewPicker(false)}
        items={[
          { key: '', label: 'No Crew Assigned' },
          ...crews.map((c) => ({ key: c.id, label: c.name, sub: c.lead?.name || '' })),
        ]}
        onSelect={(key) => { setCrewId(key); setShowCrewPicker(false); }}
      />

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  toast: {
    position: 'absolute',
    bottom: 48,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(22,163,74,0.95)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 6,
  },
  toastText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  headerBtn: { minWidth: 60 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  headerSave: { fontSize: 16, fontWeight: '700', color: colors.primary, textAlign: 'right' },

  content: { padding: 16 },
  contentPad: { maxWidth: 800, alignSelf: 'center', width: '100%' },

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
  inputPrefix: { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  input: { fontSize: 15, color: colors.textPrimary, paddingVertical: 14, flex: 1 },
  inputMulti: { minHeight: 60, textAlignVertical: 'top', paddingTop: 14 },
  inputMultiTall: { minHeight: 90, textAlignVertical: 'top', paddingTop: 14 },

  pickerBtn: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 1,
  },
  pickerBtnValue: { fontSize: 15, color: colors.textPrimary, flex: 1 },
  pickerBtnPlaceholder: { fontSize: 15, color: colors.textMuted, flex: 1 },

  photosLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 6, marginHorizontal: 4 },
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
  pickerItemSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  datePickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: 20,
  },
  datePickerPopup: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', width: '100%' },
  datePickerPopupHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  datePickerPopupTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },

  photoViewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.93)', justifyContent: 'center', alignItems: 'center' },
  photoViewerClose: {
    position: 'absolute', top: 60, right: 20, zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 6,
  },
});
