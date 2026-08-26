import 'server-only';

import { createHash } from 'node:crypto';

const META_PIXEL_ID =
  process.env.META_PIXEL_ID ||
  process.env.NEXT_PUBLIC_META_PIXEL_ID ||
  '1166261734848297';
const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v25.0';
const META_CAPI_TIMEOUT_MS = 4000;

function sha256(value) {
  if (!value) return null;
  return createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

function readCookie(req, name) {
  const cookies = req.headers.get('cookie') || '';
  const prefix = `${name}=`;
  const match = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!match) return null;

  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return match.slice(prefix.length);
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return req.headers.get('x-real-ip') || null;
}

function getEventSourceUrl(req) {
  const referer = req.headers.get('referer');
  if (referer?.startsWith('http://') || referer?.startsWith('https://')) {
    return referer;
  }

  return 'https://www.prolinemockups.com/online-builder';
}

export async function sendMetaPurchase({ req, session, product }) {
  const accessToken = process.env.META_CONVERSIONS_API_TOKEN;
  if (!accessToken) return { skipped: 'missing_access_token' };

  const eventId = `stripe_${session.id}`;
  const emailHash = sha256(session.customer_details?.email);
  const externalIdHash = sha256(session.metadata?.clerk_user_id);
  const fbp = readCookie(req, '_fbp');
  const fbc = readCookie(req, '_fbc');
  const clientIp = getClientIp(req);
  const clientUserAgent = req.headers.get('user-agent');

  const userData = {
    ...(emailHash ? { em: [emailHash] } : {}),
    ...(externalIdHash ? { external_id: [externalIdHash] } : {}),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(clientIp ? { client_ip_address: clientIp } : {}),
    ...(clientUserAgent ? { client_user_agent: clientUserAgent } : {}),
  };

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: getEventSourceUrl(req),
        user_data: userData,
        custom_data: {
          value: Number(session.amount_total || 0) / 100,
          currency: String(session.currency || 'usd').toUpperCase(),
          content_ids: [product.id],
          content_name: product.name,
          content_category: 'Helmet Builder',
          content_type: 'product',
          order_id: session.id,
        },
      },
    ],
  };

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(META_CAPI_TIMEOUT_MS),
    }
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = result?.error?.message || 'Meta rejected the event';
    throw new Error(`Meta CAPI Purchase failed (${response.status}): ${message}`);
  }

  return result;
}
