const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }  = require('firebase-functions/v2/scheduler');
const admin           = require('firebase-admin');
const nodemailer      = require('nodemailer');
const puppeteer       = require('puppeteer');
const { randomUUID }  = require('crypto');

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

      const { to, cc, subject, htmlBody, text, pdfBase64, fileName } = req.body;
      if (!to || !subject) {
        res.status(400).json({ error: 'Missing required fields: to, subject.' });
        return;
      }

      await sendEmailCore(config, {
        to,
        cc,
        subject,
        htmlBody,
        text,
        pdfBuffer: pdfBase64 ? Buffer.from(pdfBase64, 'base64') : null,
        fileName,
      });

      console.log('[sendInvoiceEmail] Sent to:', to);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[sendInvoiceEmail] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// sendMail wrapper shared by the onRequest handler above (client-generated PDF)
// and the server-side batch invoice send below (server-generated PDF) — same
// transport, CC-merge, and attachment logic either way, just a Buffer instead
// of a base64 string coming in.
async function sendEmailCore(config, { to, cc, subject, htmlBody, text, pdfBuffer, fileName }) {
  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth: {
      user: config.fromEmail,
      pass: config.appPassword,
    },
  });

  // CC list = configured Firestore CCs ∪ per-request CCs (deduped, falsy-stripped).
  const configCc  = Array.isArray(config.cc) ? config.cc : (config.cc ? [config.cc] : []);
  const requestCc = Array.isArray(cc) ? cc : (cc ? [cc] : []);
  const mergedCc  = Array.from(new Set([...configCc, ...requestCc].filter(Boolean)));

  const mailOptions = {
    from:    `"${config.fromName}" <${config.fromEmail}>`,
    replyTo: config.replyTo,
    to,
    cc:      mergedCc,
    subject,
    html:    htmlBody || '',
    text:    text     || '',
  };

  if (pdfBuffer) {
    mailOptions.attachments = [{
      filename:    fileName || 'invoice.pdf',
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }];
  }

  await transporter.sendMail(mailOptions);
}

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
    const projectNames = unassigned.map((j) => j.projectName || 'Untitled');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const [yy, mm, dd] = tomorrowStr.split('-').map(Number);
    const dateLabel = `${MONTHS[mm - 1]} ${dd}`;

    let title, body;
    if (n === 1) {
      title = '⚠️ Crew Needed';
      body  = `${projectNames[0]} on ${dateLabel} has no crew assigned.`;
    } else {
      title = `⚠️ ${n} Jobs Need Crews`;
      body  = `${projectNames.join(', ')} on ${dateLabel} have no crew assigned.`;
    }

    // One message per notifiable user — all identical. Each user gets exactly
    // one push regardless of how many jobs need crews (consolidated body).
    const messages = users.map((u) => ({
      to:         u.pushToken,
      title,
      body,
      data:       { type: 'crew_needed', count: n, jobIds: unassigned.map((j) => j.id) },
      categoryId: 'CREW_NEEDED',
      badge:      n,
    }));

    await sendExpoPush(messages);
    console.log(`[morningCrewCheck] Sent 1 consolidated push to ${users.length} user(s) about ${n} unassigned job(s).`);
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

    // For each crew with jobs tomorrow:
    //   - Build a WhatsApp-ready message addressed to the crew LEAD.
    //   - Build the matching wa.me URL with the message URL-encoded.
    //   - Send ONE notification per crew that fans out to every notifiable
    //     app user (Kleodian, Scott, Mary, etc.) so anyone can tap it.
    const messages = [];
    const crewGroupBadge = Object.keys(byCrew).length;
    for (const crewId of Object.keys(byCrew)) {
      const crew = crewMap[crewId];
      const crewLeadName  = crew?.lead?.name  || 'crew';
      const crewLeadPhone = String(crew?.lead?.phone || '').replace(/\D/g, '');
      const crewJobs = byCrew[crewId];

      // Plain-text WhatsApp message body. Tap-to-call map links built per job
      // so the lead can navigate from their phone with one tap.
      const greeting = `Hi ${crewLeadName}, here are your jobs for tomorrow:`;
      const jobBlocks = crewJobs.map((job) => {
        const jobType  = job.jobType || 'Job';
        const address  = job.jobLocationAddress || job.billToAddress || '';
        const mapUrl   = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
        return `- ${jobType} — ${address}\n  📍 ${mapUrl}`;
      }).join('\n\n');
      const whatsappMessage = `${greeting}\n\n${jobBlocks}`;
      const whatsappUrl     = `https://wa.me/${crewLeadPhone}?text=${encodeURIComponent(whatsappMessage)}`;

      const n     = crewJobs.length;
      const title = `Tomorrow: ${crewLeadName}'s Jobs`;
      const body  = `${n} job${n === 1 ? '' : 's'} scheduled — tap to notify via WhatsApp`;
      const data  = {
        type:           'crew_reminder',
        crewId,
        crewLeadPhone,
        whatsappMessage,
        whatsappUrl,
        jobIds:         crewJobs.map((j) => j.id),
      };
      for (const u of users) {
        messages.push({ to: u.pushToken, title, body, data, categoryId: 'CREW_REMINDER', badge: crewGroupBadge });
      }
    }

    await sendExpoPush(messages);
    const crewGroupCount = Object.keys(byCrew).length;
    console.log(`[dayBeforeReminder] Sent ${messages.length} push(es) for ${crewGroupCount} crew(s) with tomorrow jobs.`);

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

// ── Date helpers (DST-safe, Chicago) ─────────────────────────────────────────

