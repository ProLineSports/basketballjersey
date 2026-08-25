'use client';

import { useEffect, useRef, useState } from 'react';

const MOBILE_QUERY =
  '(max-width: 900px), ((hover: none) and (pointer: coarse) and (max-width: 1180px))';

const DESIGN_NOTICE_PATTERN =
  /\b(?:design\s+(?:saved|loaded|renamed|duplicated|deleted)|(?:saved|loaded|renamed|duplicated|deleted)\s+(?:design|successfully)|saved\s+successfully|loaded\s+successfully)\b/i;

const WATERMARK_TILE =
  'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27 viewBox=%270 0 320 180%27%3E%3Cg transform=%27rotate(-28 160 90)%27 font-family=%27Arial,sans-serif%27 font-size=%2720%27 font-weight=%27700%27 letter-spacing=%272%27%3E%3Ctext x=%27-18%27 y=%2797%27 fill=%27%23ffffff%27 stroke=%27%23000000%27 stroke-width=%271.4%27 paint-order=%27stroke%27 opacity=%27.20%27%3EPROLINEMOCKUPS.COM%3C/text%3E%3C/g%3E%3C/svg%3E")';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findCloseButton(container) {
  if (!(container instanceof HTMLElement)) return null;

  const explicit = container.querySelector(
    [
      'button[aria-label*="close" i]',
      'button[title*="close" i]',
      '[role="button"][aria-label*="close" i]',
      '[role="button"][title*="close" i]',
    ].join(',')
  );
  if (explicit) return explicit;

  const buttons = Array.from(container.querySelectorAll('button,[role="button"]'));
  return (
    buttons.find((button) => {
      const label = normalizeText(
        button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent
      ).toLowerCase();

      return (
        label === 'x' ||
        label === '×' ||
        label === '✕' ||
        label === 'close' ||
        label === 'dismiss'
      );
    }) || null
  );
}

function getLikelyNoticeRoot(start) {
  if (!(start instanceof HTMLElement)) return null;

  let current = start;
  let best = null;

  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
    const text = normalizeText(current.textContent);
    if (!text || text.length > 500 || !DESIGN_NOTICE_PATTERN.test(text)) continue;

    if (findCloseButton(current)) {
      best = current;
      break;
    }

    if (!best) best = current;
  }

  return best;
}

function MobileGate() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        width: '100%',
        background:
          'radial-gradient(circle at 50% 20%, rgba(239,255,0,0.07), transparent 34%), #090a0b',
        color: '#f4f4f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 28,
        boxSizing: 'border-box',
        textAlign: 'center',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div style={{ width: 'min(560px, 100%)' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid rgba(239,255,0,0.32)',
            borderRadius: 999,
            padding: '7px 12px',
            color: '#efff00',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.14em',
            marginBottom: 22,
          }}
        >
          PROLINE ONLINE BUILDER
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(30px, 8vw, 48px)',
            lineHeight: 0.98,
            letterSpacing: '-0.03em',
            fontWeight: 900,
          }}
        >
          BUILT FOR DESKTOP
        </h1>

        <p
          style={{
            margin: '18px auto 0',
            maxWidth: 480,
            color: '#a1a1aa',
            fontSize: 15,
            lineHeight: 1.65,
          }}
        >
          The ProLine Helmet Builder is optimized for a desktop or laptop display.
          Please reopen this page on a larger screen for the full design, save, and
          export experience.
        </p>
      </div>
    </main>
  );
}

