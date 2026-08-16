// app/api/stripe/checkout/route.js
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

    const body = await req.json();
    const { priceId } = body;
    const returnPath = ALLOWED_RETURN_PATHS.has(body.returnPath) ? body.returnPath : '/helmet';

    if (!priceId) return Response.json({ error: 'Missing priceId' }, { status: 400 });

    const validPrices = [
      process.env.STRIPE_PRICE_UNLIMITED,
      process.env.STRIPE_PRICE_5_CREDITS,
      process.env.STRIPE_PRICE_15_CREDITS,
      process.env.STRIPE_PRICE_50_CREDITS,
    ].filter(Boolean);

    if (!validPrices.includes(priceId)) {
      return Response.json({ error: 'Invalid price ID' }, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
    if (!appUrl) throw new Error('Missing NEXT_PUBLIC_APP_URL');

    const supabaseAdmin = getAdminClient();

    // Ensure the Builder account exists before creating a Stripe checkout.
    const { error: ensureUserError } = await supabaseAdmin.rpc('get_or_create_builder_user', {
      p_user_id: userId,
    });
    if (ensureUserError) throw ensureUserError;

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('stripe_customer_id, is_unlimited')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // Enforce Unlimited status on the server as well as in the UI.
    if (user?.is_unlimited) {
      return Response.json(
        { error: 'Unlimited plan already active', code: 'ALREADY_UNLIMITED' },
        { status: 409 }
      );
    }

    let customerId = user?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { clerk_user_id: userId },
      });

      // Only set the customer if it is still NULL. This prevents two simultaneous
      // checkout requests from permanently assigning two Stripe customers.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId)
        .is('stripe_customer_id', null)
        .select('stripe_customer_id')
        .maybeSingle();

      if (claimError) {
        try { await stripe.customers.del(customer.id); } catch {}
        throw claimError;
      }

      if (claimed?.stripe_customer_id) {
        customerId = claimed.stripe_customer_id;
      } else {
        // Another request won the race. Use the already-assigned customer and
        // clean up the unused Stripe customer we just created.
        const { data: current, error: currentError } = await supabaseAdmin
          .from('users')
          .select('stripe_customer_id')
          .eq('id', userId)
          .single();
        if (currentError || !current?.stripe_customer_id) throw currentError || new Error('Could not resolve Stripe customer');
        customerId = current.stripe_customer_id;
        try { await stripe.customers.del(customer.id); } catch {}
      }
    }

    const isSubscription = priceId === process.env.STRIPE_PRICE_UNLIMITED;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isSubscription ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}${returnPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}${returnPath}?checkout=canceled`,
      metadata: { clerk_user_id: userId, price_id: priceId, return_path: returnPath },
      ...(isSubscription
        ? { subscription_data: { metadata: { clerk_user_id: userId } } }
        : { payment_intent_data: { metadata: { clerk_user_id: userId } } }),
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return Response.json({ error: 'Unable to start checkout' }, { status: 500 });
  }
}
