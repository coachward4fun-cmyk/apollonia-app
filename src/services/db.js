import { db } from '../config/firebase';
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
  getDocs, writeBatch,
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
  await setDoc(doc(db, 'jobs', job.id), sanitize(job));
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
