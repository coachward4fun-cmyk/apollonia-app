import { Alert, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

function showDeniedAlert(title, message) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
}

/**
 * Requests camera permission. Returns true if granted, false otherwise.
 * If denied, shows an alert with an "Open Settings" button.
 */
export async function requestCameraPermission() {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status === 'granted') return true;
  showDeniedAlert(
    'Camera Access Required',
    'Apollonia needs camera access to take job site photos and expense receipts. Please enable it in Settings.'
  );
  return false;
}

/**
 * Requests photo library permission. Returns true if granted, false otherwise.
 * If denied, shows an alert with an "Open Settings" button.
 */
export async function requestPhotoLibraryPermission() {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status === 'granted') return true;
  showDeniedAlert(
    'Photo Library Access Required',
    'Apollonia needs photo library access to attach photos to jobs and expenses. Please enable it in Settings.'
  );
  return false;
}
