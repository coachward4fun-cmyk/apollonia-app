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
  // Renders YYYY-MM-DD as e.g. "June 5, 2026" without timezone drift.
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month:    'long',
    day:      'numeric',
    year:     'numeric',
  });
}

function buildJobSMS(job, crew, dateStr) {
  const lines = [
    'Apollonia Construction',
    'REMINDER: You have a job tomorrow',
    `Job: ${job.projectName || 'Untitled'}`,
  ];
  if (job.jobType)            lines.push(`Job Type: ${job.jobType}`);
  lines.push(`Date: ${fmtDateLong(dateStr)}`);
  if (job.jobLocationAddress) {
    lines.push(`Location: ${job.jobLocationAddress}`);
    lines.push(`Map: https://maps.google.com/?q=${encodeURIComponent(job.jobLocationAddress)}`);
  }
  if (job.billToName)         lines.push(`Customer: ${job.billToName}`);
  if (crew?.name)             lines.push(`Crew: ${crew.name}`);
  const leadName   = crew?.lead?.name   || '';
  const leadMobile = crew?.lead?.mobile || '';
  if (leadName || leadMobile) {
    lines.push(`Lead: ${[leadName, leadMobile].filter(Boolean).join(' ')}`);
  }
  lines.push('');
  lines.push('Reply STOP to opt out');
  return lines.join('\n');
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

    // One SMS per eligible job. Skip jobs that are cancelled, archived, or
    // unassigned, and skip crews without a lead mobile.
    const eligibleJobs = [];
    for (const jobDoc of jobsSnap.docs) {
      const job = jobDoc.data();
      if (!job.crewId)                              continue;
      if (job.archivedForCustomer)                  continue;
      if ((job.status || '').toLowerCase() === 'cancelled') continue;
      if (!crewMap[job.crewId]?.lead?.mobile)       continue;
      eligibleJobs.push(job);
    }

    let smsSent = 0;
    const totalJobs = eligibleJobs.length;

    for (const job of eligibleJobs) {
      const crew = crewMap[job.crewId];
      const body = buildJobSMS(job, crew, tomorrowStr);

      try {
        await twilio.messages.create({ from: fromNumber, to: crew.lead.mobile, body });
        await db.collection('activityLog').add({
          action:    'day_before_reminder_sent',
          detail:    `Day-before reminder sent to ${crew.name || 'crew'} for ${job.projectName || 'job'}`,
          timestamp: admin.firestore.Timestamp.now(),
        });
        smsSent++;
        console.log('[dayBeforeReminder] Sent to', crew.lead.mobile, '—', job.projectName);
      } catch (err) {
        console.error('[dayBeforeReminder] Failed for', crew.name || job.crewId, ':', err.message);
        await db.collection('activityLog').add({
          action:    'day_before_reminder_failed',
          detail:    `SMS failed for ${crew.name || 'crew'}: ${err.message}`,
          timestamp: admin.firestore.Timestamp.now(),
        });
      }
    }

    console.log(`[dayBeforeReminder] Done — ${smsSent}/${totalJobs} SMS sent for ${tomorrowStr}.`);
  },
);
