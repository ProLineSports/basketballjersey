// app/api/user/export/route.js
import { auth } from '@clerk/nextjs/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('free_credits, paid_credits, is_unlimited')
    .eq('id', userId)
    .single();

  if (error) return Response.json({ error: 'User not found' }, { status: 404 });

  // Unlimited subscribers — always allow, no watermark
  if (user.is_unlimited) {
    return Response.json({ allowed: true, hasWatermark: false });
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

  // Log the usage
  await supabaseAdmin.from('credit_transactions').insert({
    user_id: userId, type: 'used', amount: -1,
    description: usePaid ? 'Export (paid credit)' : 'Export (free credit)'
  });

  return Response.json({
    allowed:      true,
    hasWatermark: !usePaid,  // watermark only if using free credits
    freeCredits:  usePaid ? user.free_credits : newValue,
    paidCredits:  usePaid ? newValue : user.paid_credits,
  });
}
