/**
 * Ensures Firestore has data on first launch.
 * Fast path: if the jobs collection is non-empty, returns null immediately.
 * Otherwise uploads from AsyncStorage (if present) or the embedded backup.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from '../config/firebase';
import { collection, doc, getDoc, setDoc, getDocs, query, limit, writeBatch } from 'firebase/firestore';

const CHUNK = 200;

// ── Embedded backup — apollonia-backup-2026-05-04.json ────────────────────────

const BACKUP_JOBS = [
  {
    id: 'monjivm6hj0f',
    status: 'Invoice Ready',
    jobType: 'Roofing',
    billToName: 'Sam Ward',
    billToAddress: '123 Apple Ave, Omaha NE 68135',
    email: 'scott.ward.omaha@gmail.com',
    salesperson: 'Henry Nazeraj',
    jobLocationAddress: '205 Apple Ave, Ames, IA 50010',
    projectName: 'Replace roof and add gutter guards',
    targetDate: '2026-05-02',
    lastUpdate: '2026-05-03',
    invoiceNumber: 'ABC123',
    crewId: 'monkz1oufrgu',
    invoiceDate: '2026-05-03',
    dueDate: '2026-06-02',
    invoiceTotal: 4674.83,
    lineItems: [
      { description: 'Install new shingles (Squares)', qty: 40, unitPrice: 80 },
      { description: 'Remove all shingles down to deck', qty: 1, unitPrice: 0 },
      { description: 'Remove extra layer of shingles', qty: 40, unitPrice: 15 },
      { description: 'Replace plywood', qty: 0, unitPrice: 15 },
      { description: 'Remove extra layer of papers', qty: 0, unitPrice: 5 },
      { description: 'Install new gutter aprons', qty: 1, unitPrice: 0 },
      { description: 'Install new drip edge', qty: 5, unitPrice: 20 },
      { description: 'Install two rows ice and water', qty: 1, unitPrice: 0 },
      { description: 'Install new valley', qty: 1, unitPrice: 0 },
      { description: 'Install synthetic paper', qty: 1, unitPrice: 0 },
      { description: 'Dump Fee Total Cost', qty: 1, unitPrice: 469 },
      { description: 'Destination Fee', qty: 1, unitPrice: 0 },
      { description: 'Clean up and haul away all debris', qty: 1, unitPrice: 0 },
    ],
  },
  {
    id: 'monofpvbexk8',
    status: 'Invoice Ready',
    jobType: 'Roofing',
    billToName: 'Henerys Construction',
    billToAddress: '555 Pear Street, Council Bluffs, IA 58123',
    email: 'scott.ward.omaha@gmail.com',
    salesperson: 'Mary',
    jobLocationAddress: '555 Pear Street, Council Bluffs, IA 58123',
    projectName: 'Full Roof Replacement',
    targetDate: '2026-05-01',
    crewId: 'monl1w26e7k4',
    lastUpdate: '2026-05-02',
    invoiceNumber: '231',
    invoiceDate: '2026-05-02',
    dueDate: '2026-06-01',
    invoiceTotal: 3497.83,
    durationDays: '2',
    lineItems: [
      { description: 'Remove all shingles down to deck', qty: 1, unitPrice: 0 },
      { description: 'Remove extra layer of shingles', qty: 0, unitPrice: 15 },
      { description: 'Replace plywood', qty: 0, unitPrice: 15 },
      { description: 'Remove extra layer of papers', qty: 0, unitPrice: 5 },
      { description: 'Install new gutter aprons', qty: 1, unitPrice: 0 },
      { description: 'Install new drip edge', qty: 1, unitPrice: 0 },
      { description: 'Install two rows ice and water', qty: 1, unitPrice: 0 },
      { description: 'Install new valley', qty: 1, unitPrice: 0 },
      { description: 'Install synthetic paper', qty: 1, unitPrice: 0 },
      { description: 'Install new shingles (Squares)', qty: 35, unitPrice: 80 },
      { description: 'Dump Fee Total Cost', qty: 1, unitPrice: 469 },
      { description: 'Destination Fee', qty: 1, unitPrice: 0 },
      { description: 'Clean up and haul away all debris', qty: 1, unitPrice: 0 },
    ],
  },
  {
    id: 'monolg0xbk2s',
    status: 'Invoice Ready',
    jobType: 'Roofing',
    billToName: 'Toto Roofing Company',
    billToAddress: '54321 Clam Ave, Omaha, NE 68131',
    email: 'scott.ward.omaha@gmail.com',
    salesperson: 'John',
    jobLocationAddress: '5918 S 175th Cir, Omaha, NE  68135',
    projectName: 'Repair Leak - North side',
    targetDate: '2026-05-04',
    crewId: 'monkz1oufrgu',
    lastUpdate: '2026-05-03',
    invoiceNumber: '26122-001',
    invoiceDate: '2026-05-02',
    dueDate: '2026-06-01',
    invoiceTotal: 4648.08,
    lineItems: [
      { description: 'Remove all shingles down to deck', qty: 0, unitPrice: 90 },
      { description: 'Remove extra layer of shingles', qty: 40, unitPrice: 15 },
      { description: 'Replace plywood', qty: 5, unitPrice: 15 },
      { description: 'Remove extra layer of papers', qty: 0, unitPrice: 5 },
      { description: 'Install new gutter aprons', qty: 1, unitPrice: 0 },
      { description: 'Install new drip edge', qty: 1, unitPrice: 0 },
      { description: 'Install two rows ice and water', qty: 1, unitPrice: 0 },
      { description: 'Install new valley', qty: 1, unitPrice: 0 },
      { description: 'Install synthetic paper', qty: 1, unitPrice: 0 },
      { description: 'Install new shingles (Squares)', qty: 40, unitPrice: 80 },
      { description: 'Dump Fee Total Cost', qty: 1, unitPrice: 469 },
      { description: 'Destination Fee', qty: 1, unitPrice: 0 },
      { description: 'Clean up and haul away all debris', qty: 1, unitPrice: 0 },
    ],
  },
  {
    id: 'mop26mp24b35',
    status: 'Scheduled',
    jobType: 'Roofing',
    billToName: 'Royalty Roofing',
    billToAddress: '5918 S 175th Circle, Omaha NE 68135',
    email: 'coachward4fun@gmail.com',
    salesperson: 'Lenny',
    jobLocationAddress: '5918 S 175th Circle, Omaha NE 68135',
    projectName: "Marys House",
    targetDate: '2026-05-01',
    crewId: 'monkz1oufrgu',
    durationDays: '1',
    invoiceNumber: '26122-002',
    lastUpdate: '2026-05-03',
    crewCostHelpers: '2',
  },
];

const BACKUP_CREWS = [
  {
    id: 'monkz1oufrgu',
    name: 'Crew 1 - Bob',
    lead: { name: 'Bob Smith', mobile: '531-222-6245', comment: '', email: 'coachward4fun@gmail.com' },
    members: [
      { name: 'Tim',   mobile: '', comment: '' },
      { name: 'Mark',  mobile: '', comment: '' },
      { name: 'Mike',  mobile: '', comment: '' },
      { name: 'Danny', mobile: '', comment: '' },
    ],
  },
  {
    id: 'monl1w26e7k4',
    name: 'Crew 2 - Frank',
    lead: { name: 'Frank Drumand', mobile: '402-312-3535', comment: 'Not Weekends' },
    members: [
      { name: 'Tommy', mobile: '', comment: '' },
      { name: 'Scott', mobile: '', comment: '' },
      { name: 'Billy', mobile: '', comment: '' },
      { name: 'Pushka', mobile: '', comment: '' },
    ],
  },
];

const BACKUP_EXPENSES = [
  {
    id: 'mop24ro3ateh',
    type: 'job',
    date: '2026-05-02',
    amount: 1200,
    description: 'Crew Cost — Replace roof and add gutter guards',
    createdAt: '2026-05-03',
    jobId: 'monjivm6hj0f',
    jobName: 'Replace roof and add gutter guards',
    addToInvoice: false,
    category: 'Subcontractors & Labor',
    isCrewCost: true,
  },
  {
    id: 'mop0i13uf7m9',
    type: 'job',
    date: '2026-05-04',
    amount: 1200,
    description: 'Crew Cost — Repair Leak - North side',
    createdAt: '2026-05-03',
    jobId: 'monolg0xbk2s',
    jobName: 'Repair Leak - North side',
    addToInvoice: false,
    category: 'Subcontractors & Labor',
    isCrewCost: true,
  },
  {
    id: 'monp86g01i1d',
    type: 'company',
    date: '2026-05-01',
    amount: 75,
    description: 'Tires for Trailer',
    createdAt: '2026-05-02',
    category: 'Fuel & Transportation',
  },
  {
    id: 'mono1ypz786n',
    type: 'job',
    date: '2026-05-02',
    amount: 250,
    description: 'Dump Fee',
    createdAt: '2026-05-02',
    jobId: 'monjivm6hj0f',
    jobName: 'Replace roof and add gutter guards',
    addToInvoice: true,
  },
  {
    id: 'mono18hkp9dw',
    type: 'company',
    date: '2026-05-02',
    amount: 35.99,
    description: 'Crew1 Water',
    createdAt: '2026-05-02',
    category: 'Meals & Entertainment',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readASJSON(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function batchWriteAll(collectionName, items) {
  const valid = items.filter((item) => item?.id);
  for (let i = 0; i < valid.length; i += CHUNK) {
    const batch = writeBatch(db);
    valid.slice(i, i + CHUNK).forEach((item) =>
      batch.set(doc(db, collectionName, item.id), item),
    );
    await batch.commit();
  }
  return valid.length;
}

// ── Meta document: build expiry ───────────────────────────────────────────────

async function ensureBuildExpiryDoc() {
  try {
    const ref  = doc(db, 'meta', 'buildExpiry');
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        expiryDate: '2026-08-04',
        buildDate:  '2026-05-06',
        updatedBy:  'Scott Ward',
      });
      console.log('[Seed] meta/buildExpiry created');
    }
  } catch (err) {
    // Non-fatal — Settings will show "Loading…" if this fails
    console.warn('[Seed] meta/buildExpiry error:', err.message);
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Call on every login. Fast path: if jobs collection is non-empty, returns null.
 * Otherwise seeds Firestore from AsyncStorage (preferred) or embedded backup.
 *
 * Returns { jobs, crews, expenses, source } when data was written, or null if
 * Firestore already had data.
 */
