import React, { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, Modal, TextInput, KeyboardAvoidingView,
  Platform, Alert, RefreshControl, ActivityIndicator,
  Dimensions, Switch,
} from 'react-native';
import { Image } from 'expo-image';
import { Swipeable } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../utils/permissions';
import { Ionicons } from '@expo/vector-icons';
import { getExpenses, getJobs, saveExpense, deleteExpense } from '../services/db';
import { uploadExpensePhoto, expensePhotoPath, deleteStoragePhoto } from '../services/storageService';
import { SkeletonCard } from '../components/SkeletonLoader';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';
import DatePickerField from '../components/DatePickerField';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const THUMB_SIZE = Math.floor((SCREEN_WIDTH - 32 - 12) / 3);

// ── Constants ──────────────────────────────────────────────────────────────────

const COMPANY_CATEGORIES = [
  'Fuel & Transportation',
  'Tools & Equipment',
  'Materials',
  'Office & Admin',
  'Insurance',
  'Advertising & Marketing',
  'Subcontractors & Labor',
  'Permits & Licensing',
  'Other',
];

const JOB_CATEGORIES = [
  'Subcontractors & Labor',
  'Materials',
  'Equipment Rental',
  'Dump Fees',
  'Permits',
  'Other',
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmt$(n) {
  if (!n && n !== 0) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Main screen ────────────────────────────────────────────────────────────────

function localDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ExpensesScreen() {
  const { canWrite } = useAuth();
  const [expenses,        setExpenses]        = useState([]);
  const [jobs,            setJobs]            = useState([]);
  const [filter,          setFilter]          = useState(null);
  const [timeRange,       setTimeRange]       = useState('last30');
  const [refreshing,      setRefreshing]      = useState(false);
  const [showForm,        setShowForm]        = useState(false);
  const [editingExpense,  setEditingExpense]  = useState(null);
  const [initialLoading,  setInitialLoading]  = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [data, j] = await Promise.all([getExpenses(), getJobs()]);
      setExpenses([...data].sort((a, b) => (b.date || '').localeCompare(a.date || '')));
      setJobs(j.filter((job) => !job.archivedForCustomer));
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const yearStr        = String(new Date().getFullYear());
  const cutoffStr      = localDateStr(-30);

  const rangeExpenses  = timeRange === 'ytd'
    ? expenses.filter((e) => (e.date || '').startsWith(yearStr))
    : expenses.filter((e) => (e.date || '') >= cutoffStr);

  const totalAll     = rangeExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalJob     = rangeExpenses.filter((e) => e.type === 'job').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalCompany = rangeExpenses.filter((e) => e.type === 'company').reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const displayed = filter ? rangeExpenses.filter((e) => e.type === filter) : rangeExpenses;

  const handleDelete = useCallback(async (expense) => {
    if (!canWrite('expenses')) {
      Alert.alert('Access Restricted', 'You don\'t have permission to delete expenses.');
      return;
    }
    Alert.alert('Delete Expense', 'Remove this expense?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          const photoFailures = [];
          try {
            for (const url of (expense.photos || [])) {
              const filename = url.split('/').pop().split('?')[0];
              const result = await deleteStoragePhoto(expensePhotoPath(expense.id, filename));
              if (result && result.ok === false) photoFailures.push(filename);
            }
            await deleteExpense(expense.id);
            await loadData();
            if (photoFailures.length > 0) {
              Alert.alert(
                'Expense deleted, photos not removed',
                `The expense was deleted, but ${photoFailures.length} photo${photoFailures.length === 1 ? '' : 's'} could not be removed from storage. Free space may not have been fully reclaimed.`,
              );
            }
          } catch (err) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  }, [canWrite, loadData]);

  const handleSave = useCallback(async (formData, photoAssets) => {
    if (!canWrite('expenses')) {
      Alert.alert('Access Restricted', 'You don\'t have permission to save expenses.');
      return;
    }
    try {
      const id = editingExpense ? editingExpense.id : generateId();

      const photoUrls = [];
      for (const p of (photoAssets || [])) {
        if (p.isNew) {
          console.log('[Expenses] uploading photo', p.filename);
          const url = await uploadExpensePhoto(p.uri, id, p.filename);
          photoUrls.push(url);
        } else {
          photoUrls.push(p.uri);
        }
      }

      const entry = {
        ...(editingExpense || { createdAt: today() }),
        id,
        ...formData,
        photos: photoUrls,
      };

      await saveExpense(entry);
      const action = editingExpense ? 'expense_updated' : 'expense_created';
      const label = formData.description || formData.category || 'expense';
      logActivity(action, `${editingExpense ? 'Updated' : 'Created'} expense: ${label} ($${formData.amount || 0})`);
      await loadData();
      setShowForm(false);
      setEditingExpense(null);
    } catch (err) {
      Alert.alert('Error', 'Could not save expense: ' + err.message);
    }
  }, [editingExpense, canWrite, loadData]);

  const handleEdit = useCallback((expense) => {
    setEditingExpense(expense);
    setShowForm(true);
  }, []);

  const handleCardTap = (type) => setFilter((prev) => (prev === type ? null : type));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Expenses</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowForm(true)}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={styles.rangeToggle}>
          <TouchableOpacity
            style={[styles.rangeBtn, timeRange === 'last30' && styles.rangeBtnActive]}
            onPress={() => { setTimeRange('last30'); setFilter(null); }}
          >
            <Text style={[styles.rangeBtnText, timeRange === 'last30' && styles.rangeBtnTextActive]}>Last 30 Days</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.rangeBtn, timeRange === 'ytd' && styles.rangeBtnActive]}
            onPress={() => { setTimeRange('ytd'); setFilter(null); }}
          >
            <Text style={[styles.rangeBtnText, timeRange === 'ytd' && styles.rangeBtnTextActive]}>YTD</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.summaryRow}>
          <SummaryCard
            label="Total"
            amount={fmt$(totalAll)}
            active={filter === null}
            onPress={() => setFilter(null)}
            iconColor={colors.primary}
          />
          <SummaryCard
            label="Job"
            amount={fmt$(totalJob)}
            active={filter === 'job'}
            onPress={() => handleCardTap('job')}
            iconColor="#2563eb"
          />
          <SummaryCard
            label="Company"
            amount={fmt$(totalCompany)}
            active={filter === 'company'}
            onPress={() => handleCardTap('company')}
            iconColor="#d97706"
          />
        </View>

        {filter && (
          <View style={styles.filterBanner}>
            <Text style={styles.filterBannerText}>
              Showing {filter === 'job' ? 'Job' : 'Company'} expenses
            </Text>
            <TouchableOpacity onPress={() => setFilter(null)}>
              <Ionicons name="close-circle" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}

        {initialLoading ? (
          <View style={styles.listWrap}>
            {[0,1,2,3,4].map((i) => <SkeletonCard key={i} />)}
          </View>
        ) : displayed.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="wallet-outline" size={52} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No expenses{filter ? ' of this type' : ''}</Text>
            <Text style={styles.emptySub}>Tap + to add an expense.</Text>
          </View>
        ) : (
          <View style={styles.listWrap}>
            {displayed.map((expense) => (
              <ExpenseRow
                key={expense.id}
                expense={expense}
                onDelete={handleDelete}
                onEdit={handleEdit}
              />
            ))}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      <AddExpenseModal
        visible={showForm}
        jobs={jobs}
        initialData={editingExpense}
        onClose={() => { setShowForm(false); setEditingExpense(null); }}
        onSave={handleSave}
      />
    </SafeAreaView>
  );
}

