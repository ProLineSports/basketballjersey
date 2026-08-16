// app/api/stripe/portal/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ALLOWED_RETURN_PATHS = new Set(['/helmet', '/jersey']);

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

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const returnPath = ALLOWED_RETURN_PATHS.has(body.returnPath) ? body.returnPath : '/helmet';

    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
    if (!appUrl) throw new Error('Missing NEXT_PUBLIC_APP_URL');

    const supabaseAdmin = getAdminClient();

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    if (!user?.stripe_customer_id) {
      return Response.json(
        { error: 'No Stripe billing account is associated with this Builder account.', code: 'NO_STRIPE_CUSTOMER' },
        { status: 404 }
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}${returnPath}`,
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('Stripe billing portal error:', err);
    return Response.json(
      { error: 'Unable to open billing management. Please try again.' },
      { status: 500 }
    );
  }
}
