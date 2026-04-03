// app/api/webhooks/stripe/route.js
import { supabaseAdmin } from '@/lib/supabase';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CREDIT_MAP = {
  [process.env.STRIPE_PRICE_5_CREDITS]:  5,
  [process.env.STRIPE_PRICE_15_CREDITS]: 15,
  [process.env.STRIPE_PRICE_50_CREDITS]: 50,
};

export async function POST(req) {
  const body = await req.text();
  const sig  = req.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return Response.json({ error: `Webhook error: ${err.message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const userId   = session.metadata?.clerk_user_id;
    const priceId  = session.metadata?.price_id;
    if (!userId) return Response.json({ received: true });

    if (CREDIT_MAP[priceId]) {
      // One-time credit purchase
      const credits = CREDIT_MAP[priceId];
      const { data: user } = await supabaseAdmin
        .from('users').select('paid_credits').eq('id', userId).single();

      await supabaseAdmin.from('users')
        .update({ paid_credits: (user?.paid_credits || 0) + credits })
        .eq('id', userId);

      await supabaseAdmin.from('credit_transactions').insert({
        user_id: userId, type: 'purchased', amount: credits,
        description: `Purchased ${credits} credits`
      });

    } else if (priceId === process.env.STRIPE_PRICE_UNLIMITED) {
      // Subscription — set unlimited flag
      await supabaseAdmin.from('users')
        .update({ is_unlimited: true })
        .eq('id', userId);
    }
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('stripe_customer_id', subscription.customer)
      .single();

    if (user) {
      await supabaseAdmin.from('users')
        .update({ is_unlimited: false })
        .eq('id', user.id);
    }
  }

  return Response.json({ received: true });
}

// Disable body parsing — Stripe needs the raw body to verify signature
export const config = { api: { bodyParser: false } };
