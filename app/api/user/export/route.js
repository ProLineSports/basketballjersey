// app/api/user/export/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('free_credits, paid_credits, is_unlimited')
      .eq('id', userId)
      .single();

    console.log('Export user:', { userId, user, error: error?.code });

    if (error) return Response.json({ error: 'User not found' }, { status: 404 });

    // Unlimited subscribers — always allow, no watermark
    if (user.is_unlimited) {
      return Response.json({ allowed: true, hasWatermark: false, isUnlimited: true });
    }

    const totalCredits = user.free_credits + user.paid_credits;
    if (totalCredits <= 0) {
      return Response.json({ allowed: false, error: 'No credits remaining' }, { status: 402 });
    }

    // Deduct from paid credits first, then free
    const usePaid = user.paid_credits > 0;
    const updateField = usePaid ? 'paid_credits' : 'free_credits';
    const newValue = usePaid ? user.paid_credits - 1 : user.free_credits - 1;

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ [updateField]: newValue })
      .eq('id', userId);

    if (updateError) return Response.json({ error: 'Failed to deduct credit' }, { status: 500 });

    await supabaseAdmin.from('credit_transactions').insert({
      user_id: userId, type: 'used', amount: -1,
      description: usePaid ? 'Export (paid credit)' : 'Export (free credit)'
    });

    return Response.json({
      allowed:      true,
      hasWatermark: !usePaid,
      isUnlimited:  false,
      freeCredits:  usePaid ? user.free_credits : newValue,
      paidCredits:  usePaid ? newValue : user.paid_credits,
    });
  } catch (err) {
    console.error('Export route error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
