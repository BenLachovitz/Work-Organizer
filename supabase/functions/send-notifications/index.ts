/**
 * send-notifications -- fires the weekly broadcast and the two deadline
 * reminders (spec 12.10). Invoked exclusively by pg_cron's notification_tick
 * (via pg_net), never by a browser.
 *
 * Deployed with --no-verify-jwt (same reasoning as claim-code) -- there is no
 * end-user session to check. In its place: a shared secret in a custom
 * header, compared against an Edge Function secret only notification_tick's
 * stored GUCs and this function know.
 *
 * Every branch is idempotent (claim_notification_send, migration 40) and
 * every outcome is logged to notification_log -- sent, or one of several
 * distinct skip reasons -- so "what fired and when" is answerable from the
 * SQL editor without touching this function's own logs.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type NotificationType = 'broadcast' | 'reminder_24h' | 'reminder_2h';
const OFFSET_HOURS: Record<'reminder_24h' | 'reminder_2h', number> = {
  reminder_24h: 24,
  reminder_2h: 2,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'forbidden' }, 403);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate || !vapidSubject) {
    return json({ error: 'server misconfigured' }, 500);
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let payload: { type?: NotificationType };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const type = payload.type;
  if (type !== 'broadcast' && type !== 'reminder_24h' && type !== 'reminder_2h') {
    return json({ error: 'unknown type' }, 400);
  }

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
  // All three types exist to get a guard to submit, so all three click
  // straight through to the submission form -- not just open the app.
  const targetUrl = '/preferences';

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

    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('guard_id', guardId);

    if (!subs || subs.length === 0) {
      await admin.from('notification_log').update({ status: 'skipped_no_subscription' }).eq('id', logId);
      continue;
    }

    let delivered = false;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title, body: bodyText, tag: type, url: targetUrl }),
          { TTL: 3600 },
        );
        delivered = true;
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Dead subscription -- the browser/device is gone or unsubscribed.
          await admin.from('push_subscriptions').delete().eq('id', sub.id);
        }
        // One dead device among several shouldn't sink the whole guard's send.
      }
    }

    if (delivered) {
      sent++;
    } else {
      await admin.from('notification_log')
        .update({ status: 'failed', detail: 'all subscriptions failed or were pruned' })
        .eq('id', logId);
    }
  }

  return json({ ok: true, sent, targets: (targets ?? []).length });
});
