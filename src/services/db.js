import { db } from '../config/firebase';
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
  getDocs, getDoc, writeBatch, runTransaction,
  query, where, Timestamp,
} from 'firebase/firestore';

// ── Firestore sanitizer ────────────────────────────────────────────────────────
// Firestore rejects documents containing `undefined` values anywhere in the
// object tree. This strips every key whose value is undefined (but keeps null,
// which Firestore accepts and stores as the null type).

function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, sanitize(v)]),
    );
  }
  return obj;
}

// ── Jobs ───────────────────────────────────────────────────────────────────────

export function subscribeJobs(callback) {
  return onSnapshot(collection(db, 'jobs'), (snap) => {
    console.log('[db] jobs snapshot:', snap.docs.length, 'docs');
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[db] jobs subscription error:', err.code, err.message);
    callback([]);
  });
}

export async function getJobs() {
  const snap = await getDocs(collection(db, 'jobs'));
  console.log('[db] getJobs:', snap.docs.length, 'docs');
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveJob(job) {
  await setDoc(doc(db, 'jobs', job.id), sanitize(job), { merge: true });
}

export async function deleteJob(id) {
  await deleteDoc(doc(db, 'jobs', id));
}

// ── Crews ──────────────────────────────────────────────────────────────────────

export function subscribeCrews(callback) {
  return onSnapshot(collection(db, 'crews'), (snap) => {
    console.log('[db] crews snapshot:', snap.docs.length, 'docs');
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[db] crews subscription error:', err.code, err.message);
    callback([]);
  });
}

export async function getCrews() {
  const snap = await getDocs(collection(db, 'crews'));
  console.log('[db] getCrews:', snap.docs.length, 'docs');
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveCrew(crew) {
  await setDoc(doc(db, 'crews', crew.id), sanitize(crew));
}

export async function deleteCrew(id) {
  await deleteDoc(doc(db, 'crews', id));
}

// ── Expenses ───────────────────────────────────────────────────────────────────

export function subscribeExpenses(callback) {
  return onSnapshot(collection(db, 'expenses'), (snap) => {
    console.log('[db] expenses snapshot:', snap.docs.length, 'docs');
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[db] expenses subscription error:', err.code, err.message);
    callback([]);
  });
}

export async function getExpenses() {
  const snap = await getDocs(collection(db, 'expenses'));
  console.log('[db] getExpenses:', snap.docs.length, 'docs');
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveExpense(expense) {
  await setDoc(doc(db, 'expenses', expense.id), sanitize(expense));
}

export async function deleteExpense(id) {
  await deleteDoc(doc(db, 'expenses', id));
}

// ── Customers ──────────────────────────────────────────────────────────────────

export function subscribeCustomers(callback) {
  return onSnapshot(collection(db, 'customers'), (snap) => {
    console.log('[db] customers snapshot:', snap.docs.length, 'docs');
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[db] customers subscription error:', err.code, err.message);
    callback([]);
  });
}

export async function getCustomers() {
  const snap = await getDocs(collection(db, 'customers'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveCustomer(customer) {
  await setDoc(doc(db, 'customers', customer.id), sanitize(customer));
}

// Look up the customer doc by name. Customers collection is small (one doc per
// customer), so a single full read is fine here.
async function findCustomerDocByName(customerName) {
  const snap = await getDocs(collection(db, 'customers'));
  return snap.docs.find((d) => d.data().name === customerName) || null;
}

export async function archiveCustomer(customerName) {
  const custDoc = await findCustomerDocByName(customerName);
  if (!custDoc) throw new Error('Customer not found');

  // Targeted query — only the jobs that belong to this customer come back.
  const jobsSnap = await getDocs(
    query(collection(db, 'jobs'), where('billToName', '==', customerName)),
  );

  let batch = writeBatch(db);
  let count = 0;
  batch.update(custDoc.ref, { archived: true });
  count++;
  for (const jd of jobsSnap.docs) {
    if (count >= 400) { await batch.commit(); batch = writeBatch(db); count = 0; }
    batch.update(jd.ref, { archivedForCustomer: true });
    count++;
  }
  await batch.commit();
}

// Hard-delete a customer document. Caller (CustomerEditScreen.handleDelete)
// is responsible for verifying there are no active jobs first — this only
// removes the customers/{id} doc, it does NOT touch jobs (intentionally:
// historic invoiced/paid jobs keep their billToName for the record).
export async function deleteCustomer(customerName) {
  const custDoc = await findCustomerDocByName(customerName);
  if (!custDoc) throw new Error('Customer not found');
  await deleteDoc(custDoc.ref);
}

// Hard-delete a customer by document ID — used by the orphan-cleanup flow
// where the document may be nameless or otherwise unreachable by name.
export async function deleteCustomerById(id) {
  await deleteDoc(doc(db, 'customers', id));
}

export async function unarchiveCustomer(customerName) {
  const custDoc = await findCustomerDocByName(customerName);
  if (!custDoc) throw new Error('Customer not found');

  const jobsSnap = await getDocs(
    query(collection(db, 'jobs'), where('billToName', '==', customerName)),
  );

  let batch = writeBatch(db);
  let count = 0;
  batch.update(custDoc.ref, { archived: false });
  count++;
  for (const jd of jobsSnap.docs) {
    // Only flip jobs that were actually archived by this flow.
    if (!jd.data().archivedForCustomer) continue;
    if (count >= 400) { await batch.commit(); batch = writeBatch(db); count = 0; }
    batch.update(jd.ref, { archivedForCustomer: false });
    count++;
  }
  await batch.commit();
}

// ── Bulk import (Settings → import backup) ─────────────────────────────────────

export async function importBackup({ jobs = [], crews = [], expenses = [] }) {
  // Firestore batch limit is 500 ops; chunk if needed
  const chunkSize = 200;

  const [existingJobs, existingCrews, existingExp] = await Promise.all([
    getDocs(collection(db, 'jobs')),
    getDocs(collection(db, 'crews')),
    getDocs(collection(db, 'expenses')),
  ]);

  // Delete existing
  const deleteItems = [
    ...existingJobs.docs,
    ...existingCrews.docs,
    ...existingExp.docs,
  ];
  for (let i = 0; i < deleteItems.length; i += chunkSize) {
    const batch = writeBatch(db);
    deleteItems.slice(i, i + chunkSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // Insert new
  const allWrites = [
    ...jobs.map((j) => ({ ref: doc(db, 'jobs', j.id || generateId()), data: j })),
    ...crews.map((c) => ({ ref: doc(db, 'crews', c.id || generateId()), data: c })),
    ...expenses.map((e) => ({ ref: doc(db, 'expenses', e.id || generateId()), data: e })),
  ];
  for (let i = 0; i < allWrites.length; i += chunkSize) {
    const batch = writeBatch(db);
    allWrites.slice(i, i + chunkSize).forEach(({ ref, data }) => batch.set(ref, sanitize(data)));
    await batch.commit();
  }
}

export async function clearAllData() {
  const [jobs, crews, expenses, customers] = await Promise.all([
    getDocs(collection(db, 'jobs')),
    getDocs(collection(db, 'crews')),
    getDocs(collection(db, 'expenses')),
    getDocs(collection(db, 'customers')),
  ]);

  const all = [...jobs.docs, ...crews.docs, ...expenses.docs, ...customers.docs];
  const chunkSize = 200;
  for (let i = 0; i < all.length; i += chunkSize) {
    const batch = writeBatch(db);
    all.slice(i, i + chunkSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Job ID sequence ────────────────────────────────────────────────────────────

export async function assignJobId() {
  const yy = String(new Date().getFullYear()).slice(2);
  return runTransaction(db, async (tx) => {
    const seqRef = doc(db, 'meta', 'jobIdSequence');
    const snap = await tx.get(seqRef);
    let count;
    if (!snap.exists() || snap.data().year !== yy) {
      count = 1;
    } else {
      count = (snap.data().count || 0) + 1;
    }
    tx.set(seqRef, { year: yy, count });
    return `${yy}-${String(count).padStart(4, '0')}`;
  });
}

export async function backfillJobIds() {
  const snap = await getDocs(collection(db, 'jobs'));
  const missing = snap.docs.filter((d) => !d.data().jobId);
  if (missing.length === 0) return;
  for (const jobDoc of missing) {
    try {
      const newId = await assignJobId();
      await setDoc(jobDoc.ref, { jobId: newId }, { merge: true });
    } catch (err) {
      console.warn('[backfill] Failed to assign jobId:', err.message);
    }
  }
}

// ── App Config — Job Types ─────────────────────────────────────────────────────

export function subscribeJobTypes(callback) {
  return onSnapshot(doc(db, 'appConfig', 'jobTypes'), (snap) => {
    callback(snap.exists() ? (snap.data().types || []) : []);
  }, () => callback([]));
}

export async function getJobTypes() {
  const snap = await getDoc(doc(db, 'appConfig', 'jobTypes'));
  return snap.exists() ? (snap.data().types || []) : [];
}

export async function saveJobType(jobType) {
  const types = await getJobTypes();
  const idx = types.findIndex((t) => t.id === jobType.id);
  const clean = sanitize(jobType);
  if (idx >= 0) types[idx] = clean; else types.push(clean);
  await setDoc(doc(db, 'appConfig', 'jobTypes'), { types });
}

export async function deleteJobType(id) {
  const types = await getJobTypes();
  await setDoc(doc(db, 'appConfig', 'jobTypes'), { types: types.filter((t) => t.id !== id) });
}

// ── Company Profile ────────────────────────────────────────────────────────────

const COMPANY_PROFILE_DEFAULTS = {
  companyName:  '',
  address:      '',
  phone:        '',
  billingEmail: '',
  supportEmail: '',
  tagline:      '',
  logoUrl:      '',
  taxRates: {
    omaha:       7.0, // 5.5% NE state + 1.5% Omaha city
    nebraska:    5.5, // rest of Nebraska
    iowa:        0,
    missouri:    0,
    kansas:      0,
    southDakota: 0,
  },
};

export function subscribeCompanyProfile(callback) {
  return onSnapshot(doc(db, 'meta', 'companyProfile'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    callback({
      ...COMPANY_PROFILE_DEFAULTS,
      ...data,
      taxRates: { ...COMPANY_PROFILE_DEFAULTS.taxRates, ...(data.taxRates || {}) },
    });
  }, (err) => {
    console.error('[db] companyProfile subscription error:', err.code, err.message);
    callback(COMPANY_PROFILE_DEFAULTS);
  });
}

export async function getCompanyProfile() {
  const snap = await getDoc(doc(db, 'meta', 'companyProfile'));
  const data = snap.exists() ? snap.data() : {};
  return {
    ...COMPANY_PROFILE_DEFAULTS,
    ...data,
    taxRates: { ...COMPANY_PROFILE_DEFAULTS.taxRates, ...(data.taxRates || {}) },
  };
}

export async function saveCompanyProfile(updates) {
  await setDoc(doc(db, 'meta', 'companyProfile'), sanitize(updates), { merge: true });
}

// ── Invoice number sequence — yy-mm-NNN, resets each month ─────────────────────

export async function getNextInvoiceNumber(date = new Date()) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yearMonth = `${yy}-${mm}`;
  return runTransaction(db, async (tx) => {
    const seqRef = doc(db, 'meta', 'invoiceCounter');
    const snap = await tx.get(seqRef);
    let count;
    if (!snap.exists() || snap.data().yearMonth !== yearMonth) {
      count = 1;
    } else {
      count = (snap.data().count || 0) + 1;
    }
    tx.set(seqRef, { yearMonth, count });
    return `${yearMonth}-${String(count).padStart(3, '0')}`;
  });
}

// ── Email Config ───────────────────────────────────────────────────────────────

export async function getEmailConfig() {
  const snap = await getDoc(doc(db, 'meta', 'emailConfig'));
  return snap.exists() ? snap.data() : null;
}

export async function saveEmailConfig(updates) {
  await setDoc(doc(db, 'meta', 'emailConfig'), updates, { merge: true });
}

// ── Users ──────────────────────────────────────────────────────────────────────

export function subscribeUsers(callback) {
  return onSnapshot(collection(db, 'users'), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[db] users subscription error:', err.code, err.message);
    callback([]);
  });
}

export async function saveUser(user) {
  await setDoc(doc(db, 'users', user.id), sanitize(user), { merge: true });
}

export async function deleteUser(id) {
  await deleteDoc(doc(db, 'users', id));
}

export async function getUsers() {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getUser(id) {
  const snap = await getDoc(doc(db, 'users', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ── Build info (meta/buildInfo) ──────────────────────────────────────────────
// Tracks the latest published EAS build so the app can prompt out-of-date
// installs to update. Written on launch by the first device running a new build.

export async function getBuildInfo() {
  const snap = await getDoc(doc(db, 'meta', 'buildInfo'));
  return snap.exists() ? snap.data() : null;
}

export async function saveBuildInfo(info) {
  await setDoc(doc(db, 'meta', 'buildInfo'), sanitize(info), { merge: true });
}

// ── Activity log maintenance ─────────────────────────────────────────────────
// Deletes activityLog docs older than cutoffDate (a JS Date). Pass null to wipe
// the whole collection. Commits in chunks of 450 to stay under Firestore's
// 500-write batch limit. Returns the number of docs deleted.

export async function clearActivityLog(cutoffDate = null) {
  const colRef = collection(db, 'activityLog');
  const snap = cutoffDate
    ? await getDocs(query(colRef, where('timestamp', '<', Timestamp.fromDate(cutoffDate))))
    : await getDocs(colRef);

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}
