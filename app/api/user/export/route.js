// app/api/user/export/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase server configuration');
  }

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const supabaseAdmin = getAdminClient();

    // One Postgres transaction locks the user row, checks entitlement, consumes
    // paid-before-free, and writes the transaction ledger entry.
    const { data, error } = await supabaseAdmin.rpc('consume_export_credit', {
      p_user_id: userId,
    });

    if (error) {
      console.error('Export credit RPC error:', { userId, code: error.code, message: error.message });
      return Response.json({ error: 'Failed to authorize export' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result) return Response.json({ error: 'Invalid export authorization response' }, { status: 500 });

    if (!result.allowed) {
      const status = result.reason === 'user_not_found' ? 404 : 402;
      return Response.json({
        allowed: false,
        error: result.reason === 'user_not_found' ? 'User not found' : 'No credits remaining',
        reason: result.reason,
        freeCredits: result.free_credits,
        paidCredits: result.paid_credits,
        isUnlimited: result.is_unlimited,
      }, { status });
    }

    return Response.json({
      allowed: true,
      hasWatermark: result.has_watermark,
      isUnlimited: result.is_unlimited,
      freeCredits: result.free_credits,
      paidCredits: result.paid_credits,
      reason: result.reason,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    console.error('Export route error:', err);
    return Response.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
