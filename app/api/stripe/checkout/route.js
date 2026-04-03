// app/api/stripe/checkout/route.js
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { priceId } = body;

    console.log('Checkout request:', { userId, priceId });
    console.log('Available price IDs:', {
      unlimited: process.env.STRIPE_PRICE_UNLIMITED,
      c5:  process.env.STRIPE_PRICE_5_CREDITS,
      c15: process.env.STRIPE_PRICE_15_CREDITS,
      c50: process.env.STRIPE_PRICE_50_CREDITS,
    });

    if (!priceId) return Response.json({ error: 'Missing priceId' }, { status: 400 });

    // Validate priceId is one of our known prices
    const validPrices = [
      process.env.STRIPE_PRICE_UNLIMITED,
      process.env.STRIPE_PRICE_5_CREDITS,
      process.env.STRIPE_PRICE_15_CREDITS,
      process.env.STRIPE_PRICE_50_CREDITS,
    ].filter(Boolean);

    console.log('Valid prices:', validPrices);

    if (!validPrices.includes(priceId)) {
      return Response.json({ error: 'Invalid price ID', received: priceId }, { status: 400 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Get or create Stripe customer
    let { data: user } = await supabaseAdmin
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { clerk_user_id: userId }
      });
      customerId = customer.id;
      await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    const isSubscription = priceId === process.env.STRIPE_PRICE_UNLIMITED;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isSubscription ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}?success=true`,
      cancel_url:  `${process.env.NEXT_PUBLIC_APP_URL}?canceled=true`,
      metadata: { clerk_user_id: userId, price_id: priceId },
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
