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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  subscribeJobs, subscribeCrews, subscribeExpenses, subscribeCustomers,
  importBackup, deleteJob, deleteExpense, saveJob,
} from '../services/db';
import { deleteStoragePhoto, jobPhotoPath, expensePhotoPath, testStorageConnection } from '../services/storageService';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/colors';
import { useBuildExpiry, formatExpiryDate, calcDaysLeft, daysColor } from '../hooks/useBuildExpiry';
import { auth, storage } from '../config/firebase';

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
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function fetchPhotoStorageBytes() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) return null;
  const bucket = storage.app.options.storageBucket;
  let totalBytes = 0;
  for (const prefix of ['jobs%2F', 'expenses%2F']) {
    let pageToken = null;
    do {
      const url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?prefix=${prefix}&maxResults=1000` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const res = await fetch(url, { headers: { Authorization: `Firebase ${token}` } });
      if (!res.ok) break;
      const data = await res.json();
      for (const item of data.items || []) {
        totalBytes += parseInt(item.size || '0', 10);
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);
  }
  return totalBytes;
}

// ──────────────────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { user, logout } = useAuth();
  const [importing,       setImporting]       = useState(false);
  const [buildVersion,    setBuildVersion]    = useState('');
  const [showSupport,     setShowSupport]     = useState(false);
  const [storageLoading,  setStorageLoading]  = useState(null);

  const [jobs,      setJobs]      = useState([]);
  const [crews,     setCrews]     = useState([]);
  const [expenses,  setExpenses]  = useState([]);
  const [customers, setCustomers] = useState([]);

  const buildExpiry = useBuildExpiry();

  const [photoStorageBytes,    setPhotoStorageBytes]    = useState(null);
  const [photoStorageLoading,  setPhotoStorageLoading]  = useState(true);

  useEffect(() => {
    const unsubJobs = subscribeJobs(setJobs);
    const unsubCrews = subscribeCrews(setCrews);
    const unsubExp = subscribeExpenses(setExpenses);
    const unsubCust = subscribeCustomers(setCustomers);
    return () => { unsubJobs(); unsubCrews(); unsubExp(); unsubCust(); };
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
    fetchPhotoStorageBytes()
      .then((bytes) => setPhotoStorageBytes(bytes ?? null))
      .catch(() => setPhotoStorageBytes(null))
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

      const totalPhotoCount = paidJobs.reduce((s, j) => s + (j.photos || []).length, 0);

      Alert.alert(
        'Remove Paid Job Photos',
        `Remove ${totalPhotoCount} photo${totalPhotoCount !== 1 ? 's' : ''} from ${paidJobs.length} paid job(s)?\n\nJob records will be kept. Continue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove Photos',
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

      const doErasePaidJobs = () => {
        if (paidJobs.length === 0) {
          Alert.alert('No Paid Jobs', 'There are no paid jobs to erase.');
          return;
        }
        Alert.alert(
          'Erase Paid Job Data',
          `Erase ${paidJobs.length} paid job record(s) and photos?\n\nThis cannot be undone.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Erase',
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
      };

      Alert.alert(
        'Export Complete',
        'Would you like to also export expenses before erasing paid job data?',
        [
          {
            text: 'Yes, Export Expenses',
            onPress: async () => {
              if (expenses.length > 0) {
                const d2 = new Date().toISOString().slice(0, 10);
                await shareCsv(buildExpensesCsv(expenses), `apollonia-expenses-${d2}.csv`, 'Export Expenses');
              }
              doErasePaidJobs();
            },
          },
          { text: 'Skip', onPress: doErasePaidJobs },
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

      const totalPhotoCount = expenses.reduce((s, e) => s + (e.photos || []).length, 0);

      Alert.alert(
        'Export Complete',
        `Erase all ${expenses.length} expense records and ${totalPhotoCount} photo${totalPhotoCount !== 1 ? 's' : ''}?\n\nThis cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Erase',
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
                Alert.alert('Done', `Erased all expense data and photos.`);
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

        <Text style={styles.sectionLabel}>DATA SUMMARY</Text>
        <View style={styles.card}>
          <DataRow icon="briefcase-outline"     label="Jobs"      value={summary.jobs}      size={formatSize(sizes.jobs)}      onPress={() => navigation.navigate('Jobs', { screen: 'JobsList' })} />
          <DataRow icon="people-outline"        label="Crews"     value={summary.crews}     size={formatSize(sizes.crews)}     onPress={() => navigation.navigate('Crews', { screen: 'CrewsList' })} divider />
          <DataRow icon="wallet-outline"        label="Expenses"  value={summary.expenses}  size={formatSize(sizes.expenses)}  onPress={() => navigation.navigate('Expenses')} divider />
          <DataRow icon="image-outline"         label="Photos"    value={summary.photos}    size={photoStorageLoading ? '…' : (sizes.photos == null ? '—' : formatSize(sizes.photos))} divider />
          <DataRow icon="person-circle-outline" label="Customers" value={summary.customers} size={formatSize(sizes.customers)} onPress={() => navigation.navigate('CustomerList')} divider />
          <View style={styles.rowDivider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>TOTAL</Text>
            <Text style={styles.totalValue}>{formatSize(totalBytes)}</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>REPORTS</Text>
        <View style={styles.card}>
          <ReportRow
            icon="bar-chart-outline"
            label="Revenue YTD"
            onPress={() => navigation.navigate('RevenueYTD')}
          />
          <View style={styles.rowDivider} />
          <ReportRow
            icon="people-outline"
            label="Crew Pay YTD"
            onPress={() => navigation.navigate('CrewPayYTD')}
          />
          <View style={styles.rowDivider} />
          <ReportRow
            icon="time-outline"
            label="Activity Log"
            onPress={() => navigation.navigate('ActivityLog')}
          />
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
            onPress={async () => {
              Alert.alert('Storage Test', 'Running — check the Expo console for results.');
              await testStorageConnection();
            }}
          >
            <View style={styles.settingsRowLeft}>
              <Ionicons name="cloud-upload-outline" size={20} color={colors.primary} />
              <Text style={styles.settingsRowLabel}>Test Storage Connection</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
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

function ReportRow({ icon, label, onPress }) {
  return (
    <TouchableOpacity style={styles.settingsRow} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.settingsRowLeft}>
        <Ionicons name={icon} size={20} color={colors.primary} />
        <Text style={styles.settingsRowLabel}>{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </TouchableOpacity>
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
});
