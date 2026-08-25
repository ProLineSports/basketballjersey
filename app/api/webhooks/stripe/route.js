// app/api/webhooks/stripe/route.js
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CREDIT_MAP = {
  [process.env.STRIPE_PRICE_5_CREDITS]: 5,
  [process.env.STRIPE_PRICE_15_CREDITS]: 15,
  [process.env.STRIPE_PRICE_50_CREDITS]: 50,
};

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

function stripeId(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

async function applyCreditPurchase(supabaseAdmin, event, userId, credits) {
  const { data, error } = await supabaseAdmin.rpc('process_credit_purchase', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_user_id: userId,
    p_credits: credits,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function applyLifetimeAllAccess({
  supabaseAdmin,
  event,
  session,
  userId,
  priceId,
}) {
  const { data, error } = await supabaseAdmin.rpc(
    'process_lifetime_all_access_purchase',
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_user_id: userId,
      p_customer_id: stripeId(session.customer),
      p_checkout_session_id: session.id || null,
      p_payment_intent_id: stripeId(session.payment_intent),
      p_price_id: priceId,
    }
  );

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function scheduleSupersededMonthlyCancellation(supabaseAdmin, userId) {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('stripe_subscription_id')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;

    const subscriptionId = user?.stripe_subscription_id || null;
    if (!subscriptionId) return { scheduled: false, reason: 'no_subscription' };

    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      if (err?.code === 'resource_missing' || err?.statusCode === 404) {
        return { scheduled: false, reason: 'subscription_missing' };
      }
      throw err;
    }

    if (
      subscription.status === 'canceled' ||
      subscription.cancel_at_period_end === true
    ) {
      return { scheduled: false, reason: 'already_ending' };
    }

    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      metadata: {
        superseded_by: 'lifetime_all_access',
      },
    });

    return { scheduled: true, subscriptionId };
  } catch (err) {
    // Lifetime fulfillment must never fail just because an older recurring plan
    // could not be scheduled for cancellation. Log it so support can follow up.
    console.warn('Could not schedule superseded Unlimited subscription cancellation:', {
      userId,
      message: err?.message,
    });
    return { scheduled: false, reason: 'error' };
  }
}