function PreviewWatermark({ active, blocked }) {
  const [rect, setRect] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!active || blocked) {
      setRect(null);
      return undefined;
    }

    let resizeObserver = null;
    let mutationObserver = null;
    let frame = 0;

    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'))
          .filter(isVisible)
          .map((canvas) => ({
            canvas,
            rect: canvas.getBoundingClientRect(),
          }))
          .filter(({ rect }) => rect.width >= 280 && rect.height >= 220)
          .sort(
            (a, b) =>
              b.rect.width * b.rect.height - a.rect.width * a.rect.height
          );

        const target = canvases[0]?.canvas || null;

        if (target !== canvasRef.current) {
          resizeObserver?.disconnect();
          canvasRef.current = target;

          if (target && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(update);
            resizeObserver.observe(target);
          }
        }

        if (!target) {
          setRect(null);
          return;
        }

        const next = target.getBoundingClientRect();
        setRect({
          left: Math.max(0, next.left),
          top: Math.max(0, next.top),
          width: Math.max(0, Math.min(window.innerWidth, next.right) - Math.max(0, next.left)),
          height: Math.max(0, Math.min(window.innerHeight, next.bottom) - Math.max(0, next.top)),
        });
      });
    };

    update();

    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });

    mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    const interval = window.setInterval(update, 1500);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [active, blocked]);

  if (!active || blocked || !rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 2147483000,
        pointerEvents: 'none',
        overflow: 'hidden',
        backgroundImage: WATERMARK_TILE,
        backgroundRepeat: 'repeat',
        backgroundPosition: 'center',
      }}
    >
      <div
        style={{
          position: 'absolute',
          right: 12,
          bottom: 10,
          padding: '5px 8px',
          borderRadius: 5,
          background: 'rgba(0,0,0,0.48)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.78)',
          fontFamily: 'Arial, sans-serif',
          fontWeight: 800,
          fontSize: 9,
          letterSpacing: '0.08em',
        }}
      >
        PREVIEW · EXPORT FOR CLEAN IMAGE
      </div>
    </div>
  );
}

export default function HelmetLayout({ children }) {
  const [mobileBlocked, setMobileBlocked] = useState(null);
  const [previewWatermark, setPreviewWatermark] = useState(true);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobileBlocked(media.matches);

    update();

    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  // Credit-based users always see a watermark on the LIVE preview.
  // Unlimited Monthly and Lifetime All-Access users do not.
  // The overlay lives outside the WebGL canvas, so legitimate PNG exports remain clean.
  useEffect(() => {
    let alive = true;

    const refreshEntitlement = async () => {
      try {
        const response = await fetch('/api/user/credits', {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        if (!alive) return;

        if (!response.ok) {
          setPreviewWatermark(true);
          return;
        }

        const data = await response.json();
        const hasUnlimitedAccess =
          data?.isUnlimited === true ||
          data?.isSubscriptionUnlimited === true ||
          data?.isLifetimeAllAccess === true;

        setPreviewWatermark(!hasUnlimitedAccess);
      } catch {
        if (alive) setPreviewWatermark(true);
      }
    };

    refreshEntitlement();

    const interval = window.setInterval(refreshEntitlement, 15000);
    window.addEventListener('focus', refreshEntitlement);

    const onVisibility = () => {
      if (!document.hidden) refreshEntitlement();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshEntitlement);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Saved-design success notices can still be dismissed manually, but if the user
  // does nothing we automatically click their Close/X button after 3 seconds.
  useEffect(() => {
    const scheduled = new WeakSet();
    const timers = new Set();

    const scheduleIfNotice = (node) => {
      if (!(node instanceof HTMLElement)) return;

      const candidates = [node];

      if (node.querySelectorAll) {
        node
          .querySelectorAll('[role="alert"],[role="status"]')
          .forEach((element) => candidates.push(element));
      }

      candidates.forEach((candidate) => {
        const root = getLikelyNoticeRoot(candidate);
        if (!root || scheduled.has(root) || !isVisible(root)) return;

        const text = normalizeText(root.textContent);
        if (!DESIGN_NOTICE_PATTERN.test(text)) return;

        scheduled.add(root);

        const timer = window.setTimeout(() => {
          timers.delete(timer);

          if (!document.body.contains(root)) return;

          const closeButton = findCloseButton(root);
          if (closeButton) {
            closeButton.click();
          }
        }, 3000);

        timers.add(timer);
      });
    };

    document
      .querySelectorAll('[role="alert"],[role="status"]')
      .forEach(scheduleIfNotice);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => scheduleIfNotice(node));
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Avoid briefly mounting the heavy 3D Builder before we know the viewport class.
  if (mobileBlocked === null) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          width: '100%',
          background: '#090a0b',
        }}
      />
    );
  }

  if (mobileBlocked) {
    return <MobileGate />;
  }

  return (
    <>
      {children}
      <PreviewWatermark active={previewWatermark} blocked={mobileBlocked} />
    </>
  );
}