function getCentralDateStr(offset = 0) {
  // Returns YYYY-MM-DD for today + offset days in America/Chicago.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  });
  const todayInChicago = fmt.format(new Date()); // "YYYY-MM-DD"
  const [y, m, d] = todayInChicago.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function addDaysStr(yyyymmddStr, days) {
  const [y, m, d] = yyyymmddStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addMonthsStr(yyyymmddStr, months) {
  const [y, m, d] = yyyymmddStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

// ── C) recurringExpenseCheck — 8 AM Central daily ───────────────────────────
// For each expense with recurring === true (excluding 'each_job'), checks if
// enough time has passed since the last creation (or the parent's date if
// no child has ever been created) and creates a copy with today's date.
// No push notifications.

exports.recurringExpenseCheck = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/Chicago', timeoutSeconds: 60, memory: '256MiB' },
  async () => {
    const todayStr = getCentralDateStr(0);
    console.log('[recurringExpenseCheck] Today (CT):', todayStr);

    const snap = await db.collection('expenses').where('recurring', '==', true).get();
    if (snap.empty) {
      console.log('[recurringExpenseCheck] No recurring parents.');
      return;
    }

    let created = 0;
    for (const doc of snap.docs) {
      const parent = doc.data();
      const freq   = (parent.recurringFrequency || '').toLowerCase();

      // each_job is handled inline in JobFormScreen — never auto-fires here.
      if (freq === 'each_job' || !freq) continue;

      const lastStr = parent.lastRecurringCreatedAt || parent.date;
      if (!lastStr) {
        console.warn('[recurringExpenseCheck] Parent has no anchor date — skipping:', doc.id);
        continue;
      }

      let nextStr;
      if      (freq === 'weekly')    nextStr = addDaysStr(lastStr, 7);
      else if (freq === 'monthly')   nextStr = addMonthsStr(lastStr, 1);
      else if (freq === 'quarterly') nextStr = addMonthsStr(lastStr, 3);
      else if (freq === 'annually')  nextStr = addMonthsStr(lastStr, 12);
      else continue;

      if (todayStr < nextStr) continue;

      // Build child — explicit field copy avoids passing through fields that
      // shouldn't propagate (id, lastRecurringCreatedAt, recurring*, photos).
      const childId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const child = {
        id:           childId,
        type:         parent.type || 'company',
        date:         todayStr,
        amount:       Number(parent.amount) || 0,
        description:  parent.description || '',
        category:     parent.category    || 'Other',
        addToInvoice: false,
        isCrewCost:   parent.isCrewCost === true,
        recurring:    false,
        recurringParentId: doc.id,
      };

      try {
        await db.collection('expenses').doc(childId).set(child);
        await doc.ref.update({ lastRecurringCreatedAt: todayStr });
        created++;
        console.log('[recurringExpenseCheck] Created child', childId, 'from', doc.id, `(${freq})`);
      } catch (err) {
        console.error('[recurringExpenseCheck] Failed for', doc.id, ':', err.message);
      }
    }

    console.log(`[recurringExpenseCheck] Done — ${created} expense(s) auto-created.`);
  },
);

// ── D) invoicePdfCleanup — 3 AM Central daily ────────────────────────────────
// Deletes invoice PDFs older than 60 days from Storage and clears the
// `invoicePdfUrl` on any job whose stored PDF has been purged. Keeps storage
// usage bounded — invoices stay accessible for ~2 months after sending.

exports.invoicePdfCleanup = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const cutoffMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    console.log('[invoicePdfCleanup] Deleting PDFs older than', cutoffIso);

    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: 'invoices/' });

    let deleted = 0;
    const deletedNames = new Set();
    for (const file of files) {
      const created = file.metadata?.timeCreated;
      if (!created) continue;
      if (new Date(created).getTime() > cutoffMs) continue;
      try {
        await file.delete();
        deletedNames.add(file.name);
        deleted++;
      } catch (err) {
        console.warn('[invoicePdfCleanup] delete failed:', file.name, err.message);
      }
    }
    console.log(`[invoicePdfCleanup] Deleted ${deleted} PDF(s) from Storage.`);

    // Clear invoicePdfUrl on any job whose upload predates the cutoff. We can't
    // query by ISO-string range portably, so scan jobs with a non-empty url and
    // filter in memory — the field is sparse, so this stays cheap.
    const snap = await db.collection('jobs').where('invoicePdfUrl', '>', '').get();
    let cleared = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const uploadedAt = data.invoicePdfUploadedAt || '';
      if (uploadedAt && uploadedAt >= cutoffIso) continue;
      try {
        await doc.ref.update({
          invoicePdfUrl:        admin.firestore.FieldValue.delete(),
          invoicePdfUploadedAt: admin.firestore.FieldValue.delete(),
        });
        cleared++;
      } catch (err) {
        console.warn('[invoicePdfCleanup] job update failed:', doc.id, err.message);
      }
    }
    console.log(`[invoicePdfCleanup] Cleared invoicePdfUrl on ${cleared} job(s).`);
  },
);

// ── E) roofEstimator — AI roof estimation from satellite + street view ──────
// Callable function. Fetches aerial + street view photos from Google, sends
// both to Claude vision, parses the JSON response, writes the result to the
// job doc, and pushes a notification to all notifiable users.
//
// API keys live in functions/.env:
//   ANTHROPIC_KEY    — Anthropic API key
//   GOOGLE_MAPS_KEY  — Google Maps key with Static Maps + Street View enabled

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  // Normalize to a Claude-accepted type
  let mediaType = 'image/jpeg';
  if (contentType.includes('png'))       mediaType = 'image/png';
  else if (contentType.includes('webp')) mediaType = 'image/webp';
  else if (contentType.includes('gif'))  mediaType = 'image/gif';
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { base64, mediaType };
}

