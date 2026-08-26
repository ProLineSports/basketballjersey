'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import {
  META_PIXEL_ID,
  flushPendingMetaEvents,
  getMetaConsent,
  saveMetaConsent,
  subscribeMetaConsent,
} from '../lib/meta-pixel';

const META_QUEUE_BOOTSTRAP = `
  if (!window.fbq) {
    var fbq = function() {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
  }
  if (!window.__prolineMetaPixelInitialized) {
    window.fbq('init', '${META_PIXEL_ID}');
    window.__prolineMetaPixelInitialized = true;
  }
`;

const getServerConsentSnapshot = () => 'loading';

function prepareMetaQueue() {
  if (typeof window === 'undefined') return false;

  if (!window.fbq) {
    const fbq = function metaPixelQueue() {
      fbq.callMethod
        ? fbq.callMethod.apply(fbq, arguments)
        : fbq.queue.push(arguments);
    };

    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
  }

  if (!window.__prolineMetaPixelInitialized) {
    window.fbq('init', META_PIXEL_ID);
    window.__prolineMetaPixelInitialized = true;
  }

  return true;
}

export default function MetaPixel() {
  const pathname = usePathname();
  const consent = useSyncExternalStore(
    subscribeMetaConsent,
    getMetaConsent,
    getServerConsentSnapshot
  );
  const lastTrackedPathRef = useRef(null);

  useEffect(() => {
    if (consent !== 'granted') return;
    if (!prepareMetaQueue()) return;

    flushPendingMetaEvents();
    if (lastTrackedPathRef.current === pathname) return;

    window.fbq('track', 'PageView');
    lastTrackedPathRef.current = pathname;
  }, [consent, pathname]);

  const chooseConsent = (choice) => {
    saveMetaConsent(choice);
  };

  return (
    <>
      {consent === 'granted' && (
        <>
          <Script id="proline-meta-pixel-bootstrap" strategy="afterInteractive">
            {META_QUEUE_BOOTSTRAP}
          </Script>
          <Script
            id="proline-meta-pixel-library"
            src="https://connect.facebook.net/en_US/fbevents.js"
            strategy="afterInteractive"
          />
        </>
      )}

      {consent === null && (
        <div
          role="dialog"
          aria-label="Advertising measurement preferences"
          style={{
            position: 'fixed',
            left: 16,
            right: 16,
            bottom: 16,
            zIndex: 2147483000,
            width: 620,
            maxWidth: 'calc(100vw - 32px)',
            margin: '0 auto',
            padding: '15px 16px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.18)',
            background: '#161314',
            boxShadow: '0 18px 55px rgba(0,0,0,0.62)',
            color: '#f8fafc',
            fontFamily: 'Arial, sans-serif',
          }}
        >
          <div
            style={{
              marginBottom: 6,
              color: '#ffffff',
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            Help us measure what works
          </div>
          <div
            style={{
              color: '#d3d8e0',
              fontSize: 11,
              lineHeight: 1.55,
            }}
          >
            ProLine uses advertising and analytics cookies to measure visits,
            purchases, and campaign performance. The Builder works either way.
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 12,
            }}
          >
            <button
              type="button"
              onClick={() => chooseConsent('declined')}
              style={{
                minWidth: 100,
                padding: '9px 13px',
                borderRadius: 7,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.07)',
                color: '#f8fafc',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              No thanks
            </button>
            <button
              type="button"
              onClick={() => chooseConsent('granted')}
              style={{
                minWidth: 125,
                padding: '9px 13px',
                borderRadius: 7,
                border: '1px solid #efff00',
                background: '#efff00',
                color: '#050505',
                cursor: 'pointer',
                fontWeight: 900,
              }}
            >
              Allow measurement
            </button>
          </div>
        </div>
      )}
    </>
  );
}
