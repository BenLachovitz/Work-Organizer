/**
 * send-notifications -- fires the weekly broadcast, the two deadline
 * reminders, and a manager-triggered "roster published" broadcast
 * (spec 12.10, migration 43).
 *
 * The first three types are invoked exclusively by pg_cron's
 * notification_tick (via pg_net), authenticated by a shared secret in a
 * custom header -- there is no end-user session to check for a cron job.
 * roster_published is different: a manager presses a real button in their
 * browser, so it is ALSO reachable with a valid manager JWT, re-checked
 * server-side via is_manager() (same pattern as generate-schedule) -- never
 * trusting the client's own opinion of its role. A manager JWT unlocks ONLY
 * roster_published; the cron-only types stay cron-secret-only even for a
 * manager's own browser session.
 *
 * The three cron types are idempotent (claim_notification_send, migration
 * 40) and deduped to one 'sent' row per (type, week, guard) ever.
 * roster_published is deliberately NOT deduped that way -- a manager who
 * republishes a correction later in the same week may want to announce
 * again -- see migration 43's narrowed partial unique index. Every outcome,
 * for every type, is still logged to notification_log.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type NotificationType = 'broadcast' | 'reminder_24h' | 'reminder_2h' | 'roster_published';
const OFFSET_HOURS: Record<'reminder_24h' | 'reminder_2h', number> = {
  reminder_24h: 24,
  reminder_2h: 2,
};

// All three cron types exist to get a guard to submit, so they click
// straight through to the submission form. roster_published sensibly points
// at the roster instead. Carried in the payload (not hardcoded in the
// service worker) so a future type needs no new client-side branch.
const TARGET_URL: Record<NotificationType, string> = {
  broadcast: '/preferences',
  reminder_24h: '/preferences',
  reminder_2h: '/preferences',
  roster_published: '/roster',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function formatIsraelParts(iso: string) {
  const d = new Date(iso);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;
  // Intl gives us the weekday NAME, not a 0-6 index -- deriving the index
  // straight from the formatted parts avoids a second, separately-computed
  // "what weekday is this in Israel" conversion that could disagree with it.
  const weekdayShort = parts.find((p) => p.type === 'weekday')!.value; // 'Sun'..'Sat'
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);
  return { weekday: HEBREW_WEEKDAYS[idx] ?? weekdayShort, time: `${hour}:${minute}` };
}

/**
 * Sends one push payload to every subscription a guard/manager has, prunes
 * dead ones (404/410), and records the outcome against an already-claimed
 * (or already-inserted) notification_log row. Shared by every type so the
 * webpush/prune/log-outcome logic exists exactly once.
 */
