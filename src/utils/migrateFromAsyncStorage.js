import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from '../config/firebase';
import { collection, getDocs, doc, writeBatch } from 'firebase/firestore';

const MIGRATION_FLAG = 'apollonia:migrated_to_firestore_v1';
const CHUNK = 200;

async function readJSON(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function collectionSize(name) {
  const snap = await getDocs(collection(db, name));
  return snap.size;
}

async function batchWrite(collectionName, items) {
  const valid = items.filter((item) => item && item.id);
  for (let i = 0; i < valid.length; i += CHUNK) {
    const batch = writeBatch(db);
    valid.slice(i, i + CHUNK).forEach((item) => {
      batch.set(doc(db, collectionName, item.id), item);
    });
    await batch.commit();
  }
}

/**
 * Returns true if there is AsyncStorage data that hasn't been migrated yet.
 * Fast path: returns false immediately if the migration flag is already set.
 */
export async function isMigrationNeeded() {
  const done = await AsyncStorage.getItem(MIGRATION_FLAG);
  if (done === 'true') return false;

  const [jobs, crews, expenses] = await Promise.all([
    readJSON('apollonia:jobs_v1'),
    readJSON('apollonia:crews_v1'),
    readJSON('apollonia:expenses_v1'),
  ]);

  const hasLocalData = jobs.length > 0 || crews.length > 0 || expenses.length > 0;

  if (!hasLocalData) {
    // Nothing to migrate — mark done so we never check again
    await AsyncStorage.setItem(MIGRATION_FLAG, 'true');
    return false;
  }

  return true;
}

/**
 * Reads all data from AsyncStorage and writes it to Firestore.
 * Skips writing to any collection that already has Firestore documents
 * so it is safe to call even if a partial migration happened before.
 * Marks the migration flag when complete.
 *
 * @param {(message: string) => void} onProgress  Optional progress callback
 */
export async function runMigration(onProgress) {
  const report = (msg) => { onProgress?.(msg); };

  report('Reading local data…');
  const [jobs, crews, expenses] = await Promise.all([
    readJSON('apollonia:jobs_v1'),
    readJSON('apollonia:crews_v1'),
    readJSON('apollonia:expenses_v1'),
  ]);

  report('Checking cloud…');
  const [jobCount, crewCount, expCount] = await Promise.all([
    collectionSize('jobs'),
    collectionSize('crews'),
    collectionSize('expenses'),
  ]);

  if (jobs.length > 0 && jobCount === 0) {
    report(`Uploading ${jobs.length} job${jobs.length !== 1 ? 's' : ''}…`);
    await batchWrite('jobs', jobs);
  }

  if (crews.length > 0 && crewCount === 0) {
    report(`Uploading ${crews.length} crew${crews.length !== 1 ? 's' : ''}…`);
    await batchWrite('crews', crews);
  }

  if (expenses.length > 0 && expCount === 0) {
    report(`Uploading ${expenses.length} expense${expenses.length !== 1 ? 's' : ''}…`);
    await batchWrite('expenses', expenses);
  }

  await AsyncStorage.setItem(MIGRATION_FLAG, 'true');
  report('Done!');
}
