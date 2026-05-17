import { getFirestore, doc, getDoc } from 'firebase/firestore';

let cachedTwilioConfig = null;

export async function getTwilioConfig() {
  if (cachedTwilioConfig) return cachedTwilioConfig;
  try {
    const db = getFirestore();
    const snap = await getDoc(doc(db, 'meta', 'twilioConfig'));
    if (snap.exists()) {
      cachedTwilioConfig = snap.data();
      return cachedTwilioConfig;
    }
    return null;
  } catch (e) {
    console.error('Failed to load Twilio config:', e);
    return null;
  }
}

export function invalidateSMSConfig() {
  cachedTwilioConfig = null;
}

export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return null;
}

export async function sendSMS(toPhone, message) {
  try {
    const config = await getTwilioConfig();
    if (!config || !config.accountSid || !config.authToken || !config.fromNumber) {
      console.error('SMS: Twilio config missing or incomplete', config);
      return { success: false, error: 'Twilio config missing' };
    }

    const toFormatted = normalizePhone(toPhone);
    if (!toFormatted) {
      console.error('SMS: Invalid phone number:', toPhone);
      return { success: false, error: `Invalid phone number: ${toPhone}` };
    }

    const fromFormatted = normalizePhone(config.fromNumber);

    console.log('SMS: Sending to:', toFormatted, 'from:', fromFormatted);
    console.log('SMS: Message:', message);

    const credentials = btoa(`${config.accountSid}:${config.authToken}`);
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

    const params = new URLSearchParams();
    params.append('To', toFormatted);
    params.append('From', fromFormatted);
    params.append('Body', message);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const responseText = await response.text();
    console.log('SMS: Twilio response status:', response.status);
    console.log('SMS: Twilio response body:', responseText);

    if (response.ok) {
      const data = JSON.parse(responseText);
      console.log('SMS: Success! SID:', data.sid);
      return { success: true, sid: data.sid };
    } else {
      console.error('SMS: Failed:', responseText);
      return { success: false, error: responseText };
    }
  } catch (e) {
    console.error('SMS: Exception:', e.message);
    return { success: false, error: e.message };
  }
}