// ── SummaryCard ────────────────────────────────────────────────────────────────

function SummaryCard({ label, amount, active, onPress, iconColor }) {
  return (
    <TouchableOpacity
      style={[styles.summaryCard, active && styles.summaryCardActive]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={[styles.summaryDot, { backgroundColor: iconColor }]} />
      <Text
        style={[styles.summaryAmount, active && styles.summaryAmountActive]}
        adjustsFontSizeToFit
        numberOfLines={1}
        minimumFontScale={0.6}
      >
        {amount}
      </Text>
      <Text style={[styles.summaryLabel, active && styles.summaryLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── ExpenseRow ─────────────────────────────────────────────────────────────────

function ExpenseRow({ expense, onDelete, onEdit }) {
  const swipeRef = useRef(null);

  const renderRightActions = () => (
    <TouchableOpacity
      style={styles.deleteAction}
      onPress={() => {
        swipeRef.current?.close();
        onDelete(expense);
      }}
    >
      <Ionicons name="trash-outline" size={20} color="#fff" />
      <Text style={styles.deleteActionText}>Delete</Text>
    </TouchableOpacity>
  );

  const isJob = expense.type === 'job';
  const photoCount = (expense.photos || []).length;

  return (
    <Swipeable ref={swipeRef} renderRightActions={renderRightActions} friction={2} rightThreshold={40}>
      <View style={styles.expenseRow}>
        <View style={styles.expenseLeft}>
          <Text style={styles.expenseDate}>{formatDate(expense.date)}</Text>
          <Text style={styles.expenseDesc} numberOfLines={2}>
            {expense.description || '—'}
          </Text>
          <View style={styles.expenseMeta}>
            {expense.category ? (
              <Text style={styles.expenseCat}>{expense.category}</Text>
            ) : null}
            {expense.jobName ? (
              <Text style={styles.expenseJob} numberOfLines={1}>· {expense.jobName}</Text>
            ) : null}
            {photoCount > 0 ? (
              <Text style={styles.expensePhotoHint}>· {photoCount} photo{photoCount !== 1 ? 's' : ''}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.expenseRight}>
          <TouchableOpacity style={styles.rowEditBtn} onPress={() => onEdit(expense)}>
            <Ionicons name="pencil-outline" size={14} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={styles.badgeRow}>
            {photoCount > 0 ? (
              <Ionicons name="camera" size={13} color="#9ca3af" />
            ) : null}
            <View style={[styles.typeBadge, isJob ? styles.typeBadgeJob : styles.typeBadgeCompany]}>
              <Text style={[styles.typeText, isJob ? styles.typeTextJob : styles.typeTextCompany]}>
                {isJob ? 'Job' : 'Co.'}
              </Text>
            </View>
          </View>
          <Text style={styles.expenseAmount}>{fmt$(expense.amount)}</Text>
        </View>
      </View>
    </Swipeable>
  );
}

// ── AddExpenseModal ────────────────────────────────────────────────────────────

function AddExpenseModal({ visible, jobs, initialData, onClose, onSave }) {
  const isEdit = !!initialData;

  const [type,          setType]          = useState('job');
  const [selectedJob,   setSelectedJob]   = useState(null);
  const [date,          setDate]          = useState(today());
  const [amount,        setAmount]        = useState('');
  const [description,   setDescription]   = useState('');
  const [category,      setCategory]      = useState('');
  const [addToInvoice,  setAddToInvoice]  = useState(false);
  const [photos,        setPhotos]        = useState([]);
  const [viewingPhoto,  setViewingPhoto]  = useState(null);
  const [showJobPicker, setShowJobPicker] = useState(false);
  const [showCatPicker, setShowCatPicker] = useState(false);
  const [saving,        setSaving]        = useState(false);

  React.useEffect(() => {
    if (visible && initialData) {
      setType(initialData.type || 'job');
      setDate(initialData.date || today());
      setAmount(String(initialData.amount || ''));
      setDescription(initialData.description || '');
      setCategory(initialData.category || '');
      setAddToInvoice(initialData.addToInvoice || false);
      if (initialData.jobId && jobs.length > 0) {
        setSelectedJob(jobs.find((j) => j.id === initialData.jobId) || null);
      }
      if (initialData.photos && initialData.photos.length > 0) {
        setPhotos(initialData.photos.map((url) => ({
          uri:      url,
          filename: url.split('/').pop().split('?')[0],
          isNew:    false,
        })));
      } else {
        setPhotos([]);
      }
    } else if (visible && !initialData) {
      reset();
    }
  }, [visible, initialData]);

  const reset = () => {
    setType('job');
    setSelectedJob(null);
    setDate(today());
    setAmount('');
    setDescription('');
    setCategory('');
    setAddToInvoice(false);
    setPhotos([]);
    setViewingPhoto(null);
    setShowJobPicker(false);
    setShowCatPicker(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSave = async () => {
    if (!amount || isNaN(Number(amount))) {
      Alert.alert('Required', 'Please enter a valid amount.');
      return;
    }
    if (!date) {
      Alert.alert('Required', 'Please enter a date.');
      return;
    }
    if (type === 'job' && !selectedJob) {
      Alert.alert('Required', 'Please select a job.');
      return;
    }

    setSaving(true);
    const data = {
      type,
      date,
      amount:      parseFloat(amount),
      description: description.trim(),
      category:    category || 'Other',
      ...(type === 'job' && selectedJob ? {
        jobId:   selectedJob.id,
        jobName: selectedJob.projectName || selectedJob.name || '',
      } : { jobId: undefined, jobName: undefined }),
      addToInvoice: type === 'job' ? addToInvoice : false,
      isCrewCost:   false,
    };

    await onSave(data, photos);
    reset();
    setSaving(false);
  };

  const handleAddPhotos = () => {
    Alert.alert('Add Photos', '', [
      { text: 'Take Photo', onPress: pickFromCamera },
      { text: 'Choose from Library', onPress: pickFromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickFromLibrary = async () => {
    if (photos.length >= 25) { Alert.alert('Limit Reached', 'Maximum 25 photos.'); return; }
    if (!(await requestPhotoLibraryPermission())) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 25 - photos.length,
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
  };

  const pickFromCamera = async () => {
    if (photos.length >= 25) { Alert.alert('Limit Reached', 'Maximum 25 photos.'); return; }
    if (!(await requestCameraPermission())) return;
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (!result.canceled) {
      const asset = result.assets[0];
      setPhotos((prev) => [...prev, { uri: asset.uri, filename: Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg', isNew: true }]);
    }
  };

  const handleDeletePhoto = (index) => {
    Alert.alert('Remove Photo', 'Remove this photo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => {
          setPhotos((prev) => {
            const updated = [...prev];
            const removed = updated.splice(index, 1)[0];
            if (!removed.isNew && initialData) {
              deleteStoragePhoto(expensePhotoPath(initialData.id, removed.filename)).catch(() => {});
            }
            return updated;
          });
        },
      },
    ]);
  };

  const selectableJobs = jobs.filter((j) => {
    const s = (j.status || '').toLowerCase();
    return s !== 'invoice paid' && s !== 'cancelled';
  });

  const cats = type === 'job' ? JOB_CATEGORIES : COMPANY_CATEGORIES;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <SafeAreaView style={styles.modalContainer}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={handleClose}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{isEdit ? 'Edit Expense' : 'Add Expense'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={saving}>
              {saving
                ? <ActivityIndicator color={colors.primary} size="small" />
                : <Text style={styles.modalSave}>{isEdit ? 'Update' : 'Save'}</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">

            <FormLabel text="TYPE" />
            <View style={styles.typeToggle}>
              <TouchableOpacity
                style={[styles.typeToggleBtn, type === 'job' && styles.typeToggleBtnActive]}
                onPress={() => { setType('job'); setSelectedJob(null); setCategory(''); }}
              >
                <Ionicons name="construct-outline" size={15} color={type === 'job' ? '#fff' : colors.textSecondary} />
                <Text style={[styles.typeToggleText, type === 'job' && styles.typeToggleTextActive]}>Job</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.typeToggleBtn, type === 'company' && styles.typeToggleBtnActive]}
                onPress={() => { setType('company'); setSelectedJob(null); setCategory(''); }}
              >
                <Ionicons name="business-outline" size={15} color={type === 'company' ? '#fff' : colors.textSecondary} />
                <Text style={[styles.typeToggleText, type === 'company' && styles.typeToggleTextActive]}>Company</Text>
              </TouchableOpacity>
            </View>

            {type === 'job' && (
              <>
                <FormLabel text="JOB" />
                <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowJobPicker(true)}>
                  <Text style={selectedJob ? styles.pickerBtnValue : styles.pickerBtnPlaceholder} numberOfLines={1}>
                    {selectedJob ? (selectedJob.projectName || 'Job') : 'Select a job…'}
                  </Text>
                  <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </>
            )}

            <FormLabel text="DATE" />
            <DatePickerField value={date} onChange={setDate} clearable={false} />

            <FormLabel text="AMOUNT" />
            <View style={styles.inputCard}>
              <Text style={styles.inputPrefix}>$</Text>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                returnKeyType="next"
              />
            </View>

            <FormLabel text="DESCRIPTION" />
            <View style={styles.inputCard}>
              <TextInput
                style={[styles.input, styles.inputMulti]}
                value={description}
                onChangeText={setDescription}
                placeholder="What was this expense for?"
                placeholderTextColor={colors.textMuted}
                multiline
                returnKeyType="default"
              />
            </View>

            <FormLabel text="CATEGORY" />
            <TouchableOpacity style={styles.pickerBtn} onPress={() => setShowCatPicker(true)}>
              <Text style={category ? styles.pickerBtnValue : styles.pickerBtnPlaceholder}>
                {category || 'Select category…'}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
            </TouchableOpacity>

            {type === 'job' && (
              <View style={styles.toggleRow}>
                <View style={styles.toggleLabelWrap}>
                  <Ionicons name="document-text-outline" size={15} color={colors.textSecondary} />
                  <Text style={styles.toggleLabel}>Add to Invoice</Text>
                </View>
                <Switch
                  value={addToInvoice}
                  onValueChange={setAddToInvoice}
                  trackColor={{ false: '#e5e7eb', true: '#86efac' }}
                  thumbColor={addToInvoice ? colors.primary : '#9ca3af'}
                />
              </View>
            )}

            <View style={styles.photosLabelRow}>
              <FormLabel text="PHOTOS" />
              <Text style={styles.photoCountLabel}>{photos.length}/25</Text>
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
                  <View key={i} style={styles.photoThumbWrap}>
                    <TouchableOpacity onPress={() => setViewingPhoto(photo.uri)} activeOpacity={0.85}>
                      <Image
                        source={{ uri: photo.uri }}
                        style={styles.photoThumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={250}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.photoDeleteBtn} onPress={() => handleDeletePhoto(i)}>
                      <Ionicons name="close-circle" size={22} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>

        <PickerSheet
          visible={showJobPicker}
          title="Select Job"
          onClose={() => setShowJobPicker(false)}
          items={selectableJobs.map((j) => ({
            key:   j.id,
            label: j.projectName || 'Untitled',
            sub:   j.billToName || '',
          }))}
          onSelect={(key) => {
            setSelectedJob(selectableJobs.find((j) => j.id === key));
            setShowJobPicker(false);
          }}
        />

        <PickerSheet
          visible={showCatPicker}
          title="Select Category"
          onClose={() => setShowCatPicker(false)}
          items={cats.map((c) => ({ key: c, label: c }))}
          onSelect={(key) => { setCategory(key); setShowCatPicker(false); }}
        />

        <Modal
          visible={viewingPhoto !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setViewingPhoto(null)}
        >
          <View style={styles.photoViewerBg}>
            <TouchableOpacity style={styles.photoViewerClose} onPress={() => setViewingPhoto(null)}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            {viewingPhoto && (
              <Image
                source={{ uri: viewingPhoto }}
                style={styles.photoViewerImage}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={200}
              />
            )}
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

// ── PickerSheet ────────────────────────────────────────────────────────────────

function PickerSheet({ visible, title, items, onSelect, onClose }) {
  if (!visible) return null;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
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
              <View style={{ flex: 1 }}>
                <Text style={styles.pickerItemLabel}>{item.label}</Text>
                {item.sub ? <Text style={styles.pickerItemSub}>{item.sub}</Text> : null}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function FormLabel({ text }) {
  return <Text style={styles.formLabel}>{text}</Text>;
}

// ── Styles ─────────────────────────────────────────────────────────────────────

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

  rangeToggle: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  rangeBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  rangeBtnActive: { backgroundColor: colors.primary },
  rangeBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  rangeBtnTextActive: { color: '#fff' },

  summaryRow: { flexDirection: 'row', gap: 10, padding: 16, paddingBottom: 8 },
  summaryCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 2,
  },
  summaryCardActive: { borderColor: colors.primary, backgroundColor: '#f0fdf4' },
  summaryDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 6 },
  summaryAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
    alignSelf: 'stretch',
    textAlign: 'center',
  },
  summaryAmountActive: { color: colors.primary },
  summaryLabel: { fontSize: 11, color: colors.textSecondary, marginTop: 2, fontWeight: '500' },
  summaryLabelActive: { color: colors.primary },

  filterBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterBannerText: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  listWrap: { paddingHorizontal: 16, gap: 1 },

  expenseRow: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  expenseLeft: { flex: 1, marginRight: 12 },
  expenseDate: { fontSize: 11, color: colors.textMuted, fontWeight: '500', marginBottom: 2 },
  expenseDesc: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  expenseMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  expenseCat: { fontSize: 11, color: colors.textSecondary },
  expenseJob: { fontSize: 11, color: colors.textMuted, flex: 1 },
  expenseRight: { alignItems: 'flex-end', gap: 6 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  expenseAmount: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  expensePhotoHint: { fontSize: 11, color: colors.textMuted },
  rowEditBtn: { padding: 4, backgroundColor: '#f3f4f6', borderRadius: 6 },

  typeBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  typeBadgeJob: { backgroundColor: '#dbeafe' },
  typeBadgeCompany: { backgroundColor: '#fef3c7' },
  typeText: { fontSize: 10, fontWeight: '700' },
  typeTextJob: { color: '#2563eb' },
  typeTextCompany: { color: '#d97706' },

  deleteAction: {
    backgroundColor: '#dc2626',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    gap: 4,
  },
  deleteActionText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 13, color: colors.textSecondary },

  modalContainer: { flex: 1, backgroundColor: '#f9fafb' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  modalCancel: { fontSize: 16, color: colors.textSecondary },
  modalSave: { fontSize: 16, fontWeight: '700', color: colors.primary },
  modalContent: { padding: 16 },

  formLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    letterSpacing: 0.8, marginBottom: 6, marginTop: 14, marginLeft: 4,
  },

  typeToggle: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 3,
  },
  typeToggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 8,
  },
  typeToggleBtnActive: { backgroundColor: colors.primary },
  typeToggleText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  typeToggleTextActive: { color: '#fff' },

  pickerBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  pickerBtnValue: { fontSize: 15, color: colors.textPrimary, flex: 1 },
  pickerBtnPlaceholder: { fontSize: 15, color: colors.textMuted, flex: 1 },

  inputCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  inputPrefix: { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  input: { fontSize: 15, color: colors.textPrimary, paddingVertical: 14 },
  inputMulti: { minHeight: 80, textAlignVertical: 'top', paddingTop: 14 },

  pickerSheet: { flex: 1, backgroundColor: '#f9fafb' },
  pickerSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  pickerSheetTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  pickerItem: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  pickerItemLabel: { fontSize: 15, color: colors.textPrimary, fontWeight: '500' },
  pickerItemSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  toggleLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleLabel: { fontSize: 15, color: colors.textPrimary, fontWeight: '500' },

  photosLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 6, marginHorizontal: 4 },
  photoCountLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  addPhotoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#f0fdf4', borderRadius: 12, paddingVertical: 12,
    borderWidth: 1.5, borderColor: '#86efac', borderStyle: 'dashed', marginBottom: 10,
  },
  addPhotoBtnText: { fontSize: 15, fontWeight: '600', color: colors.primary },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  photoThumbWrap: { position: 'relative', width: THUMB_SIZE, height: THUMB_SIZE },
  photoThumb: { width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: 8 },
  photoDeleteBtn: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12 },
  photoViewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.93)', justifyContent: 'center', alignItems: 'center' },
  photoViewerClose: { position: 'absolute', top: 60, right: 20, zIndex: 10, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 6 },
  photoViewerImage: { width: SCREEN_WIDTH, height: SCREEN_WIDTH * 1.2 },
});
