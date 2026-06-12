import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
  Linking,
} from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getJobs, getCrews, getExpenses, getCustomers,
  importBackup, deleteJob, deleteExpense, saveJob, saveEmailConfig,
  deleteCustomerById, getBuildInfo, subscribeUsers, clearActivityLog,
} from '../services/db';
import { useAppData } from '../context/AppDataContext';
import { deleteStoragePhoto, storagePathFromUrl, testStorageConnection } from '../services/storageService';
import { SkeletonCard } from '../components/SkeletonLoader';
import { logActivity } from '../services/activityLog';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/colors';
import { useBuildExpiry, formatExpiryDate, calcDaysLeft, daysColor } from '../hooks/useBuildExpiry';
import { auth, storage } from '../config/firebase';
import { ref, listAll, getMetadata } from 'firebase/storage';

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

// Walks the photo Storage tree once. Sums file sizes for the report's
// "Photos" size column AND counts files whose parent `jobs/{jobId}/` prefix
// has no matching job document — surfaced as the report's "Orphaned Photos"
// row so a glance shows whether cleanup is needed.
async function fetchPhotoStorageStats(validJobIds) {
  let totalBytes = 0;
  let orphanedFileCount = 0;

  // jobs/ — both bytes AND orphan-file counting.
  const jobsPrefix = ref(storage, 'jobs');
  const jobsTop    = await listAll(jobsPrefix);
  for (const folderRef of jobsTop.prefixes) {
    const folderResult = await listAll(folderRef);
    const isOrphan     = !validJobIds.has(folderRef.name);
    for (const itemRef of folderResult.items) {
      try {
        const meta = await getMetadata(itemRef);
        totalBytes += meta.size || 0;
      } catch (err) {
        console.warn('[Storage] getMetadata error for', itemRef.fullPath, ':', err.message);
      }
      if (isOrphan) orphanedFileCount++;
    }
  }

  // expenses/ — bytes only (orphan check not in scope for the cleanup tool).
  const expensesPrefix = ref(storage, 'expenses');
  const expensesTop    = await listAll(expensesPrefix);
  for (const folderRef of expensesTop.prefixes) {
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

  return { totalBytes, orphanedFileCount };
}

// ──────────────────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { user, logout } = useAuth();
  const { emailConfig, refreshEmailConfig } = useAppData();
  const [importing,       setImporting]       = useState(false);
  const [buildVersion,    setBuildVersion]    = useState('');
  const [buildInfo,       setBuildInfo]       = useState(null);
  const [buildUsers,      setBuildUsers]      = useState([]);
  const [showSupport,     setShowSupport]     = useState(false);
  const [storageLoading,  setStorageLoading]  = useState(null);
  const [diagLoading,     setDiagLoading]     = useState(false);

  // Orphan-data cleanup state
  const [showOrphanModal, setShowOrphanModal] = useState(false);
  const [orphanScanning,  setOrphanScanning]  = useState(false);
  const [orphanResults,   setOrphanResults]   = useState(null); // { jobs, customers, photos } | null
  const [orphanDeleting,  setOrphanDeleting]  = useState(false);

  const [jobs,      setJobs]      = useState([]);
  const [crews,     setCrews]     = useState([]);
  const [expenses,  setExpenses]  = useState([]);
  const [customers, setCustomers] = useState([]);

  const buildExpiry = useBuildExpiry();

  const [photoStorageBytes,    setPhotoStorageBytes]    = useState(null);
  const [photoStorageLoading,  setPhotoStorageLoading]  = useState(true);
  const [photoStorageError,    setPhotoStorageError]    = useState(false);
  const [summaryLoading,       setSummaryLoading]       = useState(true);
  const [orphanedPhotoCount,   setOrphanedPhotoCount]   = useState(null);

  // Single refresh path used by the mount effect AND by executeOrphanCleanup
  // (post-delete) so the report numbers stay in sync with Firestore + Storage
  // without forcing a navigation roundtrip.
  const refreshSummary = useCallback(async () => {
    setSummaryLoading(true);
    setPhotoStorageLoading(true);
    setPhotoStorageError(false);
    let freshJobs = [];
    let freshCustomers = [];
    let orphanedFileCount = null;
    try {
      let freshCrews, freshExpenses;
      [freshJobs, freshCrews, freshExpenses, freshCustomers] = await Promise.all([
        getJobs(),
        getCrews(),
        getExpenses(),
        getCustomers(),
      ]);
      setJobs(freshJobs);
      setCrews(freshCrews);
      setExpenses(freshExpenses);
      setCustomers(freshCustomers);

      // Storage walk uses the freshly-loaded job ids so the orphan count
      // reflects post-cleanup state.
      const jobIdSet = new Set(freshJobs.map((j) => j.id));
      try {
        const stats = await fetchPhotoStorageStats(jobIdSet);
        setPhotoStorageBytes(stats.totalBytes);
        setOrphanedPhotoCount(stats.orphanedFileCount);
        orphanedFileCount = stats.orphanedFileCount;
      } catch (err) {
        console.error('[Storage] photo stats fetch failed:', err.message);
        setPhotoStorageError(true);
        setPhotoStorageBytes(null);
        setOrphanedPhotoCount(null);
      }
    } catch (err) {
      console.warn('[SettingsScreen] refreshSummary failed:', err.message);
    } finally {
      setSummaryLoading(false);
      setPhotoStorageLoading(false);
    }
    // Return fresh data so callers (executeOrphanCleanup) can verify cleanup
    // without waiting for the React state setters above to flush — those won't
    // settle until the next render, so reading `jobs` / `customers` directly
    // immediately after this would still see stale arrays.
    return { freshJobs, freshCustomers, orphanedFileCount };
  }, []);

  useEffect(() => { refreshSummary(); }, [refreshSummary]);

  // Version shown to the user is this binary's own version + build number, from
  // app.json (baked in at build time) — consistent on every device of the same
  // build. The published build (meta/buildInfo) + user list power the admin view.
  const loadBuildVersion = useCallback(async () => {
    const v  = Constants.expoConfig?.version || '1.0.0';
    const bn = Constants.expoConfig?.ios?.buildNumber || '?';
    setBuildVersion(`Version ${v} (Build ${bn})`);
    try {
      const info = await getBuildInfo();
      setBuildInfo(info);
    } catch (err) {
      console.warn('[settings] loadBuildVersion failed:', err?.message || err);
    }
  }, []);

  useEffect(() => { loadBuildVersion(); }, [loadBuildVersion]);

  // Real-time users listener powers the USER BUILD VERSIONS list. onSnapshot
  // fires immediately with current data, then again the instant buildUpdate.js
  // (App.js launch) writes each user's currentBuildId/currentBuildNumber — so the
  // list updates live with no timer guessing.
  useEffect(() => {
    const unsub = subscribeUsers(setBuildUsers);
    return () => unsub();
  }, []);

  // The latest published build number — anyone on a lower one "Needs Update".
  const publishedBuildNumber = parseInt(buildInfo?.buildNumber, 10) || 0;
  // Only show claimed team members (Scott, Kleodian, Mary) — anonymous-auth
  // shells have no name and would otherwise flood the list with raw UIDs.
  const namedBuildUsers = buildUsers.filter((u) => u.name && String(u.name).trim());
  const updateInstallUrl = buildInfo?.installUrl
    || (buildInfo?.buildId ? `https://expo.dev/accounts/coachward/projects/apollonia/builds/${buildInfo.buildId}` : null);

  // CHANGE 8 — tapping an out-of-date user texts them the install link.
  const nudgeUserToUpdate = useCallback((u) => {
    const phone = String(u?.mobile || u?.phone || '').trim();
    if (!phone) {
      Alert.alert('No phone number', `No phone number on file for ${u?.name || 'this user'}.`);
      return;
    }
    const body = `A new version of Apollonia is available. Install it here: ${updateInstallUrl || ''}`;
    const url  = `sms:${phone}&body=${encodeURIComponent(body)}`;
    Linking.openURL(url).catch((err) =>
      console.warn('[settings] open SMS failed:', err?.message || err),
    );
  }, [updateInstallUrl]);

  // Same criterion as runOrphanScan CHECK 1 — recomputed on every render so
  // the DATA SUMMARY card stays in sync the moment cleanup refreshes `jobs`
  // and `customers`.
  const orphanedJobCount = useMemo(() => {
    const customerNameSet = new Set(
      customers.map((c) => (c.name || '').trim()).filter(Boolean),
    );
    return jobs.filter((j) => {
      const n = (j.billToName || '').trim();
      return n && !customerNameSet.has(n);
    }).length;
  }, [jobs, customers]);

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

  // Clear Activity Log — performs the delete after the user confirms a cutoff.
  // cutoffDate: JS Date (delete entries before it) or null (delete everything).
  const performClearActivityLog = async (cutoffDate) => {
    try {
      setStorageLoading('activityLog');
      const n = await clearActivityLog(cutoffDate);
      setStorageLoading(null);
      Alert.alert('Activity log cleared.', `Removed ${n} ${n === 1 ? 'entry' : 'entries'}.`);
    } catch (err) {
      setStorageLoading(null);
      Alert.alert('Error', err?.message || 'Could not clear the activity log.');
    }
  };

  const confirmClearActivityLog = (cutoffDate) => {
    const message = cutoffDate
      ? `Delete all activity log entries before ${cutoffDate.toLocaleDateString()}? This cannot be undone.`
      : 'Delete ALL activity log entries? This cannot be undone.';
    Alert.alert('Clear Activity Log', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => performClearActivityLog(cutoffDate) },
    ]);
  };

  const handleClearActivityLog = () => {
    const daysAgo = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      d.setHours(0, 0, 0, 0);
      return d;
    };
    Alert.alert(
      'Clear Activity Log',
      'Choose how much history to remove. The selected recent window is kept.',
      [
        { text: 'Last 30 days', onPress: () => confirmClearActivityLog(daysAgo(30)) },
        { text: 'Last 7 days',  onPress: () => confirmClearActivityLog(daysAgo(7)) },
        { text: 'Clear all', style: 'destructive', onPress: () => confirmClearActivityLog(null) },
        { text: 'Cancel', style: 'cancel' },
      ],
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
                  for (const entry of (job.photos || [])) {
                    const url = typeof entry === 'string' ? entry : (entry?.uri || '');
                    if (!url) continue;
                    const path = storagePathFromUrl(url);
                    if (path) await deleteStoragePhoto(path);
                  }
                  await saveJob({ ...job, photos: [], photoCount: 0 });
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
                  for (const entry of (job.photos || [])) {
                    // Photo entries are either legacy bare-URL strings or the
                    // newer { uri, label?, createdAt? } object shape. Normalize
                    // first so `.split` can't be called on an object.
                    const url = typeof entry === 'string' ? entry : (entry?.uri || '');
                    if (!url) continue;
                    // storagePathFromUrl correctly decodes the URL-encoded
                    // Firebase Storage path (`jobs%2F.../...jpg` → `jobs/.../...jpg`).
                    // The old `url.split('/').pop()` returned the encoded full
                    // path and the constructed delete target never matched
                    // anything in Storage.
                    const path = storagePathFromUrl(url);
                    if (path) await deleteStoragePhoto(path);
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
                  for (const entry of (exp.photos || [])) {
                    const url = typeof entry === 'string' ? entry : (entry?.uri || '');
                    if (!url) continue;
                    const path = storagePathFromUrl(url);
                    if (path) await deleteStoragePhoto(path);
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

  // ── Orphan-data cleanup ─────────────────────────────────────────────────────
  //
  // Three independent checks, then a single review modal where the user can
  // commit to deleting everything that was found. Scanning is read-only;
  // nothing is removed until the user taps Delete All and confirms.

  const runOrphanScan = async () => {
    const [jobs, customers] = await Promise.all([getJobs(), getCustomers()]);

    // CHECK 1 — Jobs whose billToName doesn't match any customer in Firestore.
    const customerNameSet = new Set(
      customers.map((c) => (c.name || '').trim()).filter(Boolean),
    );
    const orphanedJobs = jobs
      .filter((j) => {
        const n = (j.billToName || '').trim();
        return n && !customerNameSet.has(n);
      })
      .map((j) => ({
        id:          j.id,
        projectName: j.projectName || 'Untitled',
        targetDate:  j.targetDate || '',
        billToName:  j.billToName || '',
        // Capture photo URLs so the delete pass can clean Storage too.
        photoUrls: (j.photos || [])
          .map((p) => (typeof p === 'string' ? p : (p?.uri || '')))
          .filter(Boolean),
        invoicePdfUrl: j.invoicePdfUrl || '',
      }));

    // CHECK 2 — Customers with no name, OR a name with no jobs referencing
    // them via billToName. Invoices live as fields on the job docs, so the
    // billToName check covers "no invoices for this customer" too.
    const jobBillNameSet = new Set(
      jobs.map((j) => (j.billToName || '').trim()).filter(Boolean),
    );
    const orphanedCustomers = customers
      .filter((c) => {
        const n = (c.name || '').trim();
        if (!n) return true;
        return !jobBillNameSet.has(n);
      })
      .map((c) => ({
        id:      c.id,
        name:    c.name || '',
        email:   c.email || '',
        address: c.address || '',
        phone:   c.phone || '',
      }));

    // CHECK 3 — Storage prefixes under jobs/ that don't have a matching job doc.
    const jobIdSet = new Set(jobs.map((j) => j.id));
    const jobsPrefixRef = ref(storage, 'jobs');
    const topResult = await listAll(jobsPrefixRef);
    const orphanedPhotos = [];
    for (const folderRef of topResult.prefixes) {
      // folderRef.name is the {jobId} segment under jobs/.
      if (jobIdSet.has(folderRef.name)) continue;
      const folderResult = await listAll(folderRef);
      const paths = folderResult.items.map((itemRef) => itemRef.fullPath);
      if (paths.length === 0) continue;
      orphanedPhotos.push({
        jobId:     folderRef.name,
        fileCount: paths.length,
        paths,
      });
    }

    return { jobs: orphanedJobs, customers: orphanedCustomers, photos: orphanedPhotos };
  };

  const handleOrphanCleanup = async () => {
    setStorageLoading('orphans');
    setOrphanResults(null);
    setOrphanScanning(true);
    setShowOrphanModal(true);
    try {
      const results = await runOrphanScan();
      const total = results.jobs.length + results.customers.length + results.photos.length;
      if (total === 0) {
        setShowOrphanModal(false);
        // Re-sync the Data Summary card with the moment-of-scan Firestore
        // snapshot. Without this, a clean scan leaves the Summary's React
        // state showing whatever was loaded on mount, which may be stale.
        try { await refreshSummary(); } catch (refreshErr) {
          console.warn('[OrphanCleanup] refreshSummary after clean scan failed:', refreshErr?.message);
        }
        Alert.alert('All Clean', 'No orphaned data found ✓');
        return;
      }
      setOrphanResults(results);
    } catch (err) {
      setShowOrphanModal(false);
      Alert.alert('Scan Failed', err.message || 'Could not check for orphaned data.');
    } finally {
      setOrphanScanning(false);
      setStorageLoading(null);
    }
  };

  const executeOrphanCleanup = async () => {
    if (!orphanResults) return;
    setOrphanDeleting(true);
    // Track storage delete failures across all three paths. deleteStoragePhoto
    // returns { ok, error? } and never throws — so inspecting the result is
    // the only way to know whether the file actually went away. The Firestore
    // calls (deleteJob / deleteCustomerById) do throw, so they continue to
    // bubble to the outer try/catch.
    let storageFailures = 0;
    const tally = (result) => {
      if (result && result.ok === false) {
        storageFailures++;
        console.warn('[OrphanCleanup] storage delete failed:', result.error);
      }
    };

    try {
      // Orphan jobs: drop their Storage photos first (best-effort), then the doc.
      const jobPromises = orphanResults.jobs.map(async (j) => {
        for (const url of j.photoUrls) {
          const path = storagePathFromUrl(url);
          if (path) tally(await deleteStoragePhoto(path));
        }
        if (j.invoicePdfUrl) {
          const pdfPath = storagePathFromUrl(j.invoicePdfUrl);
          if (pdfPath) tally(await deleteStoragePhoto(pdfPath));
        }
        await deleteJob(j.id);
      });

      // Orphan customers: deleteCustomerById is safe whether the doc has a name or not.
      const customerPromises = orphanResults.customers.map((c) => deleteCustomerById(c.id));

      // Orphan storage prefixes: each path is already known from the scan.
      const photoPromises = orphanResults.photos.flatMap((p) =>
        p.paths.map(async (path) => { tally(await deleteStoragePhoto(path)); }),
      );

      await Promise.all([...jobPromises, ...customerPromises, ...photoPromises]);

      const total =
        orphanResults.jobs.length +
        orphanResults.customers.length +
        orphanResults.photos.length;
      try { logActivity('orphan_cleanup', `Cleaned up ${total} orphaned item(s)${storageFailures > 0 ? `, ${storageFailures} storage failure(s)` : ''}`); } catch {}

      setShowOrphanModal(false);
      setOrphanResults(null);

      // Refresh report numbers so the user sees the post-cleanup state
      // without navigating away. Awaited so the success alert lands on top of
      // the fresh data (otherwise the user may briefly see stale numbers).
      // We also use the returned fresh arrays to verify cleanup — the setJobs
      // / setCustomers state updates inside refreshSummary won't be visible
      // until the next render, so reading the local `jobs` / `customers`
      // variables here would still see pre-cleanup data.
      let postJobs = null;
      let postCustomers = null;
      let postOrphanedPhotos = null;
      try {
        const result = await refreshSummary();
        postJobs           = result?.freshJobs ?? null;
        postCustomers      = result?.freshCustomers ?? null;
        postOrphanedPhotos = result?.orphanedFileCount ?? null;
      } catch (refreshErr) {
        console.warn('[OrphanCleanup] refreshSummary failed:', refreshErr?.message);
      }

      // Compute the orphan counts directly from the fresh data so we can log
      // post-cleanup state for diagnostics. The numbers should all be zero
      // when cleanup succeeded; anything non-zero indicates a delete failure
      // somewhere upstream that the user should know about.
      if (postJobs && postCustomers) {
        const postCustomerNames = new Set(postCustomers.map((c) => (c.name || '').trim()).filter(Boolean));
        const postOrphanedJobs  = postJobs.filter((j) => {
          const n = (j.billToName || '').trim();
          return n && !postCustomerNames.has(n);
        }).length;
        console.log('[OrphanCleanup] post-cleanup orphaned jobs:', postOrphanedJobs);
        console.log('[OrphanCleanup] post-cleanup orphaned photos:', postOrphanedPhotos);
      }

      const baseMsg    = `Deleted ${total} orphaned item${total === 1 ? '' : 's'}.`;
      const failureMsg = storageFailures > 0
        ? ` ${storageFailures} storage file${storageFailures === 1 ? '' : 's'} could not be removed — check Firebase Storage rules.`
        : '';
      Alert.alert('Cleanup Complete', baseMsg + failureMsg);
    } catch (err) {
      Alert.alert('Cleanup Failed', err.message || 'Could not delete orphaned data.');
    } finally {
      setOrphanDeleting(false);
    }
  };

  const confirmOrphanDelete = () => {
    if (!orphanResults) return;
    const total =
      orphanResults.jobs.length +
      orphanResults.customers.length +
      orphanResults.photos.length;
    Alert.alert(
      'Delete All',
      `Permanently delete ${total} orphaned item${total === 1 ? '' : 's'}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: executeOrphanCleanup },
      ],
    );
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

        <Text style={styles.sectionLabel}>USER SETUP</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.settingsRow} onPress={() => navigation.navigate('UserSetup')} activeOpacity={0.7}>
            <View style={styles.settingsRowLeft}>
              <Ionicons name="people-outline" size={20} color={colors.primary} />
              <Text style={styles.settingsRowLabel}>Office Team &amp; Reminders</Text>
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
              <DataRow
                icon="alert-circle-outline"
                label="Orphaned Jobs"
                value={orphanedJobCount}
                tint={orphanedJobCount > 0 ? '#dc2626' : undefined}
                divider
              />
              <DataRow
                icon="image-outline"
                label="Orphaned Photos"
                value={photoStorageLoading ? '…' : (orphanedPhotoCount ?? '—')}
                tint={(orphanedPhotoCount ?? 0) > 0 ? '#dc2626' : undefined}
                divider
              />
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
          <View style={styles.rowDivider} />
          <StorageAction
            icon="trash-bin-outline"
            label="Clean Up Orphaned Data"
            color="#dc2626"
            loading={storageLoading === 'orphans'}
            onPress={handleOrphanCleanup}
          />
          <View style={styles.rowDivider} />
          <StorageAction
            icon="time-outline"
            label="Clear Activity Log"
            color="#d97706"
            loading={storageLoading === 'activityLog'}
            onPress={handleClearActivityLog}
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
          <View style={styles.rowDivider} />
          <BuildInfoRow
            label="Latest Published"
            value={buildInfo
              ? `${buildInfo.version || '?'} (Build ${buildInfo.buildNumber || '?'})`
              : 'None published yet'}
          />
        </View>

        <Text style={styles.sectionLabel}>USER BUILD VERSIONS</Text>
        <View style={styles.card}>
          {namedBuildUsers.length === 0 ? (
            <View style={styles.dataRow}>
              <Text style={styles.dataRowLabel}>No claimed users yet</Text>
            </View>
          ) : (
            namedBuildUsers.map((u, idx) => {
              const userBN = parseInt(u.currentBuildNumber, 10) || 0;
              // With nothing published we can't judge — treat everyone as current.
              const isCurrent = publishedBuildNumber === 0 ? true : userBN >= publishedBuildNumber;
              const buildLabel = userBN > 0
                ? `Version ${u.currentVersion || '—'} (Build ${userBN})`
                : 'No build recorded';
              const name = String(u.name).trim();
              return (
                <View key={u.id || idx}>
                  {idx > 0 ? <View style={styles.rowDivider} /> : null}
                  {/* Tapping anywhere on the row opens the editor (name, mobile,
                      notifications) — same fields as User Setup. The chat icon on
                      out-of-date rows still texts them the install link. */}
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => navigation.navigate('EditUser', { userId: u.id })}
                  >
                    <View style={styles.userBuildRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.userBuildName}>{name}</Text>
                        <Text style={styles.userBuildId}>{buildLabel}</Text>
                      </View>
                      {isCurrent ? (
                        <Text style={[styles.userBuildStatus, { color: colors.primary }]}>
                          ✓ Current
                        </Text>
                      ) : (
                        // Tapping the red badge opens the install link in Safari so
                        // the user can update directly from this row.
                        <TouchableOpacity
                          onPress={() => {
                            if (updateInstallUrl) {
                              Linking.openURL(updateInstallUrl).catch((err) =>
                                console.warn('[settings] open install URL failed:', err?.message || err));
                            } else {
                              Alert.alert('No install link', 'No build install link is available yet.');
                            }
                          }}
                          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                        >
                          <Text style={[styles.userBuildStatus, { color: colors.danger }]}>
                            Needs Update
                          </Text>
                        </TouchableOpacity>
                      )}
                      {!isCurrent ? (
                        <TouchableOpacity
                          onPress={() => nudgeUserToUpdate(u)}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={{ marginLeft: 8 }}
                        >
                          <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.danger} />
                        </TouchableOpacity>
                      ) : (
                        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={{ marginLeft: 8 }} />
                      )}
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })
          )}
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

      {/* Orphan-data review modal */}
      <Modal
        visible={showOrphanModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => { if (!orphanDeleting) setShowOrphanModal(false); }}
      >
        <SafeAreaView style={styles.supportContainer}>
          <View style={styles.supportHeader}>
            <Text style={styles.supportTitle}>Clean Up Orphaned Data</Text>
            <TouchableOpacity
              onPress={() => { if (!orphanDeleting) setShowOrphanModal(false); }}
              style={styles.supportClose}
              disabled={orphanDeleting}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {orphanScanning ? (
            <View style={styles.orphanScanState}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.orphanScanText}>Scanning for orphaned data…</Text>
            </View>
          ) : orphanResults ? (
            <ScrollView contentContainerStyle={styles.supportContent} showsVerticalScrollIndicator={false}>
              {/* Orphaned Jobs */}
              <View style={styles.orphanSectionHeader}>
                <Text style={styles.orphanSectionTitle}>Orphaned Jobs</Text>
                <Text style={styles.orphanSectionCount}>
                  {orphanResults.jobs.length} found
                </Text>
              </View>
              {orphanResults.jobs.length === 0 ? (
                <Text style={styles.orphanEmpty}>None</Text>
              ) : (
                orphanResults.jobs.map((j) => (
                  <View key={'j-' + j.id} style={styles.orphanCard}>
                    <Text style={styles.orphanCardTitle} numberOfLines={1}>{j.projectName}</Text>
                    <Text style={styles.orphanCardMeta} numberOfLines={1}>
                      {j.billToName ? `${j.billToName} · ` : ''}
                      {j.targetDate || 'no date'}
                    </Text>
                  </View>
                ))
              )}

              {/* Orphaned Customers */}
              <View style={[styles.orphanSectionHeader, { marginTop: 18 }]}>
                <Text style={styles.orphanSectionTitle}>Orphaned Customers</Text>
                <Text style={styles.orphanSectionCount}>
                  {orphanResults.customers.length} found
                </Text>
              </View>
              {orphanResults.customers.length === 0 ? (
                <Text style={styles.orphanEmpty}>None</Text>
              ) : (
                orphanResults.customers.map((c) => (
                  <View key={'c-' + c.id} style={styles.orphanCard}>
                    <Text style={styles.orphanCardTitle} numberOfLines={1}>
                      {c.name || '(no name)'}
                    </Text>
                    <Text style={styles.orphanCardMeta} numberOfLines={1}>
                      {[c.email, c.phone, c.address].filter(Boolean).join(' · ') || 'no contact info'}
                    </Text>
                  </View>
                ))
              )}

              {/* Orphaned Photos */}
              <View style={[styles.orphanSectionHeader, { marginTop: 18 }]}>
                <Text style={styles.orphanSectionTitle}>Orphaned Photos</Text>
                <Text style={styles.orphanSectionCount}>
                  {orphanResults.photos.length} found
                </Text>
              </View>
              {orphanResults.photos.length === 0 ? (
                <Text style={styles.orphanEmpty}>None</Text>
              ) : (
                orphanResults.photos.map((p) => (
                  <View key={'p-' + p.jobId} style={styles.orphanCard}>
                    <Text style={styles.orphanCardTitle} numberOfLines={1}>Job {p.jobId}</Text>
                    <Text style={styles.orphanCardMeta} numberOfLines={1}>
                      {p.fileCount} file{p.fileCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                ))
              )}

              <View style={{ height: 24 }} />
            </ScrollView>
          ) : null}

          {orphanResults && !orphanScanning ? (
            <View style={styles.orphanFooter}>
              <TouchableOpacity
                style={[styles.orphanDeleteBtn, orphanDeleting && { opacity: 0.5 }]}
                onPress={confirmOrphanDelete}
                disabled={orphanDeleting}
                activeOpacity={0.85}
              >
                {orphanDeleting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="trash-bin-outline" size={18} color="#fff" />}
                <Text style={styles.orphanDeleteBtnText}>
                  {orphanDeleting ? 'Deleting…' : 'Delete All'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>

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

function DataRow({ icon, label, value, size, divider, onPress, tint }) {
  // `tint` recolors the icon + value when set — used by the orphan rows so a
  // non-zero count visually stands out without changing layout.
  const iconColor  = tint || colors.primary;
  const valueColor = tint ? { color: tint } : null;
  const inner = (
    <View style={styles.dataRow}>
      <View style={styles.dataRowLeft}>
        <Ionicons name={icon} size={16} color={iconColor} />
        <Text style={styles.dataRowLabel}>{label}</Text>
      </View>
      <View style={styles.dataRowRight}>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.dataRowValue, valueColor]}>{value}</Text>
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
  userBuildRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  userBuildName:   { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  userBuildId:     { fontSize: 12, color: colors.textMuted, fontFamily: 'Courier', marginTop: 2 },
  userBuildStatus: { fontSize: 13, fontWeight: '700' },
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

  // Orphan-data cleanup modal
  orphanScanState: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14,
    paddingHorizontal: 32,
  },
  orphanScanText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  orphanSectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  orphanSectionTitle: { fontSize: 13, fontWeight: '800', color: colors.textPrimary, letterSpacing: 0.4 },
  orphanSectionCount: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  orphanEmpty: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', marginBottom: 4 },
  orphanCard: {
    backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 6, borderWidth: 1, borderColor: '#f3f4f6',
  },
  orphanCardTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  orphanCardMeta:  { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  orphanFooter: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  orphanDeleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#dc2626', paddingVertical: 14, borderRadius: 12,
  },
  orphanDeleteBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

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
