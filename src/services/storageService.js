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

/** Job photos — 1200 px wide, JPEG 0.60 */
export function uploadJobPhoto(localUri, jobId, photoId) {
  const path = `jobs/${jobId}/${photoId}.jpg`;
  console.log('[Storage] uploadJobPhoto →', path);
  return compressAndUpload(localUri, path, 1200, 0.60);
}

/** Expense photos — 800 px wide, JPEG 0.55 */
export function uploadExpensePhoto(localUri, expenseId, photoId) {
  const path = `expenses/${expenseId}/${photoId}.jpg`;
  console.log('[Storage] uploadExpensePhoto →', path);
  return compressAndUpload(localUri, path, 800, 0.55);
}

/** Generic upload (used by sendInvoiceEmail) */
export function uploadPhoto(localUri, storagePath) {
  return compressAndUpload(localUri, storagePath, 1200, 0.60);
}

// ── Test helper ────────────────────────────────────────────────────────────────

/**
 * Quick connectivity test — uploads a tiny text file and logs the result.
 * Call this from a dev button to verify Storage is reachable before testing photos.
 */
export async function testStorageConnection() {
  try {
    console.log('[Storage] === testStorageConnection start ===');
    const token = await auth.currentUser?.getIdToken();
    if (!token) { console.error('[Storage] test: not authenticated'); return; }

    const bucket = await detectBucket(token);

    // Write a tiny temp file
    const testFile = FileSystem.cacheDirectory + 'storage_test.txt';
    await FileSystem.writeAsStringAsync(testFile, 'apollonia-storage-test', {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const encodedPath = encodeURIComponent('_test/connection_check.txt');
    const uploadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket}/o` +
      `?uploadType=media&name=${encodedPath}`;

    const result = await FileSystem.uploadAsync(uploadUrl, testFile, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { Authorization: `Firebase ${token}`, 'Content-Type': 'text/plain' },
    });

    console.log('[Storage] test upload status:', result.status);
    console.log('[Storage] test upload body:', result.body);
    FileSystem.deleteAsync(testFile, { idempotent: true }).catch(() => {});
    console.log('[Storage] === testStorageConnection end ===');
  } catch (err) {
    console.error('[Storage] testStorageConnection error:', err.message);
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deleteStoragePhoto(storagePath) {
  try {
    await deleteObject(ref(storage, storagePath));
    console.log('[Storage] deleted', storagePath);
  } catch (err) {
    if (err?.code !== 'storage/object-not-found') {
      console.warn('[Storage] delete error:', err?.code, storagePath);
    }
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
