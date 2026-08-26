import { auth } from '@clerk/nextjs/server';
import { after } from 'next/server';
import Stripe from 'stripe';
import { sendMetaPurchase } from '../../../../lib/meta-conversions';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getProductDetails(priceId) {
  if (priceId === process.env.STRIPE_PRICE_UNLIMITED) {
    return { id: 'unlimited_monthly', name: 'Unlimited Monthly' };
  }

  if (priceId === process.env.STRIPE_PRICE_LIFETIME_ALL_ACCESS) {
    return { id: 'lifetime_all_access', name: 'Lifetime All-Access' };
  }

  if (priceId === process.env.STRIPE_PRICE_5_CREDITS) {
    return { id: 'credits_5', name: '5 Export Credits' };
  }

  if (priceId === process.env.STRIPE_PRICE_15_CREDITS) {
    return { id: 'credits_15', name: '15 Export Credits' };
  }

  if (priceId === process.env.STRIPE_PRICE_50_CREDITS) {
    return { id: 'credits_50', name: '50 Export Credits' };
  }

  return { id: 'builder_purchase', name: 'Builder Purchase' };
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sessionId = new URL(req.url).searchParams.get('session_id');
    if (!sessionId || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
      return Response.json({ error: 'Invalid checkout session' }, { status: 400 });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.clerk_user_id !== userId) {
      return Response.json({ error: 'Checkout session not found' }, { status: 404 });
    }

    const paid =
      session.status === 'complete' &&
      (session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required');

    if (!paid) {
      return Response.json(
        { paid: false },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const product = getProductDetails(session.metadata?.price_id || '');

    if (new URL(req.url).searchParams.get('meta_consent') === 'granted') {
      after(async () => {
        try {
          await sendMetaPurchase({ req, session, product });
        } catch (error) {
          console.error(
            'Meta CAPI Purchase error:',
            error instanceof Error ? error.message : 'Unknown error'
          );
        }
      });
    }

    return Response.json(
      {
        paid: true,
        transactionId: session.id,
        eventId: `stripe_${session.id}`,
        value: Number(session.amount_total || 0) / 100,
        currency: String(session.currency || 'usd').toUpperCase(),
        product,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error?.code === 'resource_missing') {
      return Response.json({ error: 'Checkout session not found' }, { status: 404 });
    }

    console.error('Checkout status error:', error);
    return Response.json(
      { error: 'Unable to verify checkout' },
      { status: 500 }
    );
  }
}