function stripJsonFences(text) {
  // Claude sometimes wraps JSON in ```json ... ``` despite instructions.
  // Strip a single fenced block if present, otherwise return as-is.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : text;
}

exports.roofEstimator = onCall(
  { timeoutSeconds: 300, memory: '512MiB', cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const { jobId, address } = request.data || {};
    if (!jobId || !address) {
      throw new HttpsError('invalid-argument', 'jobId and address are required.');
    }

    const anthropicKey  = process.env.ANTHROPIC_KEY;
    const googleMapsKey = process.env.GOOGLE_MAPS_KEY;
    if (!anthropicKey || !googleMapsKey) {
      throw new HttpsError('failed-precondition', 'Missing ANTHROPIC_KEY or GOOGLE_MAPS_KEY in functions env.');
    }

    const jobRef = db.collection('jobs').doc(jobId);

    try {
      const encodedAddress = encodeURIComponent(address);

      // Server-side geocoding using GOOGLE_MAPS_KEY (the app's client key was
      // referrer/app-restricted and getting blocked on the Geocoding endpoint).
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${googleMapsKey}`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();
      console.log('[roofEstimator] geocode status:', geoData.status);
      console.log('[roofEstimator] geocode error:', geoData.error_message || 'none');
      console.log('[roofEstimator] geocode results count:', geoData.results?.length || 0);
      if (!geoData.results?.length) {
        throw new HttpsError('not-found', 'Could not geocode address: ' + address);
      }
      const { lat, lng } = geoData.results[0].geometry.location;

      const aerialUrl =
        `https://maps.googleapis.com/maps/api/staticmap?center=${encodedAddress}&zoom=20&size=400x400&maptype=satellite&key=${googleMapsKey}`;
      const streetUrl =
        `https://maps.googleapis.com/maps/api/streetview?size=400x400&location=${encodedAddress}&key=${googleMapsKey}`;

      console.log('[roofEstimator] Fetching aerial + street view for', jobId);
      const [aerialImg, streetImg] = await Promise.all([
        fetchImageAsBase64(aerialUrl),
        fetchImageAsBase64(streetUrl),
      ]);
      const aerialBase64    = aerialImg.base64;
      const aerialMediaType = aerialImg.mediaType;
      const streetBase64    = streetImg.base64;
      const streetMediaType = streetImg.mediaType;
      console.log('[roofEstimator] aerial media type:', aerialMediaType);
      console.log('[roofEstimator] street media type:', streetMediaType);

      // Pixel scale derived from the aerial Static Maps zoom level. Must match
      // the &zoom= param in aerialUrl above — changing one without the other
      // breaks Claude's square-footage math (each zoom step halves the scale).
      const AERIAL_ZOOM = 20;
      const metersPerPixel = 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, AERIAL_ZOOM);
      const feetPerPixel   = metersPerPixel * 3.28084;

      const prompt = `Analyze these two photos of a property (aerial satellite view and street view). The aerial satellite image scale is ${feetPerPixel.toFixed(3)} feet per pixel on a 400x400 image.

This may be a residential OR commercial building. Adjust your analysis accordingly:
- For residential: estimate pitched roof using pitch multiplier
- For flat/low-slope commercial roofs: use footprint area directly (pitch multiplier = 1.0)
- For commercial with multiple roof sections: estimate each section separately and sum them

Calculate:
1. Building type: Residential or Commercial
2. Roof type: Pitched, Flat, or Low-slope
3. Total roof surface area in square feet
4. Roof pitch (e.g. 6/12 for pitched, Flat for commercial flat roofs)
5. Total roofing squares BEFORE factor: surface area ÷ 100
6. Apply 15% factor: squares × 1.15, round to nearest 0.5
7. Complexity: Simple, Moderate, or Complex

Respond ONLY in valid JSON, no markdown:
{
  "buildingType": "Residential|Commercial",
  "roofType": "Pitched|Flat|Low-slope",
  "squares": <number with 15% factor included>,
  "pitch": "<pitch string or Flat>",
  "complexity": "Simple|Moderate|Complex",
  "reasoning": "<2 sentences max>"
}`;

      console.log('[roofEstimator] Calling Claude vision for', jobId);
      const anthropicRes = await fetch(ANTHROPIC_URL, {
        method:  'POST',
        headers: {
          'content-type':      'application/json',
          'x-api-key':         anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      ANTHROPIC_MODEL,
          max_tokens: 1000,
          system:     'You are a professional roofing estimator with 20 years experience.',
          messages: [{
            role:    'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: aerialMediaType, data: aerialBase64 } },
              { type: 'image', source: { type: 'base64', media_type: streetMediaType, data: streetBase64 } },
              { type: 'text',  text: prompt },
            ],
          }],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text().catch(() => '');
        throw new Error(`Anthropic API HTTP ${anthropicRes.status}: ${errText.slice(0, 200)}`);
      }

      const anthropicJson = await anthropicRes.json();
      const rawText = anthropicJson?.content?.[0]?.text || '';
      if (!rawText) throw new Error('Anthropic returned no text content.');

      let parsed;
      try {
        parsed = JSON.parse(stripJsonFences(rawText).trim());
      } catch (parseErr) {
        throw new Error(`Could not parse Claude response as JSON: ${rawText.slice(0, 200)}`);
      }

      const { squares, pitch, complexity, reasoning, buildingType, roofType } = parsed;
      if (squares == null || !pitch || !complexity) {
        throw new Error(`Claude response missing required fields. Got: ${JSON.stringify(parsed).slice(0, 200)}`);
      }

      const estimatedAt = new Date().toISOString();
      const roofEstimate = {
        squares,
        pitch,
        complexity,
        buildingType: buildingType || '',
        roofType:     roofType     || '',
        reasoning:    reasoning    || '',
        estimatedAt,
        status: 'complete',
      };
      const noteLine = `Roof: ${pitch}, ${complexity} complexity`;

      // Atomic notes append so a concurrent edit can't clobber the AI note.
      // Also captures projectName for the push notification body in the same read.
      let projectName = '';
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const existing = snap.exists ? snap.data() : {};
        projectName = existing.projectName || 'Job';
        // Append with ' | ' separator. If a prior "Roof: …" segment already
        // exists in the notes (from a previous estimate), replace it in place
        // instead of duplicating — re-estimating shouldn't accumulate stale
        // roof segments.
        const existingNotes = (existing.notes || '').trim();
        let mergedNotes;
        if (!existingNotes) {
          mergedNotes = noteLine;
        } else {
          const segments = existingNotes.split(' | ').map((s) => s.trim()).filter(Boolean);
          const roofIdx  = segments.findIndex((s) => s.startsWith('Roof:'));
          if (roofIdx >= 0) {
            segments[roofIdx] = noteLine;
            mergedNotes = segments.join(' | ');
          } else {
            mergedNotes = `${existingNotes} | ${noteLine}`;
          }
        }
        tx.update(jobRef, {
          roofEstimate,
          notes:                mergedNotes,
          aerialPhotoBase64:    aerialBase64,
          streetViewPhotoBase64: streetBase64,
        });
      });

      // Upload both photos to Storage and append to the job's photos array
      // so they appear in the regular job photos UI. Wrapped in try/catch —
      // the estimate is already saved; a storage failure shouldn't fail the run.
      console.log('[roofEstimator] uploading photos for', jobId);
      try {
        const bucket = admin.storage().bucket();
        const ts = Date.now();
        const extFor = (mt) => mt && mt.includes('png') ? 'png' : 'jpg';
        const aerialPath = `jobs/${jobId}/aerial_estimate_${ts}.${extFor(aerialMediaType)}`;
        const streetPath = `jobs/${jobId}/streetview_estimate_${ts}.${extFor(streetMediaType)}`;
        console.log('[roofEstimator] aerial upload path:', aerialPath);
        console.log('[roofEstimator] street upload path:', streetPath);
        const aerialToken = randomUUID();
        const streetToken = randomUUID();

        await Promise.all([
          bucket.file(aerialPath).save(Buffer.from(aerialBase64, 'base64'), {
            contentType: aerialMediaType,
            resumable:   false,
            metadata:    { metadata: { firebaseStorageDownloadTokens: aerialToken } },
          }),
          bucket.file(streetPath).save(Buffer.from(streetBase64, 'base64'), {
            contentType: streetMediaType,
            resumable:   false,
            metadata:    { metadata: { firebaseStorageDownloadTokens: streetToken } },
          }),
        ]);

        const aerialDownloadUrl =
          `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(aerialPath)}?alt=media&token=${aerialToken}`;
        const streetDownloadUrl =
          `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(streetPath)}?alt=media&token=${streetToken}`;

        const nowIso = new Date().toISOString();
        const aerialEntry = { uri: aerialDownloadUrl, label: 'AI Aerial View',     createdAt: nowIso };
        const streetEntry = { uri: streetDownloadUrl, label: 'AI Street View',     createdAt: nowIso };

        // Append via transaction so a concurrent photo add doesn't clobber.
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(jobRef);
          const existingPhotos = (snap.exists && Array.isArray(snap.data().photos)) ? snap.data().photos : [];
          const nextPhotos = [...existingPhotos, aerialEntry, streetEntry];
          tx.update(jobRef, { photos: nextPhotos, photoCount: nextPhotos.length });
        });
        console.log('[roofEstimator] photos saved to job:', jobId);
      } catch (photoErr) {
        // Explicit error logging (was a quiet .warn before) — surface stack so
        // the cause is visible in Cloud Logging without needing extra context.
        console.error('[roofEstimator] photo upload/append failed for', jobId, '—', photoErr.message);
        if (photoErr.stack) console.error('[roofEstimator] photo upload stack:', photoErr.stack);
      }

      // Success path is intentionally silent — the user discovers the
      // completed estimate next time they open the job, or via the "Estimate"
      // pill on the jobs list. Only failures get a push (see catch block).

      try {
        await db.collection('activityLog').add({
          action:    'roof_estimate_complete',
          details:   `Roof estimate for ${projectName}: ${squares} squares, ${pitch}, ${complexity}`,
          timestamp: admin.firestore.Timestamp.now(),
        });
      } catch (err) {
        console.warn('[roofEstimator] activityLog write failed:', err.message);
      }

      return { ok: true, squares, pitch, complexity };
    } catch (err) {
      console.error('[roofEstimator] failed for', jobId, err.message);
      try {
        await jobRef.update({
          roofEstimate: {
            status:      'failed',
            error:       err.message || 'unknown error',
            estimatedAt: new Date().toISOString(),
          },
        });
      } catch (writeErr) {
        console.warn('[roofEstimator] failure-write also failed:', writeErr.message);
      }
      throw new HttpsError('internal', err.message || 'Roof estimation failed.');
    }
  },
);

