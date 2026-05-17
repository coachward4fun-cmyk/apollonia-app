import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { storage, auth } from '../config/firebase';
import { ref, deleteObject } from 'firebase/storage';

// ── Bucket detection ───────────────────────────────────────────────────────────
// Firebase Storage buckets can be either:
//   <project>.firebasestorage.app  (new projects)
//   <project>.appspot.com          (older projects)
// We ping both and use whichever responds.

const PROJECT_ID = 'apollonia-construction';
const BUCKET_NEW = `${PROJECT_ID}.firebasestorage.app`;
const BUCKET_OLD = `${PROJECT_ID}.appspot.com`;

let resolvedBucket = null; // cached after first successful detection

async function detectBucket(token) {
  // Use what's in the SDK config first — it should be authoritative
  const sdkBucket = storage.app.options.storageBucket;
  if (sdkBucket) {
    console.log('[Storage] SDK bucket:', sdkBucket);
  }

  for (const bucket of [sdkBucket, BUCKET_NEW, BUCKET_OLD].filter(Boolean)) {
    if (bucket === resolvedBucket) return resolvedBucket; // already confirmed
    const testUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?maxResults=1`;
    try {
      const res = await FileSystem.downloadAsync(testUrl, FileSystem.cacheDirectory + '_bucket_probe_', {
        headers: { Authorization: `Firebase ${token}` },
      });
      console.log(`[Storage] bucket probe "${bucket}" → HTTP ${res.status}`);
      // 200 = bucket exists and accessible; 404 = bucket not found; 403 = exists but permission denied
      if (res.status === 200 || res.status === 403) {
        resolvedBucket = bucket;
        console.log('[Storage] using bucket:', resolvedBucket);
        FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {});
        return resolvedBucket;
      }
      FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {});
    } catch (e) {
      console.warn(`[Storage] bucket probe error for "${bucket}":`, e.message);
    }
  }
  throw new Error(
    `Firebase Storage bucket not found. Tried: ${[sdkBucket, BUCKET_NEW, BUCKET_OLD].join(', ')}.\n` +
    'Go to Firebase Console → Build → Storage → Get Started to enable Storage.'
  );
}

// ── Compress → upload via REST (avoids React Native Blob limitation) ───────────

async function compressAndUpload(localUri, storagePath, resizeWidth, quality) {
  let compressedUri = null;
  try {
    // Step 1: Compress
    const result = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: resizeWidth } }],
      { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
    );
    compressedUri = result.uri;
    console.log('[Storage] compressed →', compressedUri);

    // Step 2: Auth token
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Not authenticated — cannot upload');

    // Step 3: Detect which bucket is live
    const bucket = await detectBucket(token);

    // Step 4: Upload via REST (no Blob/ArrayBuffer)
    const encodedPath = encodeURIComponent(storagePath);
    const uploadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket}/o` +
      `?uploadType=media&name=${encodedPath}`;

    console.log('[Storage] uploading to:', uploadUrl);

    const uploadResult = await FileSystem.uploadAsync(uploadUrl, compressedUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Firebase ${token}`,
        'Content-Type': 'image/jpeg',
      },
    });

    console.log('[Storage] upload HTTP status:', uploadResult.status);
    console.log('[Storage] upload response body:', uploadResult.body);

    if (uploadResult.status !== 200) {
      throw new Error(
        `Upload failed — HTTP ${uploadResult.status}\n` +
        `URL: ${uploadUrl}\n` +
        `Response: ${uploadResult.body}`
      );
    }

    // Step 5: Build download URL from REST response
    const responseData = JSON.parse(uploadResult.body);
    const downloadToken = responseData.downloadTokens;
    const downloadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}` +
      `?alt=media&token=${downloadToken}`;
    console.log('[Storage] download URL:', downloadUrl);
    return downloadUrl;
  } finally {
    if (compressedUri) {
      FileSystem.deleteAsync(compressedUri, { idempotent: true }).catch(() => {});
    }
  }
}

// ── Public upload helpers ──────────────────────────────────────────────────────

/** Job photos — 1200 px wide, JPEG 0.60, targets < 150 KB */
export function uploadJobPhoto(localUri, jobId, photoId) {
  const path = `jobs/${jobId}/${photoId}.jpg`;
  console.log('[Storage] uploadJobPhoto →', path);
  return compressAndUpload(localUri, path, 1200, 0.60);
}

/** Expense photos — 800 px wide, JPEG 0.55, targets < 150 KB */
export function uploadExpensePhoto(localUri, expenseId, photoId) {
  const path = `expenses/${expenseId}/${photoId}.jpg`;
  console.log('[Storage] uploadExpensePhoto →', path);
  return compressAndUpload(localUri, path, 800, 0.55);
}

/** Generic upload (used by sendInvoiceEmail) */
export function uploadPhoto(localUri, storagePath) {
  return compressAndUpload(localUri, storagePath, 1200, 0.60);
}

/** Company logo — 600 px wide, JPEG 0.85, cache-busted by timestamp so URL changes on re-upload */
export function uploadCompanyLogo(localUri) {
  const path = `company/logo_${Date.now()}.jpg`;
  console.log('[Storage] uploadCompanyLogo →', path);
  return compressAndUpload(localUri, path, 600, 0.85);
}

// ── Test helper ────────────────────────────────────────────────────────────────

/**
 * Runs a connectivity test against Firebase Storage and returns a structured
 * result object — all results are returned to the caller, nothing logged-only.
 *
 * Returns:
 *   { authenticated, email, bucket, readOk, readError,
 *     writeOk, writeError, overallOk, failReason }
 */
export async function testStorageConnection() {
  const result = {
    authenticated: false,
    email: null,
    bucket: null,
    readOk: false,
    readError: null,
    writeOk: false,
    writeError: null,
    overallOk: false,
    failReason: null,
  };

  // 1. Auth check
  const user = auth.currentUser;
  if (!user) {
    result.failReason = 'Not authenticated';
    return result;
  }
  result.authenticated = true;
  result.email = user.email;

  let token;
  try {
    token = await user.getIdToken();
  } catch (err) {
    result.authenticated = false;
    result.failReason = 'Could not get auth token: ' + err.message;
    return result;
  }

  // 2. Bucket detection
  try {
    result.bucket = await detectBucket(token);
  } catch (err) {
    result.failReason = err.message;
    return result;
  }

  // 3. Read test — list up to 1 object
  try {
    const listUrl = `https://firebasestorage.googleapis.com/v0/b/${result.bucket}/o?maxResults=1`;
    const res = await fetch(listUrl, { headers: { Authorization: `Firebase ${token}` } });
    if (res.ok) {
      result.readOk = true;
    } else {
      result.readError = `HTTP ${res.status}`;
    }
  } catch (err) {
    result.readError = err.message;
  }

  // 4. Write test — upload a tiny sentinel file
  const testFile = FileSystem.cacheDirectory + 'storage_test.txt';
  try {
    await FileSystem.writeAsStringAsync(testFile, 'apollonia-storage-test', {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const encodedPath = encodeURIComponent('_test/connection_check.txt');
    const uploadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${result.bucket}/o` +
      `?uploadType=media&name=${encodedPath}`;

    const uploadResult = await FileSystem.uploadAsync(uploadUrl, testFile, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { Authorization: `Firebase ${token}`, 'Content-Type': 'text/plain' },
    });

    if (uploadResult.status === 200) {
      result.writeOk = true;
    } else {
      result.writeError = `HTTP ${uploadResult.status}`;
    }
  } catch (err) {
    result.writeError = err.message;
  } finally {
    FileSystem.deleteAsync(testFile, { idempotent: true }).catch(() => {});
  }

  // 5. Overall verdict
  result.overallOk = result.readOk && result.writeOk;
  if (!result.overallOk && !result.failReason) {
    const reasons = [];
    if (!result.readOk)  reasons.push('read failed');
    if (!result.writeOk) reasons.push('write failed');
    result.failReason = reasons.join(', ');
  }

  return result;
}

// ── Delete ─────────────────────────────────────────────────────────────────────

// Returns { ok, error?: string }. `storage/object-not-found` is treated as
// success (the file is already gone). Real failures return { ok: false, error }
// so callers can surface them — existing callers that ignore the return value
// still work unchanged.
export async function deleteStoragePhoto(storagePath) {
  try {
    await deleteObject(ref(storage, storagePath));
    console.log('[Storage] deleted', storagePath);
    return { ok: true };
  } catch (err) {
    if (err?.code === 'storage/object-not-found') {
      return { ok: true };
    }
    console.warn('[Storage] delete error:', err?.code, storagePath);
    return { ok: false, error: err?.message || err?.code || 'unknown error' };
  }
}

// ── Path helpers ───────────────────────────────────────────────────────────────

export function jobPhotoPath(jobId, filename) {
  return `jobs/${jobId}/${filename}`;
}

export function expensePhotoPath(expenseId, filename) {
  return `expenses/${expenseId}/${filename}`;
}

export function storagePathFromUrl(url) {
  try {
    const m = url.match(/\/o\/([^?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}
