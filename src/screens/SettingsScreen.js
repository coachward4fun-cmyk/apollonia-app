import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getJobs, getCrews, getExpenses, getCustomers,
  importBackup, deleteJob, deleteExpense, saveJob, saveEmailConfig,
  getTwilioConfig, saveTwilioConfig,
} from '../services/db';
import { invalidateSMSConfig, sendSMS, getTwilioConfig as getSMSConfig } from '../utils/sendSMS';
import { useAppData } from '../context/AppDataContext';
import { deleteStoragePhoto, jobPhotoPath, expensePhotoPath, testStorageConnection } from '../services/storageService';
import { SkeletonCard } from '../components/SkeletonLoader';
import { logActivity } from '../services/activityLog';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/colors';
import { useBuildExpiry, formatExpiryDate, calcDaysLeft, daysColor } from '../hooks/useBuildExpiry';
import { auth, storage } from '../config/firebase';
import { ref, listAll, getMetadata } from 'firebase/storage';

const BUILD_COUNT_KEY = 'apollonia:build_count';

function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON — expected an object at root.');
  if (!Array.isArray(data.jobs)) throw new Error('Missing "jobs" array in backup file.');
}

async function readTextFromAsset(asset) {
  const response = await fetch(asset.uri);
  if (!response.ok) throw new Error(`Could not read file (HTTP ${response.status})`);
  return response.text();
}

