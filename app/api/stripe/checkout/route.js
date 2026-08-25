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
      process.env.STRIPE_PRICE_LIFETIME_ALL_ACCESS,
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
        'stripe_customer_id, is_unlimited, lifetime_all_access, stripe_subscription_id, stripe_subscription_status'
      )
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    const isLifetimeCheckout =
      priceId === process.env.STRIPE_PRICE_LIFETIME_ALL_ACCESS;

    // Lifetime All-Access is permanent, so there is nothing else this account
    // should be able to buy through the Builder once it is active.
    if (user?.lifetime_all_access) {
      return Response.json(
        {
          error: 'Lifetime All-Access is already active',
          code: 'ALREADY_LIFETIME_ALL_ACCESS',
        },
        { status: 409 }
      );
    }

    // A monthly Unlimited customer may upgrade to Lifetime All-Access, but should
    // not be able to buy credit packs or start a second monthly subscription.
    if (user?.is_unlimited && !isLifetimeCheckout) {
      return Response.json(
        {
          error: 'Unlimited plan already active',
          code: 'ALREADY_UNLIMITED',
        },
        { status: 409 }
      );
    }

    let customerId = user?.stripe_customer_id || null;

    const isUsableStripeCustomer = async (id) => {
      if (!id) return false;

      try {
        const customer = await stripe.customers.retrieve(id);
        return !(customer && customer.deleted);
      } catch (err) {
        // A stale/deleted Stripe customer should self-heal instead of blocking
        // a repeat credit purchase.
        if (
          err?.code === 'resource_missing' ||
          err?.raw?.code === 'resource_missing' ||
          err?.statusCode === 404
        ) {
          return false;
        }
        throw err;
      }
    };

    // A previous checkout can leave Supabase pointing at a Stripe customer that
    // has since been deleted. Validate the stored ID before reusing it.
    if (customerId && !(await isUsableStripeCustomer(customerId))) {
      const staleCustomerId = customerId;

      const { error: clearError } = await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: null })
        .eq('id', userId)
        .eq('stripe_customer_id', staleCustomerId);

      if (clearError) throw clearError;
      customerId = null;
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
        metadata: { clerk_user_id: userId },
      });

      // Claim the customer if the row is still unassigned.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId)
        .is('stripe_customer_id', null)
        .select('stripe_customer_id')
        .maybeSingle();

      if (claimError) throw claimError;

      if (claimed?.stripe_customer_id) {
        customerId = claimed.stripe_customer_id;
      } else {
        // Another simultaneous checkout may have assigned a customer first.
        // Reuse it if valid. Do NOT delete either customer here: leaving a rare
        // duplicate is much safer than deleting one that another request or
        // completed Checkout Session may already reference.
        const { data: current, error: currentError } = await supabaseAdmin
          .from('users')
          .select('stripe_customer_id')
          .eq('id', userId)
          .single();

        if (currentError) throw currentError;

        if (
          current?.stripe_customer_id &&
          await isUsableStripeCustomer(current.stripe_customer_id)
        ) {
          customerId = current.stripe_customer_id;
        } else {
          // The competing value was also stale. Repair it with the valid
          // customer we just created.
          const { data: repaired, error: repairError } = await supabaseAdmin
            .from('users')
            .update({ stripe_customer_id: customer.id })
            .eq('id', userId)
            .select('stripe_customer_id')
            .single();

          if (repairError) throw repairError;
          customerId = repaired?.stripe_customer_id || customer.id;
        }
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
        entitlement: isLifetimeCheckout
          ? 'lifetime_all_access'
          : isSubscription
            ? 'unlimited_monthly'
            : 'credit_pack',
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
