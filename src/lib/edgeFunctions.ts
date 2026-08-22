import { requireSupabase } from '@/lib/supabase';

/**
 * Calls a Supabase Edge Function and surfaces ITS error message.
 *
 * supabase-js reports any non-2xx as a generic "Edge Function returned a
 * non-2xx status code" and leaves `data` null, which would hide every useful
 * Hebrew message the function actually produces ("הקוד כבר רשום", "יותר מדי
 * ניסיונות" ...). The real body hangs off error.context, so it's read back
 * out here -- one shared implementation instead of the near-identical copy
 * every caller (claim-code, reset-pin, request-pin-reset) used to carry.
 */
export async function invokeEdgeFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke<T>(name, { body });
  if (!error) return data as T;

  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = (await ctx.json()) as { error?: string };
      if (parsed?.error) throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e;
    }
  }
  throw new Error('שגיאת תקשורת. נסה שוב.');
}
