'use client';

import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 900;
const TOAST_LIFETIME_MS = 3000;
const WATERMARK_CLASS = 'proline-builder-preview-watermark';

function hasCleanPreviewEntitlement(value) {
  if (!value || typeof value !== 'object') return false;

  const cleanBooleanKeys = new Set([
    'is_unlimited',
    'isUnlimited',
    'unlimited',
    'lifetime_all_access',
    'lifetimeAllAccess',
    'has_lifetime_all_access',
    'hasLifetimeAllAccess',
  ]);

  for (const [key, item] of Object.entries(value)) {
    if (cleanBooleanKeys.has(key) && item === true) return true;

    if (
      ['plan', 'tier', 'account_type', 'accountType', 'entitlement'].includes(key) &&
      typeof item === 'string' &&
      /unlimited|lifetime/i.test(item)
    ) {
      return true;
    }

    if (item && typeof item === 'object' && hasCleanPreviewEntitlement(item)) {
      return true;
    }
  }

  return false;
}

function installWatermarks() {
  const watermarkedParents = new Map();

  const sync = () => {
    const canvases = [...document.querySelectorAll('canvas')].filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width >= 240 && rect.height >= 180;
    });

    const activeParents = new Set();

    for (const canvas of canvases) {
      const parent = canvas.parentElement;
      if (!parent) continue;
      activeParents.add(parent);

      if (!watermarkedParents.has(parent)) {
        const previousPosition = parent.style.position;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

        const overlay = document.createElement('div');
        overlay.className = WATERMARK_CLASS;
        overlay.setAttribute('aria-hidden', 'true');
        parent.appendChild(overlay);
        watermarkedParents.set(parent, { overlay, previousPosition });
      }
    }

    for (const [parent, record] of watermarkedParents) {
      if (!parent.isConnected || !activeParents.has(parent)) {
        record.overlay.remove();
        parent.style.position = record.previousPosition;
        watermarkedParents.delete(parent);
      }
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', sync);
  sync();

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', sync);
    for (const [parent, record] of watermarkedParents) {
      record.overlay.remove();
      parent.style.position = record.previousPosition;
    }
  };
}

function installToastAutoDismiss() {
  const scheduled = new WeakSet();
  const timers = new Set();

  const scan = () => {
    const closeButtons = document.querySelectorAll(
      'button[aria-label*="close" i], button[title*="close" i], button'
    );

    for (const button of closeButtons) {
      if (scheduled.has(button)) continue;

      const buttonText = (button.textContent || '').trim();
      const labelledClose = /close/i.test(
        `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`
      );
      if (!labelledClose && !/^[x×✕✖]$/i.test(buttonText)) continue;

      let toast = button.parentElement;
      for (let depth = 0; toast && depth < 6; depth += 1, toast = toast.parentElement) {
        const text = (toast.textContent || '').replace(/\s+/g, ' ').trim();
        if (/\b(saved|loaded)\b/i.test(text) && text.length <= 500) break;
      }

      if (!toast || !/\b(saved|loaded)\b/i.test(toast.textContent || '')) continue;

      scheduled.add(button);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (button.isConnected) button.click();
      }, TOAST_LIFETIME_MS);
      timers.add(timer);
    }
  };

  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();

  return () => {
    observer.disconnect();
    for (const timer of timers) window.clearTimeout(timer);
  };
}

export default function BuilderProtectionLayout({ children }) {
  // Default to protected so a slow account request can never flash a clean preview.
  const [showWatermark, setShowWatermark] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadEntitlements() {
      try {
        const response = await fetch('/api/credits', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const account = await response.json();
        if (active) setShowWatermark(!hasCleanPreviewEntitlement(account));
      } catch {
        // Keep the protected default if account status cannot be verified.
      }
    }

    loadEntitlements();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => installToastAutoDismiss(), []);
  useEffect(() => (showWatermark ? installWatermarks() : undefined), [showWatermark]);

  return (
    <>
      <style jsx global>{`
        .proline-builder-mobile-gate {
          display: none;
        }

        .${WATERMARK_CLASS} {
          position: absolute;
          inset: -35%;
          z-index: 1;
          pointer-events: none;
          overflow: hidden;
          opacity: 0.1;
          transform: rotate(-24deg);
          transform-origin: center;
          background-image: url('/images/proline-watermark.png');
          background-repeat: repeat;
          background-position: center;
          background-size: 300px auto;
        }

        @media (max-width: ${MOBILE_BREAKPOINT}px) {
          .proline-builder-desktop-content {
            display: none !important;
          }

          .proline-builder-mobile-gate {
            min-height: 100dvh;
            display: grid;
            place-items: center;
            padding: 32px 24px;
            background: #0b0b0b;
            color: #fff;
            text-align: center;
          }

          .proline-builder-mobile-gate__card {
            width: min(100%, 520px);
            padding: 36px 28px;
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.06);
          }

          .proline-builder-mobile-gate h1 {
            margin: 0 0 12px;
            font-size: clamp(1.65rem, 7vw, 2.25rem);
            line-height: 1.1;
          }

          .proline-builder-mobile-gate p {
            margin: 0;
            color: rgba(255, 255, 255, 0.76);
            font-size: 1rem;
            line-height: 1.6;
          }
        }
      `}</style>

      <div className="proline-builder-mobile-gate">
        <div className="proline-builder-mobile-gate__card">
          <h1>ProLine Builder</h1>
          <p>
            ProLine Builder is optimized for desktop. Please open this page on a desktop or
            laptop for the full design experience.
          </p>
        </div>
      </div>

      <div className="proline-builder-desktop-content">{children}</div>
    </>
  );
}
