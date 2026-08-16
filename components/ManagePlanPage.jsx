'use client';

import { useEffect, useMemo, useState } from 'react';

export function PlanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path
        d="M4 7.5h16v10H4zM7 4.5h10v3H7z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M8 12h8M8 15h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function ManagePlanPage({
  isUnlimited,
  credits,
  paidCredits,
  refreshCredits,
  returnPath = '/helmet',
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    refreshCredits?.().catch?.((err) => {
      console.error('Manage Plan entitlement refresh failed:', err);
    });
  }, [refreshCredits]);

  const freeCredits = useMemo(() => {
    if (isUnlimited) return 0;
    return Math.max(0, Number(credits || 0) - Number(paidCredits || 0));
  }, [credits, paidCredits, isUnlimited]);

  const currentPlan = isUnlimited
    ? 'Unlimited Monthly'
    : Number(paidCredits || 0) > 0
      ? 'Pay As You Go'
      : 'Free';

  const startUnlimitedCheckout = async () => {
    if (busy) return;
    setBusy('upgrade');
    setError('');

    try {
      const priceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED;
      if (!priceId) throw new Error('Unlimited plan price is not configured.');

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, returnPath }),
      });

      const data = await res.json();

      if (res.status === 409 && data?.code === 'ALREADY_UNLIMITED') {
        await refreshCredits?.();
        return;
      }

      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Unable to start checkout.');
      }

      window.location.href = data.url;
    } catch (err) {
      console.error('Manage Plan checkout error:', err);
      setError(err?.message || 'Unable to start checkout.');
      setBusy('');
    }
  };

  const openBillingPortal = async () => {
    if (busy) return;
    setBusy('portal');
    setError('');

    // The Builder itself can be embedded inside the ProLine site. Stripe explicitly
    // does not allow the hosted Customer Portal to render inside an iframe, so open
    // a real top-level tab synchronously from the user's click. Opening it before
    // the async fetch also avoids popup blockers that can reject window.open()
    // after user activation has expired.
    const portalWindow = window.open('', '_blank');

    if (!portalWindow) {
      setBusy('');
      setError('Your browser blocked the billing window. Allow pop-ups for ProLine, then try again.');
      return;
    }

    try {
      portalWindow.document.title = 'Opening Stripe billing…';
      portalWindow.document.body.style.cssText =
        'margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#171416;color:#f3f4f6;font:600 16px Arial,sans-serif;';
      portalWindow.document.body.textContent = 'Opening secure billing…';
    } catch {}

    try {
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnPath }),
      });
      const data = await res.json();

      if (!res.ok || !data?.url) {
        try { portalWindow.close(); } catch {}
        throw new Error(data?.error || 'Unable to open billing management.');
      }

      // Navigate the new top-level browsing context instead of the embedded Builder
      // frame. This is required for billing.stripe.com.
      portalWindow.location.replace(data.url);
      setBusy('');
    } catch (err) {
      try { portalWindow.close(); } catch {}
      console.error('Manage Plan portal error:', err);
      setError(err?.message || 'Unable to open billing management.');
      setBusy('');
    }
  };

  const card = {
    border: '1px solid rgba(127,127,127,0.22)',
    borderRadius: 12,
    padding: 16,
    background: 'rgba(127,127,127,0.055)',
  };

  const statLabel = {
    fontSize: 11,
    color: '#9ca3af',
    marginBottom: 3,
  };

  const buttonBase = {
    width: '100%',
    borderRadius: 8,
    padding: '11px 14px',
    fontWeight: 800,
    fontSize: 13,
    cursor: busy ? 'wait' : 'pointer',
    fontFamily: "'Barlow Condensed', Arial, sans-serif",
    letterSpacing: '0.04em',
  };

  return (
    <div style={{ width: '100%', maxWidth: 520, padding: '4px 2px 8px', color: '#f3f4f6' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 21, fontWeight: 850, marginBottom: 5 }}>Manage Plan</div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: '#9ca3af' }}>
          View your Builder entitlement, available export credits, and subscription options.
        </div>
      </div>

      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={statLabel}>CURRENT PLAN</div>
            <div style={{ fontSize: 19, fontWeight: 900, color: '#f9fafb' }}>{currentPlan}</div>
          </div>
          <div
            style={{
              borderRadius: 999,
              padding: '5px 9px',
              fontSize: 10,
              fontWeight: 850,
              background: isUnlimited ? 'rgba(16,185,129,0.12)' : 'rgba(127,127,127,0.09)',
              border: isUnlimited ? '1px solid rgba(16,185,129,0.30)' : '1px solid rgba(127,127,127,0.18)',
              color: isUnlimited ? '#34d399' : '#d1d5db',
            }}
          >
            {isUnlimited ? 'ACTIVE' : 'STANDARD'}
          </div>
        </div>

        {isUnlimited ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={statLabel}>EXPORTS</div>
              <div style={{ fontSize: 16, fontWeight: 850, color: '#f9fafb' }}>Unlimited</div>
            </div>
            <div>
              <div style={statLabel}>WATERMARK</div>
              <div style={{ fontSize: 16, fontWeight: 850, color: '#f9fafb' }}>None</div>
            </div>
            <div style={{ gridColumn: '1 / -1', marginTop: 3, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
              Purchased credits on file: <strong style={{ color:'#e5e7eb' }}>{Number(paidCredits || 0)}</strong>. They are preserved while Unlimited is active.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <div style={statLabel}>TOTAL CREDITS</div>
              <div style={{ fontSize: 18, fontWeight: 900, color:'#f9fafb' }}>{Number(credits || 0)}</div>
            </div>
            <div>
              <div style={statLabel}>PURCHASED</div>
              <div style={{ fontSize: 18, fontWeight: 900, color:'#f9fafb' }}>{Number(paidCredits || 0)}</div>
            </div>
            <div>
              <div style={statLabel}>FREE</div>
              <div style={{ fontSize: 18, fontWeight: 900, color:'#f9fafb' }}>{freeCredits}</div>
            </div>
          </div>
        )}
      </div>

      {isUnlimited ? (
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#f9fafb' }}>Subscription billing</div>
          <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
            Open Stripe's secure billing portal to update your payment method, view invoices, or cancel your Unlimited subscription.
          </div>
          <button
            type="button"
            onClick={openBillingPortal}
            disabled={!!busy}
            style={{
              ...buttonBase,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.28)',
              color: '#f87171',
            }}
          >
            {busy === 'portal' ? 'OPENING BILLING…' : 'MANAGE / CANCEL SUBSCRIPTION'}
          </button>
        </div>
      ) : (
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#f9fafb' }}>Upgrade to Unlimited</div>
          <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
            Get unlimited watermark-free Builder exports for $4.99 per month. Cancel anytime.
          </div>
          <button
            type="button"
            onClick={startUnlimitedCheckout}
            disabled={!!busy}
            style={{
              ...buttonBase,
              background: 'linear-gradient(135deg,#efff00,#c8d900)',
              border: 'none',
              color: '#000',
            }}
          >
            {busy === 'upgrade' ? 'OPENING CHECKOUT…' : 'UPGRADE TO UNLIMITED — $4.99/MO'}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 10,
            padding: '9px 11px',
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.25)',
            background: 'rgba(239,68,68,0.07)',
            color: '#ef4444',
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