function escapeCsv(val) {
  if (val == null) return '""';
  return '"' + String(val).replace(/"/g, '""') + '"';
}

function buildJobsCsv(jobs) {
  const headers = [
    'ID', 'Project Name', 'Bill To', 'Address', 'Status',
    'Target Date', 'Invoice Date', 'Due Date', 'Invoice Total',
    'Job Type', 'Crew ID', 'Estimated Duration', 'Notes', 'Photos',
  ];
  const rows = jobs.map((j) => [
    j.id, j.projectName, j.billToName, j.jobLocationAddress,
    j.status, j.targetDate, j.invoiceDate, j.dueDate,
    j.invoiceTotal, j.jobType, j.crewId, j.estimatedDuration,
    j.notes, (j.photos || []).length,
  ].map(escapeCsv).join(','));
  return [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
}

function buildExpensesCsv(expenses) {
  const headers = [
    'ID', 'Type', 'Date', 'Category', 'Description',
    'Amount', 'Job ID', 'Is Crew Cost', 'Add to Invoice', 'Photos',
  ];
  const rows = expenses.map((e) => [
    e.id, e.type, e.date, e.category, e.description,
    e.amount, e.jobId, e.isCrewCost, e.addToInvoice, (e.photos || []).length,
  ].map(escapeCsv).join(','));
  return [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
}

async function shareCsv(csv, filename, dialogTitle) {
  const fileUri = FileSystem.documentDirectory + filename;
  await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(fileUri, {
    mimeType: 'text/csv',
    dialogTitle,
    UTI: 'public.comma-separated-values-text',
  });
}

// ── Storage size helpers ───────────────────────────────────────────────────────

function jsonBytes(arr) {
  try { return JSON.stringify(arr).length; } catch { return 0; }
}

function formatSize(bytes) {
  if (bytes == null || bytes === 0) return '0 KB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function fetchPhotoStorageBytes() {
  let totalBytes = 0;
  for (const prefix of ['jobs', 'expenses']) {
    const prefixRef = ref(storage, prefix);
    const topResult = await listAll(prefixRef);
    for (const folderRef of topResult.prefixes) {
      const folderResult = await listAll(folderRef);
      for (const itemRef of folderResult.items) {
        try {
          const meta = await getMetadata(itemRef);
          totalBytes += meta.size || 0;
        } catch (err) {
          console.warn('[Storage] getMetadata error for', itemRef.fullPath, ':', err.message);
        }
      }
    }
  }
  return totalBytes;
}

// ──────────────────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { user, logout } = useAuth();
  const { emailConfig, refreshEmailConfig } = useAppData();
  const [importing,       setImporting]       = useState(false);
  const [buildVersion,    setBuildVersion]    = useState('');
  const [showSupport,     setShowSupport]     = useState(false);
  const [storageLoading,  setStorageLoading]  = useState(null);
  const [diagLoading,     setDiagLoading]     = useState(false);

  const [jobs,      setJobs]      = useState([]);
  const [crews,     setCrews]     = useState([]);
  const [expenses,  setExpenses]  = useState([]);
  const [customers, setCustomers] = useState([]);

  const buildExpiry = useBuildExpiry();

  const [photoStorageBytes,    setPhotoStorageBytes]    = useState(null);
  const [photoStorageLoading,  setPhotoStorageLoading]  = useState(true);
  const [photoStorageError,    setPhotoStorageError]    = useState(false);
  const [summaryLoading,       setSummaryLoading]       = useState(true);

  useEffect(() => {
    Promise.all([
      getJobs().then(setJobs).catch(() => {}),
      getCrews().then(setCrews).catch(() => {}),
      getExpenses().then(setExpenses).catch(() => {}),
      getCustomers().then(setCustomers).catch(() => {}),
    ]).finally(() => setSummaryLoading(false));
  }, []);

  const loadBuildVersion = useCallback(async () => {
    const raw   = await AsyncStorage.getItem(BUILD_COUNT_KEY);
    const count = parseInt(raw || '0', 10) + 1;
    await AsyncStorage.setItem(BUILD_COUNT_KEY, String(count));
    const date   = new Date().toISOString().slice(0, 10);
    const padded = String(count).padStart(3, '0');
    setBuildVersion(`${date}+${padded}`);
  }, []);

  useEffect(() => { loadBuildVersion(); }, [loadBuildVersion]);

  useEffect(() => {
    setPhotoStorageLoading(true);
    setPhotoStorageError(false);
    fetchPhotoStorageBytes()
      .then((bytes) => setPhotoStorageBytes(bytes))
      .catch((err) => {
        console.error('[Storage] photo size fetch failed:', err.message);
        setPhotoStorageError(true);
        setPhotoStorageBytes(null);
      })
      .finally(() => setPhotoStorageLoading(false));
  }, []);

  const summary = {
    jobs:      jobs.length,
    crews:     crews.length,
    expenses:  expenses.length,
    customers: customers.length,
    photos:    jobs.reduce((s, j) => s + (j.photos || []).length, 0) +
               expenses.reduce((s, e) => s + (e.photos || []).length, 0),
  };
  const hasData = summary.jobs > 0 || summary.crews > 0 || summary.expenses > 0;

  const sizes = {
    jobs:      jsonBytes(jobs),
    crews:     jsonBytes(crews),
    expenses:  jsonBytes(expenses),
    customers: jsonBytes(customers),
    photos:    photoStorageBytes,
  };
  const totalBytes =
    sizes.jobs + sizes.crews + sizes.expenses + sizes.customers +
    (sizes.photos ?? 0);

  const handleImport = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset) return;

      setImporting(true);

      const text = await readTextFromAsset(asset);
      const data = JSON.parse(text);
      validate(data);

      const jobCount     = data.jobs?.length ?? 0;
      const crewCount    = data.crews?.length ?? 0;
      const expenseCount = data.expenses?.length ?? 0;

      Alert.alert(
        'Import Backup',
        `Found:\n• ${jobCount} jobs\n• ${crewCount} crews\n• ${expenseCount} expenses\n\nThis will replace all existing data for all users. Continue?`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setImporting(false) },
          {
            text: 'Import',
            style: 'destructive',
            onPress: async () => {
              try {
                await importBackup({
                  jobs:     data.jobs ?? [],
                  crews:    data.crews ?? [],
                  expenses: data.expenses ?? [],
                });
                Alert.alert('Import Complete', `Successfully imported ${jobCount} jobs, ${crewCount} crews, and ${expenseCount} expenses.`);
              } catch (err) {
                Alert.alert('Import Failed', err.message || 'Could not save data.');
              } finally {
                setImporting(false);
              }
            },
          },
        ]
      );
    } catch (err) {
      setImporting(false);
      Alert.alert('Import Failed', err.message || 'Could not read the file. Make sure it is a valid Apollonia backup JSON.');
    }
  };

  const handleClearLocalCache = () => {
    Alert.alert(
      'Clear Local Cache Data',
      'This will clear your local device cache. All your data is safely stored in the cloud and will reload automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Cache',
          style: 'destructive',
          onPress: async () => {
            try {
              const allKeys = await AsyncStorage.getAllKeys();
              const apolloniaKeys = allKeys.filter((k) => k.startsWith('apollonia:'));
              if (apolloniaKeys.length > 0) await AsyncStorage.multiRemove(apolloniaKeys);
              Alert.alert('Cache Cleared', `Cleared ${apolloniaKeys.length} cached item(s). Your data will reload from the cloud on next launch.`);
            } catch (err) {
              Alert.alert('Error', err.message || 'Could not clear cache.');
            }
          },
        },
      ]
    );
  };

  // Remove photos from paid jobs in Firebase Storage
  const handleRemovePaidJobPhotos = async () => {
    try {
      setStorageLoading('photos');
      const paidJobs = jobs.filter(
        (j) => (j.status || '').toLowerCase() === 'invoice paid' && (j.photos || []).length > 0
      );
      setStorageLoading(null);

      if (paidJobs.length === 0) {
        Alert.alert('No Paid Jobs', 'There are no paid jobs with photos to remove.');
        return;
      }

      const paidPhotoCount  = paidJobs.reduce((s, j) => s + (j.photos || []).length, 0);
      const allPhotoCount   = jobs.reduce((s, j) => s + (j.photos || []).length, 0) +
                              expenses.reduce((s, e) => s + (e.photos || []).length, 0);
      const estimatedBytes  = allPhotoCount > 0 && photoStorageBytes
        ? Math.round((paidPhotoCount / allPhotoCount) * photoStorageBytes)
        : 0;
      const sizeStr = formatSize(estimatedBytes);

      Alert.alert(
        'Remove Photos for Paid Jobs',
        `This will permanently delete all photos for paid jobs, freeing up ${sizeStr}. This cannot be undone. Are you sure?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete Photos',
            style: 'destructive',
            onPress: async () => {
              setStorageLoading('photos');
              try {
                for (const job of paidJobs) {
                  for (const url of (job.photos || [])) {
                    const filename = url.split('/').pop().split('?')[0];
                    await deleteStoragePhoto(jobPhotoPath(job.id, filename));
                  }
                  await saveJob({ ...job, photos: [] });
                }
                setStorageLoading(null);
                Alert.alert('Done', `Removed photos from ${paidJobs.length} paid job(s).`);
              } catch (err) {
                setStorageLoading(null);
                Alert.alert('Error', err.message || 'Could not remove photos.');
              }
            },
          },
        ]
      );
    } catch (err) {
      setStorageLoading(null);
      Alert.alert('Error', err.message || 'Could not check jobs.');
    }
  };

  // Export jobs CSV → optional erase paid jobs
  const handleExportJobData = async () => {
    try {
      setStorageLoading('jobs');

      if (jobs.length === 0) {
        setStorageLoading(null);
        Alert.alert('No Data', 'There are no jobs to export.');
        return;
      }

      const date = new Date().toISOString().slice(0, 10);
      await shareCsv(buildJobsCsv(jobs), `apollonia-jobs-${date}.csv`, 'Export Jobs & Invoice Data');
      setStorageLoading(null);

      const paidJobs = jobs.filter((j) => (j.status || '').toLowerCase() === 'invoice paid');
      if (paidJobs.length === 0) return;

      const paidPhotoCount = paidJobs.reduce((s, j) => s + (j.photos || []).length, 0);
      const allPhotoCount  = jobs.reduce((s, j) => s + (j.photos || []).length, 0) +
                             expenses.reduce((s, e) => s + (e.photos || []).length, 0);
      const photoEstimate  = allPhotoCount > 0 && photoStorageBytes
        ? Math.round((paidPhotoCount / allPhotoCount) * photoStorageBytes)
        : 0;
      const sizeStr = formatSize(jsonBytes(paidJobs) + photoEstimate);

      Alert.alert(
        'Erase Paid Job Data?',
        `Your data has been exported successfully. Would you like to erase all paid job data and photos to free up ${sizeStr} of storage? This cannot be undone.`,
        [
          { text: 'Keep Data', style: 'cancel' },
          {
            text: 'Erase Paid Jobs',
            style: 'destructive',
            onPress: async () => {
              setStorageLoading('jobs');
              try {
                for (const job of paidJobs) {
                  for (const url of (job.photos || [])) {
                    const filename = url.split('/').pop().split('?')[0];
                    await deleteStoragePhoto(jobPhotoPath(job.id, filename));
                  }
                  await deleteJob(job.id);
                }
                setStorageLoading(null);
                Alert.alert('Done', `Erased ${paidJobs.length} paid job(s) and their photos.`);
              } catch (err) {
                setStorageLoading(null);
                Alert.alert('Error', err.message);
              }
            },
          },
        ]
      );
    } catch (err) {
      setStorageLoading(null);
      Alert.alert('Export Failed', err.message || 'Could not export job data.');
    }
  };

  // Export expenses CSV → optional erase all expenses
  const handleExportExpenseData = async () => {
    try {
      setStorageLoading('expenses');

      if (expenses.length === 0) {
        setStorageLoading(null);
        Alert.alert('No Data', 'There are no expenses to export.');
        return;
      }

      const date = new Date().toISOString().slice(0, 10);
      await shareCsv(buildExpensesCsv(expenses), `apollonia-expenses-${date}.csv`, 'Export Expense Data');
      setStorageLoading(null);

      const expPhotoCount  = expenses.reduce((s, e) => s + (e.photos || []).length, 0);
      const allPhotoCount  = jobs.reduce((s, j) => s + (j.photos || []).length, 0) +
                             expenses.reduce((s, e) => s + (e.photos || []).length, 0);
      const photoEstimate  = allPhotoCount > 0 && photoStorageBytes
        ? Math.round((expPhotoCount / allPhotoCount) * photoStorageBytes)
        : 0;
      const sizeStr = formatSize(jsonBytes(expenses) + photoEstimate);

      Alert.alert(
        'Erase Expense Data?',
        `Your expense data has been exported successfully. Would you like to erase all expense data and photos to free up ${sizeStr} of storage? This cannot be undone.`,
        [
          { text: 'Keep Data', style: 'cancel' },
          {
            text: 'Erase Expenses',
            style: 'destructive',
            onPress: async () => {
              setStorageLoading('expenses');
              try {
                for (const exp of expenses) {
                  for (const url of (exp.photos || [])) {
                    const filename = url.split('/').pop().split('?')[0];
                    await deleteStoragePhoto(expensePhotoPath(exp.id, filename));
                  }
                  await deleteExpense(exp.id);
                }
                setStorageLoading(null);
                Alert.alert('Done', 'Erased all expense data and photos.');
              } catch (err) {
                setStorageLoading(null);
                Alert.alert('Error', err.message);
              }
            },
          },
        ]
      );
    } catch (err) {
      setStorageLoading(null);
      Alert.alert('Export Failed', err.message || 'Could not export expense data.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Admin</Text>
          {buildVersion ? (
            <View style={styles.versionPill}>
              <Text style={styles.versionPillText}>{buildVersion}</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.sectionLabel}>COMPANY PROFILE</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.settingsRow} onPress={() => navigation.navigate('CompanyProfile')} activeOpacity={0.7}>
            <View style={styles.settingsRowLeft}>
              <Ionicons name="business-outline" size={20} color={colors.primary} />
              <Text style={styles.settingsRowLabel}>Identity, Logo &amp; Tax Rates</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>APP CONFIGURATION</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.settingsRow} onPress={() => navigation.navigate('JobTypes')} activeOpacity={0.7}>
            <View style={styles.settingsRowLeft}>
              <Ionicons name="list-outline" size={20} color={colors.primary} />
              <Text style={styles.settingsRowLabel}>Job Types &amp; Invoice Defaults</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {user?.email === 'coachward4fun@gmail.com' && (
          <>
            <Text style={styles.sectionLabel}>EMAIL CONFIGURATION</Text>
            <View style={styles.card}>
              <EmailConfigSection
                emailConfig={emailConfig}
                onSaved={refreshEmailConfig}
              />
            </View>

            <Text style={styles.sectionLabel}>SMS CONFIGURATION</Text>
            <View style={styles.card}>
              <SMSConfigSection />
            </View>
          </>
        )}

        <Text style={styles.sectionLabel}>DATA SUMMARY</Text>
        <View style={styles.card}>
          {summaryLoading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : (
            <>
              <DataRow icon="briefcase-outline"     label="Jobs"      value={summary.jobs}      size={formatSize(sizes.jobs)}      onPress={() => navigation.navigate('Jobs', { screen: 'JobsList' })} />
              <DataRow icon="people-outline"        label="Crews"     value={summary.crews}     size={formatSize(sizes.crews)}     onPress={() => navigation.navigate('Crews', { screen: 'CrewsList' })} divider />
              <DataRow icon="wallet-outline"        label="Expenses"  value={summary.expenses}  size={formatSize(sizes.expenses)}  onPress={() => navigation.navigate('Expenses')} divider />
              <DataRow icon="image-outline"         label="Photos"    value={summary.photos}    size={photoStorageLoading ? '…' : photoStorageError ? 'Unable to calculate' : sizes.photos == null ? '—' : formatSize(sizes.photos)} divider />
              <DataRow icon="person-circle-outline" label="Customers" value={summary.customers} size={formatSize(sizes.customers)} onPress={() => navigation.navigate('CustomerList')} divider />
              <View style={styles.rowDivider} />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>TOTAL</Text>
                <Text style={styles.totalValue}>{formatSize(totalBytes)}</Text>
              </View>
            </>
          )}
        </View>

        <Text style={styles.sectionLabel}>STORAGE MANAGEMENT</Text>
        <View style={styles.card}>
          <StorageAction
            icon="image-outline"
            label="Remove Photos for Paid Jobs"
            color="#d97706"
            loading={storageLoading === 'photos'}
            onPress={handleRemovePaidJobPhotos}
          />
          <View style={styles.rowDivider} />
          <StorageAction
            icon="document-text-outline"
            label="Export Job & Invoice Data (CSV)"
            color={colors.primary}
            loading={storageLoading === 'jobs'}
            onPress={handleExportJobData}
          />
          <View style={styles.rowDivider} />
          <StorageAction
            icon="wallet-outline"
            label="Export Expense Data (CSV)"
            color="#2563eb"
            loading={storageLoading === 'expenses'}
            onPress={handleExportExpenseData}
          />
        </View>

        <Text style={styles.sectionLabel}>ACCOUNT</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.settingsRow} onPress={logout} activeOpacity={0.7}>
            <View style={styles.settingsRowLeft}>
              <Ionicons name="log-out-outline" size={20} color="#dc2626" />
              <Text style={[styles.settingsRowLabel, { color: '#dc2626' }]}>Sign Out</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>BUILD INFORMATION</Text>
        <View style={styles.card}>
          <BuildInfoRow
            label="Build Expiry Date"
            value={buildExpiry.loading ? 'Loading…' : (formatExpiryDate(buildExpiry.expiryDate) ?? '—')}
          />
          <View style={styles.rowDivider} />
          <BuildInfoRow
            label="Days Remaining"
            value={buildExpiry.loading ? 'Loading…' : (buildExpiry.expiryDate == null ? '—' : String(Math.max(0, calcDaysLeft(buildExpiry.expiryDate))))}
            valueColor={buildExpiry.loading || buildExpiry.expiryDate == null ? undefined : daysColor(calcDaysLeft(buildExpiry.expiryDate))}
          />
          <View style={styles.rowDivider} />
          <BuildInfoRow
            label="Build Date"
            value={buildExpiry.loading ? 'Loading…' : (formatExpiryDate(buildExpiry.buildDate) ?? '—')}
          />
          <View style={styles.rowDivider} />
          <BuildInfoRow
            label="Updated By"
            value={buildExpiry.loading ? 'Loading…' : (buildExpiry.updatedBy ?? '—')}
          />
        </View>

        <Text style={styles.sectionLabel}>SUPPORT & DATA</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.settingsRow} onPress={() => setShowSupport(true)} activeOpacity={0.7}>
            <View style={styles.settingsRowLeft}>
              <Ionicons name="help-circle-outline" size={20} color={colors.primary} />
              <Text style={styles.settingsRowLabel}>Support &amp; Import</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>DIAGNOSTICS</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.settingsRow}
            activeOpacity={0.7}
            disabled={diagLoading}
            onPress={async () => {
              setDiagLoading(true);
              try {
                const r = await testStorageConnection();
                const lines = [
                  r.authenticated
                    ? `Authentication: Authenticated as ${r.email}`
                    : 'Authentication: Not authenticated',
                  r.bucket
                    ? `Storage bucket: Connected to ${r.bucket}`
                    : 'Storage bucket: Cannot reach bucket',
                  r.readOk
                    ? 'Read access: Read access OK'
                    : `Read access: Read access FAILED: ${r.readError || 'unknown'}`,
                  r.writeOk
                    ? 'Write access: Write access OK'
                    : `Write access: Write access FAILED: ${r.writeError || 'unknown'}`,
                  '',
                  r.overallOk
                    ? '✅ Storage Connected'
                    : `❌ Storage Failed: ${r.failReason || 'unknown error'}`,
                ];
                const parts = [];
                if (r.authenticated) parts.push('Auth OK'); else parts.push('Auth FAILED');
                if (r.bucket)        parts.push('Bucket OK'); else parts.push('Bucket FAILED');
                if (r.readOk)        parts.push('Read OK'); else parts.push(`Read FAILED: ${r.readError || 'unknown'}`);
                if (r.writeOk)       parts.push('Write OK'); else parts.push(`Write FAILED: ${r.writeError || 'unknown'}`);
                const logDetails = r.overallOk
                  ? `✅ Storage Connected - ${parts.join(', ')}`
                  : `❌ Storage Failed - ${parts.join(', ')}`;
                logActivity('storage_connection_test', logDetails);
                Alert.alert('Storage Test Results', lines.join('\n'));
              } catch (err) {
                Alert.alert('Storage Test Failed', err.message || 'Unexpected error');
              } finally {
                setDiagLoading(false);
              }
            }}
          >
            <View style={styles.settingsRowLeft}>
              <Ionicons name="cloud-upload-outline" size={20} color={diagLoading ? colors.textMuted : colors.primary} />
              <Text style={[styles.settingsRowLabel, diagLoading && { color: colors.textMuted }]}>
                {diagLoading ? 'Testing Storage…' : 'Test Storage Connection'}
              </Text>
            </View>
            {diagLoading
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            }
          </TouchableOpacity>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>

      <Modal visible={showSupport} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowSupport(false)}>
        <SafeAreaView style={styles.supportContainer}>
          <View style={styles.supportHeader}>
            <Text style={styles.supportTitle}>Support &amp; Import</Text>
            <TouchableOpacity onPress={() => setShowSupport(false)} style={styles.supportClose}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.supportContent} showsVerticalScrollIndicator={false}>

            <View style={styles.supportBrand}>
              <Text style={styles.supportBrandName}>Apollonia Construction LLC</Text>
              <Text style={styles.supportBrandSub}>Omaha, Nebraska</Text>
              {buildVersion ? <Text style={styles.supportBrandVersion}>{buildVersion}</Text> : null}
            </View>

            <Text style={styles.supportSectionLabel}>CONTACT</Text>
            <View style={styles.supportCard}>
              <View style={styles.supportRow}>
                <Ionicons name="person-outline" size={18} color={colors.primary} />
                <Text style={styles.supportRowText}>Scott Ward</Text>
              </View>
              <View style={[styles.supportRow, { marginTop: 10 }]}>
                <Ionicons name="mail-outline" size={18} color={colors.primary} />
                <Text style={styles.supportRowText}>coachward4fun@gmail.com</Text>
              </View>
            </View>

            {user?.email === 'coachward4fun@gmail.com' && (
              <>
                <Text style={styles.supportSectionLabel}>IMPORT DATA</Text>
                <View style={styles.supportCard}>
                  <Text style={styles.importDesc}>
                    Import a JSON backup to replace all existing data in Firestore for all users.
                  </Text>
                  <TouchableOpacity
                    style={[styles.importButton, importing && styles.importButtonDisabled]}
                    onPress={handleImport}
                    disabled={importing}
                  >
                    {importing ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <>
                        <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                        <Text style={styles.importButtonText}>Choose Backup File…</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <View style={styles.hintRow}>
                    <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.hintText}>
                      File format: <Text style={styles.hintMono}>apollonia-backup-*.json</Text>
                    </Text>
                  </View>
                </View>
              </>
            )}

            <Text style={styles.supportSectionLabel}>DEVICE CACHE</Text>
            <View style={styles.supportCard}>
              <TouchableOpacity style={styles.clearButton} onPress={handleClearLocalCache}>
                <Ionicons name="refresh-outline" size={16} color="#d97706" />
                <Text style={[styles.clearButtonText, { color: '#d97706' }]}>Clear Local Cache Data</Text>
              </TouchableOpacity>
              <Text style={styles.cacheHint}>
                Clears cached data on this device. All data reloads from the cloud automatically.
              </Text>
            </View>

            <Text style={styles.supportSectionLabel}>ABOUT</Text>
            <View style={styles.supportCard}>
              <Text style={styles.supportAboutText}>
                Apollonia is a field management app for Apollonia Construction LLC. Data is stored in Firebase and shared in real time across all users.
              </Text>
            </View>

            <View style={{ height: 32 }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function BuildInfoRow({ label, value, valueColor }) {
  return (
    <View style={styles.dataRow}>
      <Text style={styles.dataRowLabel}>{label}</Text>
      <Text style={[styles.buildInfoValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
    </View>
  );
}

function DataRow({ icon, label, value, size, divider, onPress }) {
  const inner = (
    <View style={styles.dataRow}>
      <View style={styles.dataRowLeft}>
        <Ionicons name={icon} size={16} color={colors.primary} />
        <Text style={styles.dataRowLabel}>{label}</Text>
      </View>
      <View style={styles.dataRowRight}>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.dataRowValue}>{value}</Text>
          {size != null && <Text style={styles.dataRowSize}>{size}</Text>}
        </View>
        {onPress && <Ionicons name="chevron-forward" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />}
      </View>
    </View>
  );
  return (
    <>
      {divider && <View style={styles.rowDivider} />}
      {onPress
        ? <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{inner}</TouchableOpacity>
        : inner}
    </>
  );
}


function SMSConfigSection() {
  const [accountSid,  setAccountSid]  = useState('');
  const [authToken,   setAuthToken]   = useState('');
  const [tokenLocked, setTokenLocked] = useState(true);
  const [fromNumber,  setFromNumber]  = useState('');
  const [saving,      setSaving]      = useState(false);
  const [loaded,      setLoaded]      = useState(false);
  const [testing,     setTesting]     = useState(false);
  const [testResult,  setTestResult]  = useState(null);

  useEffect(() => {
    getTwilioConfig().then((cfg) => {
      if (cfg) {
        setAccountSid(cfg.accountSid || '');
        setFromNumber(cfg.fromNumber || '');
        // authToken intentionally not pre-filled
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = {
        accountSid: accountSid.trim(),
        fromNumber: fromNumber.trim(),
      };
      if (!tokenLocked && authToken.trim()) {
        updates.authToken = authToken.trim();
      }
      await saveTwilioConfig(updates);
      invalidateSMSConfig();
      setAuthToken('');
      setTokenLocked(true);
      setTestResult(null);
      Alert.alert('Saved', 'SMS configuration updated.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save SMS configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestSMS = async () => {
    setTesting(true);
    setTestResult(null);
    invalidateSMSConfig();

    const toNumber = '+14023123535';
    const message  = 'Apollonia Test SMS - if you receive this, SMS is working!';

    // Log config before sending so we can see what's loaded
    const config = await getSMSConfig();
    console.log('Twilio config loaded:', config ? 'yes' : 'no');
    console.log('AccountSid:', config?.accountSid?.substring(0, 10));
    console.log('FromNumber:', config?.fromNumber);

    const result = await sendSMS(toNumber, message);

    setTestResult({ ok: result.success });

    if (result.success) {
      logActivity('sms_test_sent', `Test SMS sent successfully - SID: ${result.sid} - To: ${toNumber}`);
      Alert.alert(
        '✅ SMS Sent!',
        `SID: ${result.sid}\nTo: ${toNumber}`,
        [{ text: 'OK' }]
      );
    } else {
      logActivity('sms_test_failed', `Test SMS FAILED - Error: ${result.error}`);
      Alert.alert(
        '❌ SMS Failed',
        String(result.error),
        [{ text: 'OK' }]
      );
    }

    setTesting(false);
  };

  if (!loaded) return <ActivityIndicator color={colors.primary} style={{ padding: 12 }} />;

  return (
    <View>
      <ConfigField label="Account SID" value={accountSid} onChangeText={setAccountSid} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" autoCapitalize="none" />
      <View style={styles.configDivider} />
      <View style={styles.configField}>
        <Text style={styles.configFieldLabel}>Auth Token</Text>
        <View style={styles.appPasswordRow}>
          <TextInput
            style={[styles.configFieldInput, { flex: 1 }]}
            value={tokenLocked ? '••••••••••••••••' : authToken}
            onChangeText={tokenLocked ? undefined : setAuthToken}
            placeholder={tokenLocked ? '' : 'leave blank to keep existing'}
            placeholderTextColor={colors.textMuted}
            secureTextEntry={!tokenLocked}
            editable={!tokenLocked}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            onPress={() => {
              if (tokenLocked) {
                Alert.alert(
                  'Edit Auth Token',
                  'Warning: Changes to this field will impact SMS delivery. Are you sure you want to edit this?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Unlock', onPress: () => { setTokenLocked(false); setAuthToken(''); } },
                  ]
                );
              } else {
                setTokenLocked(true);
                setAuthToken('');
              }
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={tokenLocked ? 'lock-closed' : 'lock-open'}
              size={18}
              color={tokenLocked ? colors.textMuted : colors.primary}
            />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.configDivider} />
      <ConfigField label="From Number" value={fromNumber} onChangeText={setFromNumber} placeholder="+18005551234" autoCapitalize="none" keyboardType="phone-pad" />

      <View style={styles.smsTrialNote}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
        <Text style={styles.smsTrialText}>
          Trial mode: SMS only sends to verified numbers. Upgrade your Twilio account to send to all numbers.
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.saveConfigButton, saving && { opacity: 0.6 }]}
        onPress={handleSave}
        disabled={saving}
        activeOpacity={0.7}
      >
        {saving
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={styles.saveConfigButtonText}>Save SMS Config</Text>
        }
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.testSmsButton, testing && { opacity: 0.6 }]}
        onPress={handleTestSMS}
        disabled={testing}
        activeOpacity={0.7}
      >
        {testing
          ? <ActivityIndicator color={colors.primary} size="small" />
          : (
            <>
              <Ionicons name="send-outline" size={15} color={colors.primary} />
              <Text style={styles.testSmsButtonText}>Send Test SMS to 402-312-3535</Text>
            </>
          )
        }
      </TouchableOpacity>

      {testResult && (
        <Text style={[styles.smsTestStatus, { color: testResult.ok ? '#16a34a' : '#dc2626' }]}>
          {testResult.ok ? '✅ Test sent — check your phone' : '❌ Test failed — see alert for details'}
        </Text>
      )}
    </View>
  );
}

function EmailConfigSection({ emailConfig, onSaved }) {
  const [fromEmail,      setFromEmail]      = useState('');
  const [fromName,       setFromName]       = useState('');
  const [appPassword,    setAppPassword]    = useState('');
  const [passwordLocked, setPasswordLocked] = useState(true);
  const [replyTo,        setReplyTo]        = useState('');
  const [cc,             setCc]             = useState('');
  const [saving,         setSaving]         = useState(false);

  useEffect(() => {
    if (!emailConfig) return;
    setFromEmail(emailConfig.fromEmail || '');
    setFromName(emailConfig.fromName || '');
    setReplyTo(emailConfig.replyTo || '');
    setCc((emailConfig.cc || []).join(', '));
    // appPassword left blank — type a new one to change it
  }, [emailConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = {
        fromEmail: fromEmail.trim(),
        fromName:  fromName.trim(),
        replyTo:   replyTo.trim(),
        cc:        cc.split(',').map((e) => e.trim()).filter(Boolean),
      };
      if (!passwordLocked && appPassword.trim()) {
        updates.appPassword = appPassword.trim();
      }
      await saveEmailConfig(updates);
      setAppPassword('');
      setPasswordLocked(true);
      onSaved?.();
      Alert.alert('Saved', 'Email configuration updated successfully.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save email configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <ConfigField
        label="From Email"
        value={fromEmail}
        onChangeText={setFromEmail}
        placeholder="from@gmail.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={styles.configDivider} />
      <ConfigField
        label="From Name"
        value={fromName}
        onChangeText={setFromName}
        placeholder="Your Name — Company Name"
      />
      <View style={styles.configDivider} />
      <View style={styles.configField}>
        <Text style={styles.configFieldLabel}>App Password</Text>
        <View style={styles.appPasswordRow}>
          <TextInput
            style={[styles.configFieldInput, { flex: 1 }]}
            value={passwordLocked ? '••••••••••••••••' : appPassword}
            onChangeText={passwordLocked ? undefined : setAppPassword}
            placeholder={passwordLocked ? '' : 'leave blank to keep existing'}
            placeholderTextColor={colors.textMuted}
            secureTextEntry={!passwordLocked}
            editable={!passwordLocked}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            onPress={() => {
              if (passwordLocked) {
                Alert.alert(
                  'Edit App Password',
                  'Warning: Changes to this field will impact the delivery of all invoice emails. Are you sure you want to edit this?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Unlock', onPress: () => { setPasswordLocked(false); setAppPassword(''); } },
                  ]
                );
              } else {
                setPasswordLocked(true);
                setAppPassword('');
              }
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={passwordLocked ? 'lock-closed' : 'lock-open'}
              size={18}
              color={passwordLocked ? colors.textMuted : colors.primary}
            />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.configDivider} />
      <ConfigField
        label="Reply-To"
        value={replyTo}
        onChangeText={setReplyTo}
        placeholder="reply@email.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={styles.configDivider} />
      <ConfigField
        label="CC Emails (comma-separated)"
        value={cc}
        onChangeText={setCc}
        placeholder="cc1@email.com, cc2@email.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TouchableOpacity
        style={[styles.saveConfigButton, saving && { opacity: 0.6 }]}
        onPress={handleSave}
        disabled={saving}
        activeOpacity={0.7}
      >
        {saving
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={styles.saveConfigButtonText}>Save Email Config</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

function ConfigField({ label, value, onChangeText, placeholder, secureTextEntry, autoCapitalize, keyboardType }) {
  return (
    <View style={styles.configField}>
      <Text style={styles.configFieldLabel}>{label}</Text>
      <TextInput
        style={styles.configFieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize || 'sentences'}
        keyboardType={keyboardType || 'default'}
        autoCorrect={false}
      />
    </View>
  );
}

function StorageAction({ icon, label, color, onPress, loading }) {
  return (
    <TouchableOpacity style={styles.storageRow} onPress={loading ? undefined : onPress} activeOpacity={0.7}>
      <View style={styles.storageRowLeft}>
        <View style={[styles.storageIconWrap, { backgroundColor: color + '1a' }]}>
          <Ionicons name={icon} size={18} color={color} />
        </View>
        <Text style={styles.storageRowLabel}>{label}</Text>
      </View>
      {loading
        ? <ActivityIndicator size="small" color={color} />
        : <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      }
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16 },

  header: {
    paddingTop: 4,
    paddingBottom: 16,
  },
  headerTitle: { fontSize: 28, fontWeight: '800', color: colors.textPrimary },
  versionPill: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#86efac',
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 6,
  },
  versionPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
    fontFamily: 'Courier',
    letterSpacing: 0.3,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 8,
    marginLeft: 4,
  },

  card: {
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

  dataRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  dataRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dataRowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dataRowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  dataRowValue: { fontSize: 15, fontWeight: '700', color: colors.primary },
  buildInfoValue: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  dataRowSize: { fontSize: 11, color: colors.textMuted, fontWeight: '500', marginTop: 1 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  totalLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  totalValue: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  cacheHint: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 8 },
  rowDivider: { height: 1, backgroundColor: '#f3f4f6' },

  storageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  storageRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  storageIconWrap: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  storageRowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary, flex: 1 },

  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  settingsRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  settingsRowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },

  supportContainer: { flex: 1, backgroundColor: '#f9fafb' },
  supportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  supportTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  supportClose: { padding: 4 },
  supportContent: { padding: 16 },

  supportBrand: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  supportBrandName: { fontSize: 18, fontWeight: '800', color: '#fff' },
  supportBrandSub: { fontSize: 13, color: '#bbf7d0', marginTop: 4 },
  supportBrandVersion: { fontSize: 11, color: '#86efac', marginTop: 6, fontFamily: 'Courier' },

  supportSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  supportCard: {
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
  supportRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  supportRowText: { fontSize: 15, color: colors.textPrimary, flex: 1 },
  supportAboutText: { fontSize: 14, color: colors.textSecondary, lineHeight: 21 },

  importDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 14 },
  importButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
  },
  importButtonDisabled: { opacity: 0.6 },
  importButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  hintText: { fontSize: 12, color: colors.textMuted },
  hintMono: { fontFamily: 'Courier', color: colors.textSecondary },

  clearButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  clearButtonText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },

  configField: { paddingVertical: 10 },
  appPasswordRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  smsTrialNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 12, marginBottom: 4 },
  smsTrialText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  configFieldLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 },
  configFieldInput: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.textPrimary,
  },
  configDivider: { height: 1, backgroundColor: '#f3f4f6' },
  testSmsButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 12,
    marginTop: 10,
  },
  testSmsButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  smsTestStatus: { fontSize: 12, fontWeight: '600', textAlign: 'center', marginTop: 8 },
  saveConfigButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    marginTop: 12,
  },
  saveConfigButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
