const { onRequest }   = require('firebase-functions/v2/https');
const { onSchedule }  = require('firebase-functions/v2/scheduler');
const admin           = require('firebase-admin');
const nodemailer      = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

// ── Send invoice email ─────────────────────────────────────────────────────────
// Called via fetch() POST from the RN app — no Firebase Auth required.
// cors:true lets Firebase handle CORS + preflight automatically.

exports.sendInvoiceEmail = onRequest(
  { timeoutSeconds: 60, memory: '256MiB', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const configSnap = await db.collection('meta').doc('emailConfig').get();
      if (!configSnap.exists) {
        res.status(500).json({ error: 'Email configuration not found in Firestore.' });
        return;
      }
      const config = configSnap.data();

      const { to, subject, htmlBody, text, pdfBase64, fileName } = req.body;
      if (!to || !subject) {
        res.status(400).json({ error: 'Missing required fields: to, subject.' });
        return;
      }

      const transporter = nodemailer.createTransport({
        host:   'smtp.gmail.com',
        port:   587,
        secure: false,
        auth: {
          user: config.fromEmail,
          pass: config.appPassword,
        },
      });

      const mailOptions = {
        from:    `"${config.fromName}" <${config.fromEmail}>`,
        replyTo: config.replyTo,
        to,
        cc:      config.cc || [],
        subject,
        html:    htmlBody || '',
        text:    text     || '',
      };

      if (pdfBase64) {
        mailOptions.attachments = [{
          filename:    fileName || 'invoice.pdf',
          content:     Buffer.from(pdfBase64, 'base64'),
          contentType: 'application/pdf',
        }];
      }

      await transporter.sendMail(mailOptions);
      console.log('[sendInvoiceEmail] Sent to:', to);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[sendInvoiceEmail] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// ── Push notifications (Expo Push API) ────────────────────────────────────────
// Three scheduled functions run on America/Chicago time. Each sends Expo push
// messages to every user whose users/{uid} doc has notificationsEnabled === true
// and a pushToken set by the app's usePushToken hook.
// Requires Firebase Blaze plan. Deploy: firebase deploy --only functions

function getTomorrowCentral() {
  // DST-safe: derive today's Chicago calendar date via Intl, then add one day.
  // Works correctly regardless of whether the scheduler fires during CST or CDT.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  });
  const todayInChicago = fmt.format(new Date()); // "YYYY-MM-DD"
  const [y, m, d] = todayInChicago.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function sendExpoPush(messages) {
  // messages: array of { to, title, body, data }
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  const result = await response.json();
  console.log('[push] Expo API response:', JSON.stringify(result));
  return result;
}

async function getNotifiableUsers() {
  const snap = await db.collection('users').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => u.notificationsEnabled === true && typeof u.pushToken === 'string' && u.pushToken.length > 0);
}

function isClosedStatus(status) {
  const s = (status || '').toLowerCase();
  return s === 'invoice paid' || s === 'invoice sent';
}

async function getCrewMap() {
  const snap = await db.collection('crews').get();
  const map = {};
  snap.docs.forEach((d) => { map[d.id] = d.data(); });
  return map;
}

// ── A) morningCrewCheck — 9 AM Central daily ─────────────────────────────────
// Alerts everyone if any of tomorrow's jobs are still missing a crew assignment.

exports.morningCrewCheck = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Chicago', timeoutSeconds: 30, memory: '128MiB' },
  async () => {
    const tomorrowStr = getTomorrowCentral();
    console.log('[morningCrewCheck] Tomorrow (CT):', tomorrowStr);

    const jobsSnap = await db.collection('jobs').where('targetDate', '==', tomorrowStr).get();
    const unassigned = jobsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => !j.crewId && !isClosedStatus(j.status));

    if (unassigned.length === 0) {
      console.log('[morningCrewCheck] All tomorrow jobs have crews — nothing to do.');
      return;
    }

    const users = await getNotifiableUsers();
    if (users.length === 0) {
      console.log('[morningCrewCheck] No notifiable users.');
      return;
    }

    const n = unassigned.length;
    const messages = users.map((u) => ({
      to:         u.pushToken,
      title:      '⚠️ Jobs need crews assigned',
      body:       `${n} job${n === 1 ? '' : 's'} scheduled for tomorrow ${n === 1 ? 'has' : 'have'} no crew.`,
      data:       { type: 'crew_needed', count: n },
      categoryId: 'CREW_NEEDED',
      badge:      n,
    }));

    await sendExpoPush(messages);
    console.log(`[morningCrewCheck] Sent to ${users.length} user(s) about ${n} unassigned job(s).`);
  },
);

// ── B) dayBeforeReminder — 5 PM Central daily ─────────────────────────────────
// For each assigned crew with jobs tomorrow, alerts every notifiable user so any
// of them can tap to send the WhatsApp Notify Crew message.