// ── F) notifyAppUpdate — push "new version available" to all other users ─────
// Callable. Invoked by the first device that boots a brand-new EAS build (see
// src/services/buildUpdate.js). Pushes to every notifiable user except the
// caller, deep-linking to the EAS install page via data.installUrl.

exports.notifyAppUpdate = onCall(
  { timeoutSeconds: 30, memory: '128MiB', cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const { installUrl, currentUid } = request.data || {};
    if (!installUrl) {
      throw new HttpsError('invalid-argument', 'installUrl is required.');
    }

    const users = (await getNotifiableUsers()).filter((u) => u.id !== currentUid);
    if (users.length === 0) {
      console.log('[notifyAppUpdate] No other notifiable users.');
      return { ok: true, sent: 0 };
    }

    const messages = users.map((u) => ({
      to:    u.pushToken,
      title: 'Apollonia Update Available',
      body:  'Tap to install the latest version.',
      data:  { type: 'app_update', installUrl },
    }));

    await sendExpoPush(messages);
    console.log(`[notifyAppUpdate] Sent update push to ${users.length} user(s).`);
    return { ok: true, sent: users.length };
  },
);

// ── G) Invoice batch send — Friday auto-send + manual "Send All Queued" ──────
// Every job with status 'Invoice Ready' already carries its own invoiceNumber,
// invoiceDate, dueDate and lineItems (set by the InvoiceWizard when the invoice
// was created), so a batch send just needs to render + email each one.
//
// The mobile app builds its invoice PDF with expo-print (a native/WebView
// renderer) plus expo-file-system/expo-image-manipulator for downloading and
// compressing job photos — none of which exist in the Cloud Functions Node
// runtime. To keep the emailed PDF visually identical to a manually-sent one,
// buildInvoiceHTML below is a straight port of the client's HTML template
// (src/utils/sendInvoiceEmail.js) with puppeteer standing in for expo-print.
// One simplification: batch-sent PDFs omit job photos (photoData is always
// []) to avoid adding a Storage-download/resize step here — line items,
// totals, and company branding are unaffected.

