'use client';
import { useRouter } from 'next/navigation';
import { useUser, UserButton } from '@clerk/nextjs';
import { useEffect, useState } from 'react';

export default function ProductSelector() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();
  const [hovered, setHovered] = useState(null);

  const products = [
    {
      id: 'jersey',
      label: 'JERSEY BUILDER',
      description: 'Customize basketball jerseys with colors, trim, logos and patterns.',
      status: 'LIVE',
      href: '/jersey',
      icon: '🏀',
    },
    {
      id: 'helmet',
      label: 'HELMET BUILDER',
      description: 'Design football helmets in 3D with finishes, decals and colors.',
      status: 'BETA',
      href: '/helmet',
      icon: '🏈',
    },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: '#1f1c1e',
      fontFamily: "'Barlow', 'Arial Narrow', sans-serif",
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        background: '#161314',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        padding: '0 24px',
        height: 52,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/ProLine-PFP-New.jpg" alt="ProLine" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover' }} />
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 16, letterSpacing: '0.06em' }}>PROLINE BUILDER</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isLoaded && (isSignedIn
            ? <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: { width: 28, height: 28 } } }} />
            : <span style={{ fontSize: 11, color: '#6b7280' }}>Sign in via a builder</span>
          )}
        </div>
      </div>

      {/* Hero */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px' }}>
        <div style={{ marginBottom: 8, fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.15em', color: '#efff00', fontWeight: 700 }}>PROLINE MOCKUPS</div>
        <h1 style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 'clamp(36px, 6vw, 72px)', letterSpacing: '0.04em', textAlign: 'center', margin: '0 0 12px', lineHeight: 1 }}>
          BUILD YOUR UNIFORM
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 60, textAlign: 'center', maxWidth: 400 }}>
          Choose a product to start customizing. Export high-resolution mockups in seconds.
        </p>

        {/* Product cards */}
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 800, width: '100%' }}>
          {products.map(product => (
            <button
              key={product.id}
              onClick={() => router.push(product.href)}
              onMouseEnter={() => setHovered(product.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                background: hovered === product.id ? 'rgba(239,255,0,0.08)' : 'rgba(255,255,255,0.03)',
                border: hovered === product.id ? '1px solid rgba(239,255,0,0.4)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 16,
                padding: '40px 48px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 16,
                flex: '1 1 280px',
                maxWidth: 340,
                transition: 'all 0.15s ease',
                transform: hovered === product.id ? 'translateY(-4px)' : 'none',
              }}
            >
              <div style={{ fontSize: 48, lineHeight: 1 }}>{product.icon}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 22, letterSpacing: '0.05em', color: hovered === product.id ? '#efff00' : '#e2e8f0' }}>
                  {product.label}
                </span>
                <span style={{ background: product.status === 'LIVE' ? 'rgba(16,185,129,0.15)' : 'rgba(239,255,0,0.12)', color: product.status === 'LIVE' ? '#10b981' : '#efff00', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.08em', border: `1px solid ${product.status === 'LIVE' ? 'rgba(16,185,129,0.3)' : 'rgba(239,255,0,0.25)'}`, fontFamily: "'Barlow Condensed', sans-serif" }}>
                  {product.status}
                </span>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0, textAlign: 'center', lineHeight: 1.6 }}>
                {product.description}
              </p>
              <div style={{ marginTop: 8, background: hovered === product.id ? '#efff00' : 'rgba(255,255,255,0.06)', color: hovered === product.id ? '#000' : '#9ca3af', border: 'none', borderRadius: 8, padding: '10px 28px', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: '0.06em', transition: 'all 0.15s ease' }}>
                OPEN BUILDER →
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ textAlign: 'center', padding: '20px', fontSize: 10, color: '#374151', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.08em' }}>
        PROLINE MOCKUPS · PROLINEMOCKUPS.COM
      </div>
    </div>
  );
}