exports.dayBeforeReminder = onSchedule(
  { schedule: '0 17 * * *', timeZone: 'America/Chicago', timeoutSeconds: 30, memory: '128MiB' },
  async () => {
    const tomorrowStr = getTomorrowCentral();
    console.log('[dayBeforeReminder] Tomorrow (CT):', tomorrowStr);

    const jobsSnap = await db.collection('jobs').where('targetDate', '==', tomorrowStr).get();
    const allTomorrow = jobsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => !isClosedStatus(j.status));
    const assigned   = allTomorrow.filter((j) => !!j.crewId);
    const unassigned = allTomorrow.filter((j) => !j.crewId);

    if (assigned.length === 0) {
      console.log('[dayBeforeReminder] No assigned jobs tomorrow.');
      return;
    }

    const crewMap = await getCrewMap();
    const byCrew  = {};
    for (const j of assigned) (byCrew[j.crewId] = byCrew[j.crewId] || []).push(j);

    const users = await getNotifiableUsers();
    if (users.length === 0) {
      console.log('[dayBeforeReminder] No notifiable users.');
      return;
    }

    const messages = [];
    const crewGroupBadge = Object.keys(byCrew).length;
    for (const crewId of Object.keys(byCrew)) {
      const crew = crewMap[crewId];
      const crewName = crew?.name || 'crew';
      const jobs = byCrew[crewId];
      let title, body;
      if (jobs.length === 1) {
        title = `Tomorrow: ${jobs[0].projectName || 'Untitled'}`;
        body  = `Tap to notify ${crewName} via WhatsApp`;
      } else {
        title = `Tomorrow: ${jobs.length} jobs for ${crewName}`;
        body  = `${jobs.map((j) => j.projectName || 'Untitled').join(' + ')} — tap to notify`;
      }
      const data = { type: 'crew_reminder', crewId, jobIds: jobs.map((j) => j.id) };
      for (const u of users) {
        messages.push({ to: u.pushToken, title, body, data, categoryId: 'CREW_REMINDER', badge: crewGroupBadge });
      }
    }

    await sendExpoPush(messages);
    const crewGroupCount = Object.keys(byCrew).length;
    console.log(`[dayBeforeReminder] Sent ${messages.length} push(es) for ${crewGroupCount} crew group(s).`);

    const detailBase = `Sent reminders for ${crewGroupCount} crew group${crewGroupCount === 1 ? '' : 's'}.`;
    const details = unassigned.length > 0
      ? `${detailBase} ${unassigned.length} job${unassigned.length === 1 ? '' : 's'} still need${unassigned.length === 1 ? 's' : ''} a crew.`
      : detailBase;
    try {
      await db.collection('activityLog').add({
        action:    'day_before_reminder_sent',
        details,
        timestamp: admin.firestore.Timestamp.now(),
      });
    } catch (err) {
      console.warn('[dayBeforeReminder] activityLog write failed:', err.message);
    }
  },
);

// ── C) eveningCrewReminder — 7 PM Central daily ───────────────────────────────
// Nudges everyone if any crew hasn't been notified via WhatsApp yet (i.e., the
// job still has no crewNotifiedAt timestamp).

exports.eveningCrewReminder = onSchedule(
  { schedule: '0 19 * * *', timeZone: 'America/Chicago', timeoutSeconds: 30, memory: '128MiB' },
  async () => {
    const tomorrowStr = getTomorrowCentral();
    console.log('[eveningCrewReminder] Tomorrow (CT):', tomorrowStr);

    const jobsSnap = await db.collection('jobs').where('targetDate', '==', tomorrowStr).get();
    const unNotified = jobsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((j) => !!j.crewId && !j.crewNotifiedAt && !isClosedStatus(j.status));

    if (unNotified.length === 0) {
      console.log('[eveningCrewReminder] All crews already notified — skipping.');
      return;
    }

    const crewMap = await getCrewMap();
    const byCrew  = {};
    for (const j of unNotified) (byCrew[j.crewId] = byCrew[j.crewId] || []).push(j);

    const users = await getNotifiableUsers();
    if (users.length === 0) {
      console.log('[eveningCrewReminder] No notifiable users.');
      return;
    }

    const messages = [];
    const crewGroupBadge = Object.keys(byCrew).length;
    for (const crewId of Object.keys(byCrew)) {
      const jobs = byCrew[crewId];
      const title = jobs.length === 1
        ? `⏰ Reminder: ${jobs[0].projectName || 'Untitled'}`
        : `⏰ Reminder: ${jobs.length} jobs`;
      const body = "Crew hasn't been notified yet — tap to notify via WhatsApp";
      const data = { type: 'crew_reminder_followup', crewId, jobIds: jobs.map((j) => j.id) };
      for (const u of users) {
        messages.push({ to: u.pushToken, title, body, data, categoryId: 'CREW_REMINDER', badge: crewGroupBadge });
      }
    }

    await sendExpoPush(messages);
    console.log(`[eveningCrewReminder] Sent ${messages.length} push(es) for ${Object.keys(byCrew).length} un-notified crew group(s).`);
  },
);