export async function ensureFirestoreData(onProgress) {
  // Always ensure the build-expiry meta doc exists (independent of jobs data)
  ensureBuildExpiryDoc();

  onProgress?.('Checking cloud data…');
  const check = await getDocs(query(collection(db, 'jobs'), limit(1)));
  if (!check.empty) return null; // already populated — done

  onProgress?.('Reading local data…');
  const [asJobs, asCrews, asExpenses] = await Promise.all([
    readASJSON('apollonia:jobs_v1'),
    readASJSON('apollonia:crews_v1'),
    readASJSON('apollonia:expenses_v1'),
  ]);

  const hasAS   = asJobs.length > 0 || asCrews.length > 0 || asExpenses.length > 0;
  const jobs     = hasAS ? asJobs     : BACKUP_JOBS;
  const crews    = hasAS ? asCrews    : BACKUP_CREWS;
  const expenses = hasAS ? asExpenses : BACKUP_EXPENSES;
  const source   = hasAS ? 'local storage' : 'backup file';

  if (jobs.length > 0) {
    onProgress?.(`Uploading ${jobs.length} job${jobs.length !== 1 ? 's' : ''}…`);
    await batchWriteAll('jobs', jobs);
  }
  if (crews.length > 0) {
    onProgress?.(`Uploading ${crews.length} crew${crews.length !== 1 ? 's' : ''}…`);
    await batchWriteAll('crews', crews);
  }
  if (expenses.length > 0) {
    onProgress?.(`Uploading ${expenses.length} expense${expenses.length !== 1 ? 's' : ''}…`);
    await batchWriteAll('expenses', expenses);
  }

  console.log(`[Seed] Wrote ${jobs.length} jobs, ${crews.length} crews, ${expenses.length} expenses from ${source}`);
  return { jobs: jobs.length, crews: crews.length, expenses: expenses.length, source };
}