const INTERNAL_CC = 'Apolloniarecords999@gmail.com';

function escapeHtmlFn(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDecimalFn(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatInvoiceDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function calcInvoiceTotals(lineItems, taxRateNum = 7) {
  const subtotal = lineItems.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0);
  const tax      = subtotal * (taxRateNum / 100);
  return { subtotal, tax, total: subtotal + tax };
}

function isBidUnpriced(item) {
  return !!item.isBid && !(Number(item.unitPrice) || 0);
}

function formatPhoneDisplayFn(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const core = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
  if (core.length === 10) return `${core.slice(0, 3)}-${core.slice(3, 6)}-${core.slice(6)}`;
  return phone;
}

const ITEMS_PER_PDF_PAGE = 14;

function buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, footerNote = '', logoSrc = '', photoData = [], profile = {}) {
  const taxRateNum = job.taxRate != null ? job.taxRate : 0;
  const taxLabel   = job.taxLabel || '';
  const taxDisplay = `${taxRateNum}%${taxLabel ? ` - ${taxLabel}` : ''}`;
  const { subtotal, tax, total } = calcInvoiceTotals(lineItems, taxRateNum);
  const visibleItems = lineItems.filter((i) => (Number(i.qty) || 0) > 0);

  const companyName  = escapeHtmlFn(profile.companyName  || '');
  const companyAddr  = escapeHtmlFn(profile.address      || '');
  const companyPhone = escapeHtmlFn(profile.phone        || '');
  const billingEmail = escapeHtmlFn(profile.billingEmail || '');
  const tagline      = escapeHtmlFn(profile.tagline      || '');

  const pages = [];
  for (let start = 0; start < visibleItems.length; start += ITEMS_PER_PDF_PAGE) {
    pages.push(visibleItems.slice(start, start + ITEMS_PER_PDF_PAGE));
  }
  if (pages.length === 0) pages.push([]);
  const totalPages = pages.length;
  const totalDocPages = totalPages; // no photo pages — photoData is always [] here

  const headerHtml = `
    <div style="background:#fff;height:60px;">
      <table style="width:100%;height:60px;border-collapse:collapse;"><tr>
        <td style="width:190px;background:#fff;vertical-align:middle;text-align:center;border-right:1px solid rgba(255,255,255,0.3);">
          ${logoSrc
            ? `<img src="${logoSrc}" style="height:50px;max-width:180px;display:block;margin:0 auto;" alt="${companyName}" />`
            : `<div style="padding:0 12px;"><div style="font-size:16px;font-weight:800;color:#16a34a;">${companyName}</div>${companyAddr ? `<div style="font-size:11px;color:#374151;margin-top:2px;">${companyAddr}</div>` : ''}</div>`
          }
        </td>
        <td style="background:#16a34a;vertical-align:middle;text-align:center;padding:0 16px;border-left:1px solid rgba(255,255,255,0.3);border-right:1px solid rgba(255,255,255,0.3);">
          ${tagline
            ? `<div style="font-size:16px;font-weight:700;font-style:italic;color:#fff;letter-spacing:0.2px;line-height:1.2;">&ldquo;${tagline}&rdquo;</div>`
            : ''}
        </td>
        <td style="width:140px;background:#fff;vertical-align:middle;text-align:center;border-left:1px solid rgba(255,255,255,0.3);">
          <div style="font-size:24px;font-weight:700;color:#15803d;letter-spacing:2px;">INVOICE</div>
        </td>
      </tr></table>
    </div>
    <div style="padding:6px 32px 0;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-size:11px;color:#6b7280;">${companyAddr}</td>
          <td style="font-size:11px;color:#6b7280;text-align:right;">Invoice ${escapeHtmlFn(invoiceNumber)}</td>
        </tr>
      </table>
    </div>`;

  const billToMetaHtml = `
      <table style="width:100%;border-collapse:collapse;margin-bottom:0;">
        <tr>
          <td style="vertical-align:top;width:55%;">
            <div style="font-size:9pt;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Bill To</div>
            <div style="font-size:15px;font-weight:700;color:#111827;">${job.billToName || ''}</div>
            ${(job.billToAddress || job.email)
              ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${[job.billToAddress, job.email].filter(Boolean).join('&nbsp;&nbsp;')}</div>`
              : ''}
            ${job.phone
              ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${formatPhoneDisplayFn(job.phone)}</div>`
              : ''}
          </td>
          <td style="vertical-align:top;text-align:right;">
            <table style="margin-left:auto;border-collapse:collapse;">
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Invoice #</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${invoiceNumber}</td>
              </tr>
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Invoice Date</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${formatInvoiceDate(invDate)}</td>
              </tr>
              <tr>
                <td style="font-size:12px;color:#9ca3af;padding:3px 0;padding-right:12px;">Due Date</td>
                <td style="font-size:12px;font-weight:600;color:#111827;padding:3px 0;">${formatInvoiceDate(dueDate)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <div style="background:#f0fdf4;border-radius:8px;padding:8px 16px;margin-bottom:8px;border-left:4px solid #16a34a;">
        <div style="font-size:9pt;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Project</div>
        <div style="font-size:14px;color:#111827;line-height:1.4;">
          ${job.jobId ? `<span style="font-weight:600;color:#6b7280;font-family:monospace;margin-right:8px;">Job ${escapeHtmlFn(job.jobId)}</span>` : ''}
          <span style="font-weight:700;">${job.projectName || ''}</span>
          ${job.targetDate ? `<span style="color:#6b7280;margin-left:8px;">· ${formatInvoiceDate(job.targetDate)}</span>` : ''}
        </div>
        ${job.jobLocationAddress ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${job.jobLocationAddress}</div>` : ''}
      </div>`;

  const columnHeaderHtml = `
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:6px 12px;text-align:left;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;">Description</th>
            <th style="padding:6px 12px;text-align:center;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:44px;">Qty</th>
            <th style="padding:6px 12px;text-align:center;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:44px;">Unit</th>
            <th style="padding:6px 12px;text-align:right;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Unit Cost</th>
            <th style="padding:6px 12px;text-align:right;font-size:9pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e5e7eb;width:80px;">Total</th>
          </tr>
        </thead>`;

  const rowHtml = (item) => {
    const lt = (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
    const bid = isBidUnpriced(item);
    return `
      <tr>
        <td style="padding:4px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;color:#111827;">${escapeHtmlFn(item.description)}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:center;color:#374151;">${item.qty}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:center;color:#374151;">${escapeHtmlFn(item.unit || '')}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:right;color:#374151;">${bid ? 'Bid' : fmtDecimalFn(item.unitPrice)}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f3f4f6;font-size:10pt;text-align:right;font-weight:600;color:#111827;">${bid ? 'Bid' : fmtDecimalFn(lt)}</td>
      </tr>`;
  };

  const totalsHtml = `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;border-top:2px solid #e5e7eb;">
        <tr>
          <td style="vertical-align:top;width:50%;padding-right:24px;padding-top:8px;">
            <div style="font-size:9pt;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Send Payment To</div>
            <div style="font-size:14px;font-weight:700;color:#111827;">${companyName}</div>
            ${companyAddr  ? `<div style="font-size:13px;color:#6b7280;margin-top:3px;">${companyAddr}</div>`  : ''}
            ${billingEmail ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${billingEmail}</div>` : ''}
            ${companyPhone ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${companyPhone}</div>` : ''}
          </td>
          <td style="vertical-align:top;padding-top:8px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:5px 0;font-size:13px;color:#6b7280;">Subtotal</td>
                <td style="padding:5px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimalFn(subtotal)}</td>
              </tr>
              <tr>
                <td style="padding:5px 0;font-size:13px;color:#6b7280;">Tax (${taxDisplay})${taxRateNum === 0 ? ' *' : ''}</td>
                <td style="padding:5px 0;font-size:13px;color:#111827;text-align:right;">${fmtDecimalFn(tax)}</td>
              </tr>
              <tr>
                <td colspan="2"><hr style="border:none;border-top:2px solid #e5e7eb;margin:6px 0;"></td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-size:15px;font-weight:800;color:#111827;">Total Due</td>
                <td style="padding:4px 0;font-size:17px;font-weight:800;color:#16a34a;text-align:right;">${fmtDecimalFn(total)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      ${taxRateNum === 0 ? `<div style="margin-top:14px;font-style:italic;font-size:9pt;color:#6b7280;">* This invoice reflects non-retail services in support of Real Property improvement</div>` : ''}
      ${footerNote ? `<div style="margin-top:16px;">${footerNote}</div>` : ''}`;

  const invoicePagesHtml = pages.map((items, i) => {
    const isFirst        = i === 0;
    const isLastItemPage = i === totalPages - 1;
    return `
  <div style="max-width:680px;margin:0 auto;background:#fff;${isFirst ? '' : 'page-break-before:always;break-before:page;'}">
    ${headerHtml}
    <div style="padding:8px 32px;">
      ${isFirst ? billToMetaHtml : ''}
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        ${columnHeaderHtml}
        <tbody>${items.map(rowHtml).join('')}</tbody>
      </table>
      ${isLastItemPage ? totalsHtml : `<div style="text-align:center;font-size:9pt;font-style:italic;color:#9ca3af;margin:8px 0 16px;">Continued on next page&hellip;</div>`}
      <div style="text-align:center;font-size:9pt;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:8px;margin-top:16px;">Page ${i + 1} of ${totalDocPages}</div>
    </div>
  </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice ${invoiceNumber}</title>
  <style>
    @page { size: letter; margin: 0.5in; }
    @media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  ${invoicePagesHtml}

</body>
</html>`;
}

function buildInvoicePlainText(job, invoiceNumber, invDate, dueDate, lineItems, profile) {
  const visibleItems = lineItems.filter((i) => (Number(i.qty) || 0) > 0);
  const taxRateNum    = job.taxRate != null ? job.taxRate : 0;
  const taxLabel      = job.taxLabel || '';
  const taxDisplay    = `${taxRateNum}%${taxLabel ? ` - ${taxLabel}` : ''}`;
  const { subtotal, tax, total } = calcInvoiceTotals(lineItems, taxRateNum);
  const itemLines = visibleItems.map(
    (i) => `  ${i.description.padEnd(40)} ${String(i.qty).padStart(4)} x ${fmtDecimalFn(i.unitPrice).padStart(9)} = ${fmtDecimalFn((Number(i.qty) || 0) * (Number(i.unitPrice) || 0))}`,
  ).join('\n');

  const profileSupport = profile.supportEmail || '';
  const headerLine = profile.companyName
    ? (profile.address ? `${profile.companyName} — ${profile.address}` : profile.companyName)
    : '';

  return [
    `INVOICE #${invoiceNumber}`,
    headerLine,
    '',
    `Invoice Date : ${formatInvoiceDate(invDate)}`,
    `Due Date     : ${formatInvoiceDate(dueDate)}`,
    '',
    `Send Payment To`,
    `---------------`,
    profile.companyName  || '',
    profile.address      || '',
    profile.billingEmail || '',
    profile.phone        || '',
    '',
    `Bill To`,
    `-------`,
    job.billToName    || '',
    job.billToAddress || '',
    job.email         || '',
    '',
    `Project`,
    `-------`,
    job.projectName        || '',
    job.jobLocationAddress || '',
    job.targetDate ? `Job Date: ${formatInvoiceDate(job.targetDate)}` : '',
    '',
    `Line Items`,
    `----------`,
    itemLines,
    '',
    `Subtotal : ${fmtDecimalFn(subtotal)}`,
    `Tax (${taxDisplay}) : ${fmtDecimalFn(tax)}`,
    `─────────────────────`,
    `Total Due: ${fmtDecimalFn(total)}`,
    '',
    `Please remit payment by ${formatInvoiceDate(dueDate)}.`,
    profileSupport
      ? `Questions? Reply to this email or contact ${profileSupport}.`
      : `Questions? Reply to this email.`,
    '',
    profile.companyName ? `This invoice was sent by ${profile.companyName}.` : '',
    `To stop receiving invoices, reply with "unsubscribe".`,
  ].filter((l) => l !== undefined).join('\n');
}

