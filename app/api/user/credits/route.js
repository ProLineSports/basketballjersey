// app/api/user/credits/route.js
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

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdmin = getAdminClient();

    // Creates the Builder row + 3 welcome credits exactly once, then copies
    // the authenticated Clerk name/email into the Supabase customer row.
    // Concurrent first loads cannot duplicate the welcome grant.
    let user;
    try {
      ({ user } = await ensureBuilderUser(supabaseAdmin, userId));
    } catch (error) {
      console.error('Credits user initialization error:', {
        userId,
        code: error?.code,
        message: error?.message,
      });
      return Response.json({ error: 'Database error' }, { status: 500 });
    }
    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const freeCredits = Number(user.free_credits || 0);
    const paidCredits = Number(user.paid_credits || 0);
    const isUnlimited = user.is_unlimited === true;

    return Response.json(
      {
        freeCredits,
        paidCredits,
        isUnlimited,
        totalCredits: isUnlimited ? 999 : freeCredits + paidCredits,
        // Paid credits are intentionally consumed before free credits so any
        // remaining paid balance keeps exports watermark-free.
        hasWatermark: !isUnlimited && paidCredits === 0,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  } catch (err) {
    console.error('Credits route error:', err);
    return Response.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
