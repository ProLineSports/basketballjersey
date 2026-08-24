// app/api/stripe/checkout/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ensureBuilderUser } from '@/lib/builder-user';

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
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const priceId = body.priceId;
    const returnPath = ALLOWED_RETURN_PATHS.has(body.returnPath)
      ? body.returnPath
      : '/helmet';

    if (!priceId) {
      return Response.json({ error: 'Missing priceId' }, { status: 400 });
    }

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
    if (!appUrl) {
      throw new Error('Missing NEXT_PUBLIC_APP_URL');
    }

    const supabaseAdmin = getAdminClient();

    // Creates the Builder user safely if checkout is the first authenticated action
    // and keeps the Supabase customer identity synchronized with Clerk.
    const { identity } = await ensureBuilderUser(supabaseAdmin, userId);

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select(
        'stripe_customer_id, is_unlimited, stripe_subscription_id, stripe_subscription_status'
      )
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // UI hiding is not sufficient. Prevent a direct API call from starting another
    // checkout while an Unlimited entitlement is active.
    if (user?.is_unlimited) {
      return Response.json(
        {
          error: 'Unlimited plan already active',
          code: 'ALREADY_UNLIMITED',
        },
        { status: 409 }
      );
    }

    let customerId = user?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
        metadata: { clerk_user_id: userId },
      });

      // Claim the newly created customer only if another simultaneous request
      // has not already done so.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId)
        .is('stripe_customer_id', null)
        .select('stripe_customer_id')
        .maybeSingle();

      if (claimError) {
        try {
          await stripe.customers.del(customer.id);
        } catch {}
        throw claimError;
      }

      if (claimed?.stripe_customer_id) {
        customerId = claimed.stripe_customer_id;
      } else {
        const { data: current, error: currentError } = await supabaseAdmin
          .from('users')
          .select('stripe_customer_id')
          .eq('id', userId)
          .single();

        if (currentError || !current?.stripe_customer_id) {
          throw currentError || new Error('Could not resolve Stripe customer');
        }

        customerId = current.stripe_customer_id;

        // Best-effort cleanup of the unused duplicate customer.
        try {
          await stripe.customers.del(customer.id);
        } catch {}
      }
    }

    if (customerId && (identity.email || identity.name)) {
      try {
        await stripe.customers.update(customerId, {
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.name ? { name: identity.name } : {}),
        });
      } catch (err) {
        // Customer identity sync should never block checkout.
        console.warn('Stripe customer identity sync failed:', {
          userId,
          customerId,
          message: err?.message,
        });
      }
    }

    const isSubscription =
      priceId === process.env.STRIPE_PRICE_UNLIMITED;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isSubscription ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}${returnPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}${returnPath}?checkout=canceled`,
      metadata: {
        clerk_user_id: userId,
        price_id: priceId,
        return_path: returnPath,
      },
      ...(isSubscription
        ? {
            subscription_data: {
              metadata: { clerk_user_id: userId },
            },
          }
        : {
            payment_intent_data: {
              metadata: { clerk_user_id: userId },
            },
          }),
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return Response.json(
      { error: 'Unable to start checkout' },
      { status: 500 }
    );
  }
}
