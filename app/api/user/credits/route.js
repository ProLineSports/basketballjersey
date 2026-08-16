// app/api/user/credits/route.js
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

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const supabaseAdmin = getAdminClient();

    // Atomic first-login creation. The Postgres function guarantees the welcome
    // credits + transaction can only be created once, even if two tabs load together.
    const { data, error } = await supabaseAdmin.rpc('get_or_create_builder_user', {
      p_user_id: userId,
    });

    if (error) {
      console.error('Credits RPC error:', { userId, code: error.code, message: error.message });
      return Response.json({ error: 'Database error' }, { status: 500 });
    }

    const user = Array.isArray(data) ? data[0] : data;
    if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

    return Response.json({
      freeCredits: user.free_credits,
      paidCredits: user.paid_credits,
      isUnlimited: user.is_unlimited,
      totalCredits: user.is_unlimited ? 999 : user.free_credits + user.paid_credits,
      hasWatermark: !user.is_unlimited && user.paid_credits === 0,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    console.error('Credits route error:', err);
    return Response.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
