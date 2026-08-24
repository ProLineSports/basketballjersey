// app/api/user/export/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import { ensureBuilderUser } from '@/lib/builder-user';

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
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdmin = getAdminClient();

    // Make this endpoint safe even if it is the first authenticated API request
    // a brand-new account makes, and synchronize Clerk identity details.
    try {
      await ensureBuilderUser(supabaseAdmin, userId);
    } catch (ensureUserError) {
      console.error('Export user init error:', {
        userId,
        code: ensureUserError?.code,
        message: ensureUserError?.message,
      });
      return Response.json({ error: 'Failed to initialize account' }, { status: 500 });
    }

    // One Postgres transaction locks the user row, checks Unlimited, consumes
    // paid-before-free, and records the transaction ledger entry.
    const { data, error } = await supabaseAdmin.rpc('consume_export_credit', {
      p_user_id: userId,
    });

    if (error) {
      console.error('Export credit RPC error:', {
        userId,
        code: error.code,
        message: error.message,
      });
      return Response.json({ error: 'Failed to authorize export' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (!result || typeof result !== 'object') {
      return Response.json(
        { error: 'Invalid export authorization response' },
        { status: 500 }
      );
    }

    if (result.allowed !== true) {
      const isMissingUser = result.error === 'User not found';

      return Response.json(
        {
          allowed: false,
          error: result.error || 'No credits remaining',
          freeCredits: Number(result.freeCredits || 0),
          paidCredits: Number(result.paidCredits || 0),
          isUnlimited: result.isUnlimited === true,
        },
        {
          status: isMissingUser ? 404 : 402,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        }
      );
    }

    return Response.json(
      {
        allowed: true,
        hasWatermark: result.hasWatermark === true,
        isUnlimited: result.isUnlimited === true,
        freeCredits: Number(result.freeCredits || 0),
        paidCredits: Number(result.paidCredits || 0),
      },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      }
    );
  } catch (err) {
    console.error('Export route error:', err);
    return Response.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
