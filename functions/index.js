const { onRequest }   = require('firebase-functions/v2/https');
const { onSchedule }  = require('firebase-functions/v2/scheduler');
const admin           = require('firebase-admin');
const nodemailer      = require('nodemailer');
const Twilio          = require('twilio');

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

// ── Day-before SMS reminder ────────────────────────────────────────────────────
// Runs daily at 5:00 PM Central Time (America/Chicago — handles DST automatically).
// For each crew lead with jobs scheduled tomorrow, sends ONE SMS listing all of
// their jobs for the next day. Leads with no jobs tomorrow get nothing.
// Requires Firebase Blaze plan. Deploy: firebase deploy --only functions

function getTomorrowChicago() {
  // Computes "tomorrow" as the next calendar day in America/Chicago, regardless
  // of UTC offset or DST. Returns YYYY-MM-DD.
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

function fmtDateLong(dateStr) {
  // Renders YYYY-MM-DD as e.g. "Wed, Jun 5, 2026" without timezone drift.
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday:  'short',
    month:    'short',
    day:      'numeric',
    year:     'numeric',
  });
}

function formatJobBlock(job, index, total) {
  // Each job block within the SMS. Number jobs only when there's more than one.
  const lines    = [];
  const prefix   = total > 1 ? `${index + 1}. ` : '';
  const jobName  = job.projectName || 'Untitled';
  lines.push(`${prefix}${jobName}`);
  if (job.jobType)        lines.push(`Type: ${job.jobType}`);
  if (job.billToName)     lines.push(`Customer: ${job.billToName}`);
  if (job.jobLocationAddress) {
    lines.push(`Address: ${job.jobLocationAddress}`);
    lines.push(`Map: http://maps.apple.com/?q=${encodeURIComponent(job.jobLocationAddress)}`);
  }
  if (job.estimatedDuration) lines.push(`Duration: ${job.estimatedDuration}`);
  if (job.notes && String(job.notes).trim()) lines.push(`Notes: ${String(job.notes).trim()}`);
  return lines.join('\n');
}

function buildDailySMS(leadName, jobs, dateStr) {
  const header = [
    'Apollonia Construction',
    `Tomorrow (${fmtDateLong(dateStr)}) — ${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
  ];
  if (leadName) header.push(`Lead: ${leadName}`);
  const blocks = jobs.map((j, i) => formatJobBlock(j, i, jobs.length));
  return [header.join('\n'), ...blocks].join('\n\n');
}

exports.dayBeforeReminder = onSchedule(
  {
    schedule:       '0 17 * * *',         // 17:00 (5 PM) in the named time zone
    timeZone:       'America/Chicago',    // handles CST/CDT automatically
    timeoutSeconds: 30,
    memory:         '128MiB',
  },
  async () => {
    const tomorrowStr = getTomorrowChicago();
    console.log('[dayBeforeReminder] Tomorrow (CT):', tomorrowStr);

    const twilioSnap = await db.collection('meta').doc('twilioConfig').get();
    if (!twilioSnap.exists) {
      console.log('[dayBeforeReminder] No Twilio config — skipping.');
      return;
    }
    const { accountSid, authToken, fromNumber } = twilioSnap.data();
    if (!accountSid || !authToken || !fromNumber) {
      console.log('[dayBeforeReminder] Incomplete Twilio config — skipping.');
      return;
    }
    const twilio = Twilio(accountSid, authToken);

    const jobsSnap = await db.collection('jobs').where('targetDate', '==', tomorrowStr).get();
    if (jobsSnap.empty) {
      console.log('[dayBeforeReminder] No jobs for', tomorrowStr);
      return;
    }

    const crewsSnap = await db.collection('crews').get();
    const crewMap   = {};
    crewsSnap.docs.forEach((d) => { crewMap[d.id] = d.data(); });

    // Group eligible jobs by crewId. Skip jobs that are cancelled, archived,
    // or unassigned, and skip crews without a lead mobile.
    const jobsByCrew = {};
    for (const jobDoc of jobsSnap.docs) {
      const job = jobDoc.data();
      if (!job.crewId)                              continue;
      if (job.archivedForCustomer)                  continue;
      if ((job.status || '').toLowerCase() === 'cancelled') continue;
      if (!crewMap[job.crewId]?.lead?.mobile)       continue;
      (jobsByCrew[job.crewId] = jobsByCrew[job.crewId] || []).push(job);
    }

    let leadsNotified = 0;
    let smsSent       = 0;
    const totalCrews  = Object.keys(jobsByCrew).length;

    for (const crewId of Object.keys(jobsByCrew)) {
      const crew = crewMap[crewId];
      const jobs = jobsByCrew[crewId].sort((a, b) =>
        (a.projectName || '').localeCompare(b.projectName || ''),
      );
      const body = buildDailySMS(crew.lead?.name, jobs, tomorrowStr);

      try {
        await twilio.messages.create({ from: fromNumber, to: crew.lead.mobile, body });
        await db.collection('activityLog').add({
          action:    'day_before_reminder_sent',
          detail:    `Day-before reminder sent to ${crew.name || 'crew'} (${jobs.length} job${jobs.length === 1 ? '' : 's'})`,
          timestamp: admin.firestore.Timestamp.now(),
        });
        leadsNotified++;
        smsSent++;
        console.log('[dayBeforeReminder] Sent to', crew.lead.mobile, '—', jobs.length, 'job(s)');
      } catch (err) {
        console.error('[dayBeforeReminder] Failed for', crew.name || crewId, ':', err.message);
        await db.collection('activityLog').add({
          action:    'day_before_reminder_failed',
          detail:    `SMS failed for ${crew.name || 'crew'}: ${err.message}`,
          timestamp: admin.firestore.Timestamp.now(),
        });
      }
    }

    console.log(`[dayBeforeReminder] Done — ${smsSent}/${totalCrews} SMS sent for ${tomorrowStr}; ${leadsNotified} lead(s) notified.`);
  },
);
