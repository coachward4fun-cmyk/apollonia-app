import { Linking, Alert } from 'react-native';

export function normalizePhoneForWhatsApp(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '1' + digits;
  return digits;
}

function formatJobDate(dateStr) {
  if (!dateStr) return 'TBD';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function buildCrewNotifyMessage(job, crew) {
  const date     = formatJobDate(job.targetDate || job.scheduledDate);
  const project  = job.projectName || 'Untitled Job';
  const address  = job.jobLocationAddress || '';
  const customer = job.billToName || '';
  const jobType  = job.jobType || '';
  const notes    = job.notes || '';
  const leadName = crew?.lead?.name || '';

  const mapLink = address
    ? `https://maps.google.com/?q=${encodeURIComponent(address)}`
    : null;

  const lines = [];
  lines.push(`*Apollonia — ${date}*`);
  lines.push(project);
  if (jobType) lines.push(`(${jobType})`);
  lines.push('');
  if (address) {
    lines.push(`📍 ${address}`);
    if (mapLink) lines.push(mapLink);
    lines.push('');
  }
  if (customer) {
    lines.push(`Customer: ${customer}`);
    lines.push('');
  }
  if (notes) {
    lines.push(`📝 Notes: ${notes}`);
    lines.push('');
  }
  if (leadName) {
    lines.push(`NOTIFY ${leadName}`);
  }
  return lines.join('\n');
}

export async function notifyCrewViaWhatsApp(job, crew) {
  if (!crew) {
    Alert.alert('No crew assigned', 'Assign a crew before notifying.');
    return false;
  }
  const leadPhone = normalizePhoneForWhatsApp(crew?.lead?.mobile);
  if (!leadPhone) {
    Alert.alert(
      'No crew lead phone',
      `${crew.name || 'This crew'} has no lead mobile number on file. Add one in the Crew details to use WhatsApp.`
    );
    return false;
  }
  const message = buildCrewNotifyMessage(job, crew);
  const url = `https://wa.me/${leadPhone}?text=${encodeURIComponent(message)}`;
  try {
    // canOpenURL check disabled for Expo Go testing — re-enable for production EAS builds
    // const canOpen = await Linking.canOpenURL(url);
    // if (!canOpen) {
    //   Alert.alert('WhatsApp not installed', 'Install WhatsApp from the App Store to text crew leads from Apollonia.');
    //   return false;
    // }
    await Linking.openURL(url);
    return true;
  } catch (err) {
    console.warn('notifyCrewViaWhatsApp error:', err);
    Alert.alert('Could not open WhatsApp', err.message || 'Unknown error.');
    return false;
  }
}
