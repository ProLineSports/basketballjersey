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
    const isSubscriptionUnlimited = user.is_unlimited === true;
    const isLifetimeAllAccess = user.lifetime_all_access === true;
    const isUnlimited = isSubscriptionUnlimited || isLifetimeAllAccess;

    return Response.json(
      {
        freeCredits,
        paidCredits,
        // Backward-compatible effective entitlement used by existing Builder UI.
        isUnlimited,
        // Explicit account states let UI distinguish recurring vs permanent access.
        isSubscriptionUnlimited,
        isLifetimeAllAccess,
        accessLevel: isLifetimeAllAccess
          ? 'lifetime_all_access'
          : isSubscriptionUnlimited
            ? 'unlimited_monthly'
            : paidCredits > 0
              ? 'pay_as_you_go'
              : 'free',
        totalCredits: isUnlimited ? 999 : freeCredits + paidCredits,
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
