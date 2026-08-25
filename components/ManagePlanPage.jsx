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

function goToTopLevel(url) {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch {}
  window.location.href = url;
}

export default function ManagePlanPage({
  isUnlimited,
  isSubscriptionUnlimited = false,
  isLifetimeAllAccess = false,
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

  const currentPlan = isLifetimeAllAccess
    ? 'Lifetime All-Access'
    : isSubscriptionUnlimited
      ? 'Unlimited Monthly'
      : Number(paidCredits || 0) > 0
        ? 'Pay As You Go'
        : 'Free';

  const startCheckout = async (kind) => {
    if (busy) return;
    setBusy(kind);
    setError('');

    try {
      const priceId = kind === 'lifetime'
        ? process.env.NEXT_PUBLIC_STRIPE_PRICE_LIFETIME_ALL_ACCESS
        : process.env.NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED;

      if (!priceId) {
        throw new Error(
          kind === 'lifetime'
            ? 'Lifetime All-Access price is not configured.'
            : 'Unlimited plan price is not configured.'
        );
      }

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, returnPath }),
      });

      const data = await res.json();

      if (
        res.status === 409 &&
        (data?.code === 'ALREADY_UNLIMITED' || data?.code === 'ALREADY_LIFETIME_ALL_ACCESS')
      ) {
        await refreshCredits?.();
        return;
      }

      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Unable to start checkout.');
      }

      goToTopLevel(data.url);
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
          View your Builder entitlement, available export credits, and upgrade options.
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
            {isLifetimeAllAccess && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={statLabel}>BUILDER ACCESS</div>
                <div style={{ fontSize: 14, fontWeight: 850, color: '#f9fafb' }}>All current + future ProLine builders</div>
              </div>
            )}
            <div style={{ gridColumn: '1 / -1', marginTop: 3, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
              Purchased credits on file: <strong style={{ color:'#e5e7eb' }}>{Number(paidCredits || 0)}</strong>. They are preserved while unlimited access is active.
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

      {isLifetimeAllAccess ? (
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#efff00' }}>Lifetime All-Access is permanent</div>
          <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55 }}>
            No recurring Builder payment is required. Your account keeps unlimited watermark-free exports and access to future ProLine builders.
          </div>
          {isSubscriptionUnlimited && (
            <>
              <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginTop: 10, marginBottom: 10 }}>
                A previous monthly subscription is still associated with this account. Lifetime checkout automatically schedules that subscription to stop renewing; Stripe billing remains available for confirmation.
              </div>
              <button
                type="button"
                onClick={openBillingPortal}
                disabled={!!busy}
                style={{
                  ...buttonBase,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: '#e5e7eb',
                }}
              >
                {busy === 'portal' ? 'OPENING BILLING…' : 'VIEW BILLING'}
              </button>
            </>
          )}
        </div>
      ) : isSubscriptionUnlimited ? (
        <>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#f9fafb' }}>Subscription billing</div>
            <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
              Update your payment method, view invoices, or cancel your Unlimited Monthly subscription.
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

          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#efff00' }}>Upgrade permanently</div>
            <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
              Pay $49 once for Lifetime All-Access: every current and future ProLine builder, unlimited exports, and no watermark. Your monthly plan will be scheduled to stop renewing after the upgrade.
            </div>
            <button
              type="button"
              onClick={() => startCheckout('lifetime')}
              disabled={!!busy}
              style={{
                ...buttonBase,
                background: 'linear-gradient(135deg,#efff00,#c8d900)',
                border: 'none',
                color: '#000',
              }}
            >
              {busy === 'lifetime' ? 'OPENING CHECKOUT…' : 'GET LIFETIME ALL-ACCESS — $49'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 850, marginBottom: 5, color:'#f9fafb' }}>Unlimited Monthly</div>
            <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
              Get unlimited watermark-free Builder exports for $4.99 per month. Cancel anytime.
            </div>
            <button
              type="button"
              onClick={() => startCheckout('monthly')}
              disabled={!!busy}
              style={{
                ...buttonBase,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.14)',
                color: '#f3f4f6',
              }}
            >
              {busy === 'monthly' ? 'OPENING CHECKOUT…' : 'UNLIMITED MONTHLY — $4.99/MO'}
            </button>
          </div>

          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 5, color:'#efff00' }}>Lifetime All-Access</div>
            <div style={{ fontSize: 11, color:'#9ca3af', lineHeight: 1.55, marginBottom: 12 }}>
              Pay $49 once for all current and future ProLine builders, unlimited exports, and no watermark — forever.
            </div>
            <button
              type="button"
              onClick={() => startCheckout('lifetime')}
              disabled={!!busy}
              style={{
                ...buttonBase,
                background: 'linear-gradient(135deg,#efff00,#c8d900)',
                border: 'none',
                color: '#000',
              }}
            >
              {busy === 'lifetime' ? 'OPENING CHECKOUT…' : 'GET LIFETIME ALL-ACCESS — $49'}
            </button>
          </div>
        </>
      )}

      {error && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.30)',
            background: 'rgba(239,68,68,0.10)',
            color: '#fca5a5',
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
