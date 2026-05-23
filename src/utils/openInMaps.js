import { Linking } from 'react-native';

export async function openInMaps(address) {
  if (!address) return;
  const encoded = encodeURIComponent(address);
  try {
    await Linking.openURL(`comgooglemaps://?q=${encoded}&zoom=15`);
    return;
  } catch {
    // Google Maps not installed — fall back to Apple Maps
  }
  Linking.openURL(`maps://maps.apple.com/?q=${encoded}`)
    .catch(() => Linking.openURL(`https://maps.apple.com/?q=${encoded}`));
}