async function sendToTarget(
  admin: SupabaseClient,
  targetId: string,
  title: string,
  bodyText: string,
  tag: string,
  targetUrl: string,
  logId: number,
): Promise<boolean> {
  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('guard_id', targetId);

  if (!subs || subs.length === 0) {
    await admin.from('notification_log').update({ status: 'skipped_no_subscription' }).eq('id', logId);
    return false;
  }

  let delivered = false;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body: bodyText, tag, url: targetUrl }),
        { TTL: 3600 },
      );
      delivered = true;
    } catch (e) {
      const statusCode = (e as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Dead subscription -- the browser/device is gone or unsubscribed.
        await admin.from('push_subscriptions').delete().eq('id', sub.id);
      }
      // One dead device among several shouldn't sink the whole target's send.
    }
  }

  if (!delivered) {
    await admin.from('notification_log')
      .update({ status: 'failed', detail: 'all subscriptions failed or were pruned' })
      .eq('id', logId);
  }
  return delivered;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  if (!url || !serviceKey || !anonKey || !vapidPublic || !vapidPrivate || !vapidSubject) {
    return json({ error: 'server misconfigured' }, 500);
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  let payload: { type?: NotificationType; week_start?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const type = payload.type;
  if (type !== 'broadcast' && type !== 'reminder_24h' && type !== 'reminder_2h' && type !== 'roster_published') {
    return json({ error: 'unknown type' }, 400);
  }

  // --- authorise --------------------------------------------------------
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  const hasCronAuth = Boolean(cronSecret) && req.headers.get('x-cron-secret') === cronSecret;

  let isManagerCaller = false;
  if (!hasCronAuth) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (authHeader) {
      // Runs as the CALLER, so is_manager() applies exactly as it would for
      // a direct query -- a forged role claim in the request body is
      // irrelevant, since the role is read from the database using the
      // caller's own JWT (same pattern as generate-schedule).
      const asCaller = createClient(url, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data } = await asCaller.rpc('is_manager');
      isManagerCaller = data === true;
    }
  }

  // The cron secret authorises every type. A manager JWT authorises ONLY
  // roster_published -- a manager's own logged-in browser must not be able
  // to manually fire the deadline reminders just by having a valid session.
  if (!hasCronAuth && !(isManagerCaller && type === 'roster_published')) {
    return json({ error: 'forbidden' }, 403);
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // ==========================================================================
  // roster_published -- a manager-chosen, already-published week, not "the
  // open week" the three cron types resolve for themselves.
  // ==========================================================================
  if (type === 'roster_published') {
    const weekStart = payload.week_start;
    if (!weekStart) return json({ error: 'week_start required' }, 400);

    const { data: isPublished } = await admin.rpc('is_week_published', { p_week_start: weekStart });
    if (!isPublished) return json({ error: 'week is not published' }, 400);

    const title = 'הסידור פורסם';
    const bodyText = 'סידור המשמרות עודכן ופורסם, אפשר לצפות בו באפליקציה.';
    const targetUrl = TARGET_URL.roster_published;

    const { data: targets } = await admin.rpc('broadcast_targets');

    let sent = 0;
    for (const row of targets ?? []) {
      const guardId = row.guard_id as string;

      // No claim_notification_send here, deliberately -- a manager can press
      // this again after republishing a correction, and each press is a
      // genuine, distinct decision, not a duplicate to suppress (migration 43
      // narrowed the unique index to allow it).
      const { data: logRow } = await admin
        .from('notification_log')
        .insert({
          notification_type: type, week_start: weekStart, guard_id: guardId,
          status: 'sent', sent_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (!logRow) continue; // unexpected insert failure -- skip rather than crash the whole run

      if (await sendToTarget(admin, guardId, title, bodyText, type, targetUrl, logRow.id as number)) sent++;
    }

    return json({ ok: true, sent, targets: (targets ?? []).length });
  }

  // ==========================================================================
  // The three cron-driven types (unchanged from before migration 43).
  // ==========================================================================

  // Find the target week. Deliberately NOT .maybeSingle(): "exactly one open
  // week" is a design intent, not a DB-enforced invariant -- a manager's
  // manual status override can leave two weeks open at once. Ordering by
  // week_start and taking the first picks the soonest-closing one instead of
  // erroring.
  const { data: openWeeks } = await admin
    .from('roster_weeks')
    .select('week_start, submission_deadline')
    .eq('status', 'open')
    .order('week_start', { ascending: true })
    .limit(1);

  const openWeek = openWeeks?.[0];
  if (!openWeek) {
    await admin.from('notification_log').insert({
      notification_type: type, week_start: null, guard_id: null,
      status: 'skipped_no_open_week', detail: 'no roster_weeks row with status=open',
    });
    return json({ ok: true, sent: 0, skipped: 'no_open_week' });
  }
  const weekStart = openWeek.week_start as string;
  const deadline = openWeek.submission_deadline as string;

  // Reminders only: re-verify timing against the REAL stored deadline. The
  // cron tick already checked this before calling us, but a tick and this
  // invocation are not atomic with each other, so this is the actual source
  // of truth, not a redundant formality.
  let intendedAt: string;
  if (type === 'broadcast') {
    intendedAt = deadline; // informational only -- the broadcast isn't deadline-gated
  } else {
    const offsetHours = OFFSET_HOURS[type];
    const { data: due } = await admin.rpc('reminder_due', {
      p_deadline: deadline,
      p_offset: `${offsetHours} hours`,
    });
    intendedAt = new Date(new Date(deadline).getTime() - offsetHours * 3_600_000).toISOString();
    if (!due) {
      await admin.from('notification_log').insert({
        notification_type: type, week_start: weekStart, guard_id: null,
        status: 'skipped_out_of_window',
        detail: `now() not within tolerance of ${intendedAt}`,
        intended_at: intendedAt,
      });
      return json({ ok: true, sent: 0, skipped: 'out_of_window' });
    }
  }

  let title: string;
  let bodyText: string;
  if (type === 'broadcast') {
    const { weekday, time } = formatIsraelParts(deadline);
    title = 'לוח משמרות';
    bodyText = `לשלוח אילוצים בבקשה עד יום ${weekday} בשעה ${time}`;
  } else {
    const hoursLeft = type === 'reminder_24h' ? '24 שעות' : 'שעתיים';
    title = 'תזכורת: מועד הגשה מתקרב';
    bodyText = `נותרו כ-${hoursLeft} להגשת אילוצים לשבוע הקרוב`;
  }
  const targetUrl = TARGET_URL[type];

  const { data: targets } = type === 'broadcast'
    ? await admin.rpc('broadcast_targets')
    : await admin.rpc('unsubmitted_targets', { p_week_start: weekStart });

  let sent = 0;
  for (const row of targets ?? []) {
    const guardId = row.guard_id as string;

    const claimed = await admin.rpc('claim_notification_send', {
      p_type: type, p_week_start: weekStart, p_guard_id: guardId, p_intended_at: intendedAt,
    });
    if (!claimed.data) {
      await admin.from('notification_log').insert({
        notification_type: type, week_start: weekStart, guard_id: guardId,
        status: 'skipped_already_sent', intended_at: intendedAt,
      });
      continue;
    }
    const logId = claimed.data as number;

    if (await sendToTarget(admin, guardId, title, bodyText, type, targetUrl, logId)) sent++;
  }

  return json({ ok: true, sent, targets: (targets ?? []).length });
});
