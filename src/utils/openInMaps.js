import { Linking } from 'react-native';
export async function openInMaps(address) {
  const encoded = encodeURIComponent(address);
  Linking.openURL(`maps://maps.apple.com/?q=${encoded}`).catch(() =>
    Linking.openURL(`https://maps.apple.com/?q=${encoded}`).catch(() => {})
  );
}
