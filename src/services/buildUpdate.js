import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Alert, Linking } from 'react-native';
import { getBuildInfo, saveUser } from './db';

// Last EAS build id this device has acknowledged. Lets us show the "up to date"
// confirmation exactly once, right after the user installs a newer build.
const LAST_SEEN_KEY = 'lastSeenBuildId';

const EXPO_ACCOUNT = 'coachward';
const EXPO_PROJECT = 'apollonia';

// What THIS binary reports about itself — baked in at build time via app.json.
function deviceVersion() {
  return Constants.expoConfig?.version || '';
}
function deviceBuildNumber() {
  const n = parseInt(Constants.expoConfig?.ios?.buildNumber ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

function installUrlFor(info) {
  if (info?.installUrl) return info.installUrl;
  if (info?.buildId) return `https://expo.dev/accounts/${EXPO_ACCOUNT}/projects/${EXPO_PROJECT}/builds/${info.buildId}`;
  return null;
}

// Runs once per launch, after auth completes. The "latest published build" lives
// in Firestore meta/buildInfo, written by scripts/updateBuildExpiry.js when Scott
// registers a build. We compare it against what this binary reports:
//   • Firestore buildNumber > this binary's  → out of date → prompt to update
//   • otherwise, if the published buildId is one we haven't seen on this device
//     (the user just updated) → confirm "You're up to date! ✓"
// Also records this device's build on the user doc for the Admin page list.
export async function runBuildUpdateCheck(user) {
  if (!user?.uid) return;

  const localVersion     = deviceVersion();
  const localBuildNumber = deviceBuildNumber();

  let info = null;
  try {
    info = await getBuildInfo();
  } catch (err) {
    console.warn('[buildUpdate] getBuildInfo failed:', err?.message || err);
  }

  const firebaseBuildNumber = parseInt(info?.buildNumber, 10) || 0;
  // When this device is on (or ahead of) the published build, its buildId IS the
  // published one — record it so the Admin page can show each member's build id.
  const onCurrentBuild = firebaseBuildNumber === 0 ? true : localBuildNumber >= firebaseBuildNumber;

  // Record what build this device is running (for the Admin per-user list).
  // currentBuildId is left undefined when out of date (we don't know the old
  // build's id) — sanitize+merge then preserves any previously-stored value.
  try {
    await saveUser({
      id:                 user.uid,
      currentVersion:     localVersion,
      currentBuildNumber: localBuildNumber,
      currentBuildId:     onCurrentBuild ? (info?.buildId || undefined) : undefined,
      updatedAt:          new Date().toISOString(),
    });
  } catch (err) {
    console.error('[BuildUpdate] failed to write currentBuildId:', err);
  }

  // ── Propagate to the user's claimed named doc after a reinstall ─────────────
  // A delete + reinstall mints a fresh anonymous-auth UID, so the self-write
  // above lands on a brand-new doc while the user's *named* doc (claimed via
  // SelfClaimModal) keeps its old UID and goes stale on the Admin build list.
  // SelfClaimModal stores the claimed doc's UID under 'namedUserDocId'; if that
  // differs from the current UID, mirror the build fields onto it too. saveUser
  // merges, so the named doc's other fields (name, mobile, …) are preserved, and
  // currentBuildId is only set when on the current build (we don't know an older
  // build's id) — sanitize+merge then keeps any previously-stored value.
  try {
    const namedUserDocId = await AsyncStorage.getItem('namedUserDocId');
    if (namedUserDocId && namedUserDocId !== user.uid) {
      await saveUser({
        id:                 namedUserDocId,
        currentVersion:     localVersion,
        currentBuildNumber: localBuildNumber,
        currentBuildId:     onCurrentBuild ? (info?.buildId || undefined) : undefined,
        updatedAt:          new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn('[buildUpdate] named-doc propagation failed:', err?.message || err);
  }

  if (!info) return; // nothing published yet

  // Out of date: Firestore advertises a newer build than this binary. This fires
  // on EVERY launch while the device is behind — there is no once-per-day gate.
  // The prompt is a REQUIRED update: a single "Update Now" button, non-dismissable
  // (no "Later", cancelable: false), so the user must tap through to the install.
  if (firebaseBuildNumber > localBuildNumber) {
    const installUrl = installUrlFor(info);
    if (installUrl) {
      Alert.alert(
        'Update Required',
        'A new version of Apollonia is required. Tap Update Now to install the latest build.',
        [
          {
            text: 'Update Now',
            onPress: () => Linking.openURL(installUrl).catch((e) =>
              console.warn('[buildUpdate] open install URL failed:', e?.message || e)),
          },
        ],
        { cancelable: false },
      );
    }
    return; // don't mark as seen — this device hasn't actually updated yet
  }

  // Current. If the published buildId differs from what we last acknowledged on
  // this device, the user just landed on this build — confirm once and remember.
  if (info.buildId) {
    const lastSeen = await AsyncStorage.getItem(LAST_SEEN_KEY).catch(() => null);
    if (info.buildId !== lastSeen) {
      await AsyncStorage.setItem(LAST_SEEN_KEY, info.buildId).catch(() => {});
      Alert.alert('Apollonia', "You're up to date! ✓");
    }
  }
}
