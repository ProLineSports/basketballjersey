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

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function processStripeMutation(supabaseAdmin, params) {
  const { data, error } = await supabaseAdmin.rpc('process_stripe_event', params);
  if (error) throw error;
  return firstRow(data);
}

export async function POST(req) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return Response.json({ error: 'Invalid webhook signature' }, { status: 400 });
  }

  try {
    const supabaseAdmin = getAdminClient();

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const userId = session.metadata?.clerk_user_id;
      const priceId = session.metadata?.price_id;

      if (!userId || !priceId) {
        console.warn('Checkout event missing metadata:', { eventId: event.id, sessionId: session.id });
        return Response.json({ received: true, ignored: 'missing_metadata' });
      }

      const credits = CREDIT_MAP[priceId];

      if (credits) {
        // With delayed payment methods, checkout.session.completed can arrive before
        // funds are paid. Wait for async_payment_succeeded in that case.
        const paymentReady = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
        if (!paymentReady && event.type === 'checkout.session.completed') {
          return Response.json({ received: true, awaitingPayment: true });
        }

        const result = await processStripeMutation(supabaseAdmin, {
          p_event_id: event.id,
          p_event_type: event.type,
          p_operation: 'credit_purchase',
          p_user_id: userId,
          p_customer_id: typeof session.customer === 'string' ? session.customer : null,
          p_credits: credits,
          p_is_unlimited: null,
        });

        return Response.json({ received: true, applied: result?.applied !== false, reason: result?.reason });
      }

      if (priceId === process.env.STRIPE_PRICE_UNLIMITED) {
        const paymentReady = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
        if (!paymentReady && event.type === 'checkout.session.completed') {
          return Response.json({ received: true, awaitingPayment: true });
        }

        const result = await processStripeMutation(supabaseAdmin, {
          p_event_id: event.id,
          p_event_type: event.type,
          p_operation: 'set_unlimited_by_user',
          p_user_id: userId,
          p_customer_id: typeof session.customer === 'string' ? session.customer : null,
          p_credits: 0,
          p_is_unlimited: true,
        });

        return Response.json({ received: true, applied: result?.applied !== false, reason: result?.reason });
      }

      console.warn('Checkout event has unknown price ID:', { eventId: event.id, priceId });
      return Response.json({ received: true, ignored: 'unknown_price' });
    }

    if (
      event.type === 'customer.subscription.created'
      || event.type === 'customer.subscription.updated'
      || event.type === 'customer.subscription.deleted'
    ) {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;

      let effectiveStatus = subscription.status;

      // Stripe doesn't guarantee webhook delivery order. For created/updated events,
      // retrieve the subscription's CURRENT status so a late older event cannot
      // accidentally restore Unlimited after a newer cancellation/unpaid transition.
      if (event.type !== 'customer.subscription.deleted') {
        try {
          const currentSubscription = await stripe.subscriptions.retrieve(subscription.id);
          effectiveStatus = currentSubscription.status;
        } catch (statusError) {
          if (statusError?.code === 'resource_missing') effectiveStatus = 'canceled';
          else throw statusError;
        }
      } else {
        effectiveStatus = 'canceled';
      }

      // Keep access during Stripe's normal payment-recovery window (past_due), but
      // remove it once the subscription is unpaid/canceled/paused/etc.
      const keepUnlimited = ['active', 'trialing', 'past_due'].includes(effectiveStatus);

      const result = await processStripeMutation(supabaseAdmin, {
        p_event_id: event.id,
        p_event_type: event.type,
        p_operation: 'set_unlimited_by_customer',
        p_user_id: null,
        p_customer_id: customerId,
        p_credits: 0,
        p_is_unlimited: keepUnlimited,
      });

      return Response.json({ received: true, applied: result?.applied !== false, reason: result?.reason });
    }

    return Response.json({ received: true, ignored: 'unhandled_event' });
  } catch (err) {
    // Returning 500 is deliberate. Stripe will retry, and the database function's
    // transaction rolls back its event claim if fulfillment failed.
    console.error('Stripe webhook processing error:', {
      eventId: event.id,
      eventType: event.type,
      message: err.message,
    });
    return Response.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
