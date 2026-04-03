// app/api/user/credits/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Create admin client inline to ensure env vars are loaded
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing Supabase env vars');
      return Response.json({ error: 'Server config error' }, { status: 500 });
    }

    // Get or create user record
    let { data: user, error } = await supabaseAdmin
      .from('users')
      .select('free_credits, paid_credits, is_unlimited')
      .eq('id', userId)
      .single();

    console.log('Credits fetch:', { userId, user, errorCode: error?.code });

    if (error && error.code === 'PGRST116') {
      // User doesn't exist — create with 3 free credits
      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert({ id: userId, free_credits: 3, paid_credits: 0 })
        .select('free_credits, paid_credits, is_unlimited')
        .single();

      console.log('User created:', { newUser, createError: createError?.message });

      if (createError) return Response.json({ error: 'Failed to create user', detail: createError.message }, { status: 500 });
      user = newUser;

      await supabaseAdmin.from('credit_transactions').insert({
        user_id: userId, type: 'free', amount: 3, description: 'Welcome credits'
      });
    } else if (error) {
      console.error('Supabase error:', error);
      return Response.json({ error: 'Database error', detail: error.message }, { status: 500 });
    }

    return Response.json({
      freeCredits:  user.free_credits,
      paidCredits:  user.paid_credits,
      isUnlimited:  user.is_unlimited,
      totalCredits: user.is_unlimited ? 999 : user.free_credits + user.paid_credits,
      hasWatermark: !user.is_unlimited && user.paid_credits === 0,
    });

  } catch (err) {
    console.error('Credits route error:', err);
    return Response.json({ error: 'Unexpected error', detail: err.message }, { status: 500 });
  }
}