async function applySubscriptionState({
  supabaseAdmin,
  event,
  userId,
  customerId,
  subscriptionId,
  status,
}) {
  const { data, error } = await supabaseAdmin.rpc('process_subscription_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_user_id: userId || null,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_status: status,
    p_event_created: Number(event.created || 0),
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function POST(req) {
  const body = await req.text();
  const signature = req.headers.get('stripe-signature');

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return Response.json(
      { error: 'Invalid webhook signature' },
      { status: 400 }
    );
  }

  try {
    const supabaseAdmin = getAdminClient();

    // ── CHECKOUT FULFILLMENT ─────────────────────────────────────────────────
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object;
      const userId = session.metadata?.clerk_user_id || null;
      const priceId = session.metadata?.price_id || null;

      if (!userId || !priceId) {
        console.warn('Checkout event missing Builder metadata:', {
          eventId: event.id,
          sessionId: session.id,
        });
        return Response.json({
          received: true,
          ignored: 'missing_metadata',
        });
      }

      const paymentReady =
        session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required';

      if (!paymentReady && event.type === 'checkout.session.completed') {
        return Response.json({
          received: true,
          awaitingPayment: true,
        });
      }

      if (priceId === process.env.STRIPE_PRICE_LIFETIME_ALL_ACCESS) {
        const result = await applyLifetimeAllAccess({
          supabaseAdmin,
          event,
          session,
          userId,
          priceId,
        });

        const cancellation = await scheduleSupersededMonthlyCancellation(
          supabaseAdmin,
          userId
        );

        return Response.json({
          received: true,
          lifetimeAllAccessPurchase: true,
          processed: result?.processed === true,
          alreadyProcessed: result?.alreadyProcessed === true,
          lifetimeAllAccess: result?.lifetimeAllAccess === true,
          supersededSubscriptionCancellationScheduled: cancellation?.scheduled === true,
        });
      }

      const purchasedCredits = CREDIT_MAP[priceId];

      if (purchasedCredits) {
        const result = await applyCreditPurchase(
          supabaseAdmin,
          event,
          userId,
          purchasedCredits
        );

        return Response.json({
          received: true,
          creditPurchase: true,
          processed: result?.processed === true,
          alreadyProcessed: result?.alreadyProcessed === true,
        });
      }

      if (priceId === process.env.STRIPE_PRICE_UNLIMITED) {
        const subscriptionId = stripeId(session.subscription);
        const customerId = stripeId(session.customer);

        if (!subscriptionId || !customerId) {
          throw new Error(
            'Unlimited checkout missing Stripe customer or subscription ID'
          );
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        const result = await applySubscriptionState({
          supabaseAdmin,
          event,
          userId,
          customerId,
          subscriptionId,
          status: subscription.status,
        });

        return Response.json({
          received: true,
          subscriptionCheckout: true,
          processed: result?.processed === true,
          alreadyProcessed: result?.alreadyProcessed === true,
          staleEvent: result?.staleEvent === true,
          isUnlimited: result?.isUnlimited === true,
          status: result?.status || subscription.status,
        });
      }

      console.warn('Checkout event has unknown price ID:', {
        eventId: event.id,
        priceId,
      });

      return Response.json({
        received: true,
        ignored: 'unknown_price',
      });
    }

    // ── LIFETIME REFUND REVOCATION ────────────────────────────────────────────
    if (event.type === 'charge.refunded') {
      const charge = event.data.object;

      // Only a FULL refund revokes Lifetime access. Partial goodwill refunds keep
      // the entitlement intact.
      if (Number(charge.amount_refunded || 0) < Number(charge.amount || 0)) {
        return Response.json({ received: true, ignored: 'partial_refund' });
      }

      const paymentIntentId = stripeId(charge.payment_intent);
      if (!paymentIntentId) {
        return Response.json({ received: true, ignored: 'refund_without_payment_intent' });
      }

      // This Stripe account can contain non-Builder products. Match the payment
      // intent to a Builder Lifetime purchase before claiming or mutating anything.
      const { data: lifetimeUser, error: lookupError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('lifetime_stripe_payment_intent_id', paymentIntentId)
        .maybeSingle();

      if (lookupError) throw lookupError;
      if (!lifetimeUser?.id) {
        return Response.json({ received: true, ignored: 'non_builder_lifetime_refund' });
      }

      const { data, error } = await supabaseAdmin.rpc(
        'process_lifetime_all_access_refund',
        {
          p_event_id: event.id,
          p_event_type: event.type,
          p_user_id: lifetimeUser.id,
          p_customer_id: stripeId(charge.customer),
        }
      );

      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;

      return Response.json({
        received: true,
        lifetimeAllAccessRefund: true,
        processed: result?.processed === true,
        alreadyProcessed: result?.alreadyProcessed === true,
        lifetimeAllAccess: result?.lifetimeAllAccess === true,
      });
    }

    // ── SUBSCRIPTION LIFECYCLE ────────────────────────────────────────────────
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      const customerId = stripeId(subscription.customer);
      const userId = subscription.metadata?.clerk_user_id || null;

      if (!subscriptionId || !customerId) {
        throw new Error(
          'Subscription event missing Stripe customer or subscription ID'
        );
      }

      let effectiveStatus = subscription.status;

      if (event.type !== 'customer.subscription.deleted') {
        try {
          const current = await stripe.subscriptions.retrieve(subscriptionId);
          effectiveStatus = current.status;
        } catch (err) {
          if (err?.code === 'resource_missing') {
            effectiveStatus = 'canceled';
          } else {
            throw err;
          }
        }
      } else {
        effectiveStatus = 'canceled';
      }

      const result = await applySubscriptionState({
        supabaseAdmin,
        event,
        userId,
        customerId,
        subscriptionId,
        status: effectiveStatus,
      });

      return Response.json({
        received: true,
        subscriptionEvent: true,
        processed: result?.processed === true,
        alreadyProcessed: result?.alreadyProcessed === true,
        staleEvent: result?.staleEvent === true,
        isUnlimited: result?.isUnlimited === true,
        status: result?.status || effectiveStatus,
      });
    }

    return Response.json({
      received: true,
      ignored: 'unhandled_event',
    });
  } catch (err) {
    console.error('Stripe webhook processing error:', {
      eventId: event.id,
      eventType: event.type,
      message: err.message,
    });

    return Response.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