async function fetchCompanyProfile() {
  const snap = await db.collection('meta').doc('companyProfile').get();
  const defaults = {
    companyName: '', address: '', phone: '', billingEmail: '', supportEmail: '', tagline: '', logoUrl: '',
  };
  return { ...defaults, ...(snap.exists ? snap.data() : {}) };
}

async function renderInvoicePdfBuffer(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

// Mirrors the path/token convention of the client's uploadInvoicePdf
// (src/services/storageService.js) so "View Invoice" works the same way
// for batch-sent invoices as it does for manually-sent ones.
async function uploadInvoicePdfServer(pdfBuffer, jobId, invoiceNumber) {
  const bucket  = admin.storage().bucket();
  const safeInv = String(invoiceNumber || 'invoice').replace(/[^A-Za-z0-9._-]/g, '_');
  const path    = `invoices/${jobId}/${safeInv}-${Date.now()}.pdf`;
  const token   = randomUUID();

  await bucket.file(path).save(pdfBuffer, {
    contentType: 'application/pdf',
    resumable:   false,
    metadata:    { metadata: { firebaseStorageDownloadTokens: token } },
  });

  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function findUserByNameFragment(fragment) {
  const snap  = await db.collection('users').get();
  const lower = fragment.toLowerCase();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((u) => (u.name || '').toLowerCase().includes(lower) && typeof u.pushToken === 'string' && u.pushToken.length > 0)
    || null;
}

// Core batch logic shared by fridayInvoiceSend (scheduled) and
// sendQueuedInvoices (callable) — queries Invoice Ready jobs, emails each one
// with its own PDF, flips status to Invoice Sent on success, and logs/
// continues past individual failures rather than aborting the whole batch.
async function processInvoiceQueue(source) {
  const snap = await db.collection('jobs').where('status', '==', 'Invoice Ready').get();
  if (snap.empty) {
    return { total: 0, sent: 0, failed: 0, sentJobs: [], failedJobs: [] };
  }

  const configSnap = await db.collection('meta').doc('emailConfig').get();
  if (!configSnap.exists) {
    throw new Error('Email configuration not found in Firestore (meta/emailConfig).');
  }
  const emailConfig = configSnap.data();
  const profile      = await fetchCompanyProfile();

  const browser   = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const sentJobs   = [];
  const failedJobs = [];

  try {
    for (const jobDoc of snap.docs) {
      const job         = { id: jobDoc.id, ...jobDoc.data() };
      const projectName = job.projectName || 'Untitled Job';
      try {
        if (!job.email)         throw new Error('No email address on file for this customer.');
        if (!job.invoiceNumber) throw new Error('Job has no invoice number.');

        const invoiceNumber = job.invoiceNumber;
        const invDate       = job.invoiceDate || '';
        const dueDate       = job.dueDate || '';
        const lineItems     = job.lineItems || [];

        const html      = buildInvoiceHTML(job, invoiceNumber, invDate, dueDate, lineItems, '', profile.logoUrl || '', [], profile);
        const pdfBuffer  = await renderInvoicePdfBuffer(browser, html);
        const plainText  = buildInvoicePlainText(job, invoiceNumber, invDate, dueDate, lineItems, profile);
        const subject    = `${profile.companyName || 'Invoice'} Invoice - ${projectName || invoiceNumber}`;

        await sendEmailCore(emailConfig, {
          to:        job.email,
          cc:        [INTERNAL_CC],
          subject,
          htmlBody:  html,
          text:      plainText,
          pdfBuffer,
          fileName:  `Invoice-${invoiceNumber}.pdf`,
        });

        const updates = { status: 'Invoice Sent' };
        try {
          updates.invoicePdfUrl        = await uploadInvoicePdfServer(pdfBuffer, job.id, invoiceNumber);
          updates.invoicePdfUploadedAt = new Date().toISOString();
        } catch (uploadErr) {
          console.warn('[processInvoiceQueue] PDF storage upload failed for', job.id, uploadErr.message);
        }
        await jobDoc.ref.update(updates);

        await db.collection('activityLog').add({
          action:    'invoice_sent',
          details:   `Sent invoice #${invoiceNumber} — ${projectName}${job.billToName ? ` (${job.billToName})` : ''} to ${job.email} (${source === 'friday_auto' ? 'Friday auto-send' : 'Send All Queued'})`,
          timestamp: admin.firestore.Timestamp.now(),
        });

        sentJobs.push({ id: job.id, projectName });
        console.log('[processInvoiceQueue] Sent invoice for', job.id);
      } catch (err) {
        console.error('[processInvoiceQueue] Failed for', jobDoc.id, '—', err.message);
        failedJobs.push({ id: job.id, projectName, error: err.message });
        try {
          await db.collection('activityLog').add({
            action:    'invoice_email_failed',
            details:   `Invoice #${job.invoiceNumber || '—'} — ${projectName} — Error: ${err.message}`,
            timestamp: admin.firestore.Timestamp.now(),
          });
        } catch (logErr) {
          console.warn('[processInvoiceQueue] activityLog write failed:', logErr.message);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return { total: snap.docs.length, sent: sentJobs.length, failed: failedJobs.length, sentJobs, failedJobs };
}

async function notifyKleodianBatchResult(result) {
  const user = await findUserByNameFragment('Kleodian');
  if (!user) {
    console.log('[notifyKleodianBatchResult] No Kleodian user with a pushToken — skipping push.');
    return;
  }

  const n = result.sent;
  const m = result.failed;
  let title, body;
  if (m === 0) {
    const names = result.sentJobs.map((j) => j.projectName).join(', ');
    title = '📬 Invoices Sent';
    body  = `${n} invoice${n === 1 ? '' : 's'} automatically sent — ${names}`;
  } else {
    title = '📬 Invoices Sent (with errors)';
    body  = `${n} sent, ${m} failed — check activity log`;
  }

  await sendExpoPush([{
    to:    user.pushToken,
    title,
    body,
    data:  { type: 'invoice_batch_send', sent: n, failed: m },
  }]);
}

async function logBatchToActivityLog(result, source) {
  const label   = source === 'friday_auto' ? 'Friday auto-send' : 'Send All Queued';
  const details = result.failed === 0
    ? `${label}: ${result.sent} invoice${result.sent === 1 ? '' : 's'} sent successfully.`
    : `${label}: ${result.sent} sent, ${result.failed} failed. Failures: ${result.failedJobs.map((j) => `${j.projectName} (${j.error})`).join('; ')}`;

  await db.collection('activityLog').add({
    action:    'invoice_batch_send',
    details,
    timestamp: admin.firestore.Timestamp.now(),
  });
}

exports.fridayInvoiceSend = onSchedule(
  { schedule: '0 8 * * 5', timeZone: 'America/Chicago', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    console.log('[fridayInvoiceSend] Checking for Invoice Ready jobs...');
    const result = await processInvoiceQueue('friday_auto');
    if (result.total === 0) {
      console.log('[fridayInvoiceSend] No Invoice Ready jobs — nothing to do.');
      return;
    }
    console.log(`[fridayInvoiceSend] Sent ${result.sent}, failed ${result.failed} of ${result.total}.`);
    await notifyKleodianBatchResult(result);
    await logBatchToActivityLog(result, 'friday_auto');
  },
);

exports.sendQueuedInvoices = onCall(
  { timeoutSeconds: 540, memory: '1GiB', cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const result = await processInvoiceQueue('manual_batch');
    if (result.total > 0) {
      await notifyKleodianBatchResult(result);
      await logBatchToActivityLog(result, 'manual_batch');
    }
    return result;
  },
);
