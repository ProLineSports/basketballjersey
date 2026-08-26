export const META_PIXEL_ID =
  process.env.NEXT_PUBLIC_META_PIXEL_ID || '1166261734848297';

export const META_CONSENT_STORAGE_KEY = 'proline_ad_tracking_consent_v1';

const META_PENDING_EVENTS_KEY = 'proline_pending_meta_events_v1';
const META_CONSENT_EVENT = 'proline:meta-consent-change';
const MAX_PENDING_EVENTS = 50;

function readPendingEvents() {
  if (typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(META_PENDING_EVENTS_KEY) || '[]'
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingEvents(events) {
  if (typeof window === 'undefined') return;

  try {
    if (!events.length) {
      window.sessionStorage.removeItem(META_PENDING_EVENTS_KEY);
      return;
    }

    window.sessionStorage.setItem(
      META_PENDING_EVENTS_KEY,
      JSON.stringify(events.slice(-MAX_PENDING_EVENTS))
    );
  } catch {
    // Tracking must never interfere with the Builder when storage is blocked.
  }
}

function sendMetaEvent(event) {
  if (typeof window === 'undefined' || typeof window.fbq !== 'function') {
    return false;
  }

  const method = event.custom ? 'trackCustom' : 'track';
  if (event.eventID) {
    window.fbq(method, event.name, event.parameters, {
      eventID: event.eventID,
    });
  } else {
    window.fbq(method, event.name, event.parameters);
  }

  return true;
}

function enqueueMetaEvent(event) {
  const pending = readPendingEvents();
  const duplicate = event.eventID
    ? pending.some(
        (item) => item.name === event.name && item.eventID === event.eventID
      )
    : false;

  if (!duplicate) {
    pending.push(event);
    writePendingEvents(pending);
  }
}

export function getMetaConsent() {
  if (typeof window === 'undefined') return null;

  if (
    window.__prolineMetaConsent === 'granted' ||
    window.__prolineMetaConsent === 'declined'
  ) {
    return window.__prolineMetaConsent;
  }

  try {
    const stored = window.localStorage.getItem(META_CONSENT_STORAGE_KEY);
    const consent =
      stored === 'granted' || stored === 'declined' ? stored : null;
    window.__prolineMetaConsent = consent;
    return consent;
  } catch {
    return null;
  }
}

export function saveMetaConsent(consent) {
  if (typeof window === 'undefined') return;

  window.__prolineMetaConsent = consent;

  try {
    window.localStorage.setItem(META_CONSENT_STORAGE_KEY, consent);
  } catch {
    // The in-memory choice still applies for the current page load.
  }

  if (consent === 'declined') {
    writePendingEvents([]);
  }

  window.dispatchEvent(new Event(META_CONSENT_EVENT));
}

export function subscribeMetaConsent(callback) {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (event) => {
    if (event.key !== META_CONSENT_STORAGE_KEY) return;
    window.__prolineMetaConsent =
      event.newValue === 'granted' || event.newValue === 'declined'
        ? event.newValue
        : null;
    callback();
  };

  window.addEventListener(META_CONSENT_EVENT, callback);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(META_CONSENT_EVENT, callback);
    window.removeEventListener('storage', handleStorage);
  };
}

export function clearPendingMetaEvents() {
  writePendingEvents([]);
}

export function flushPendingMetaEvents() {
  if (getMetaConsent() !== 'granted') return 0;

  const pending = readPendingEvents();
  if (!pending.length) return 0;

  let sentCount = 0;
  const unsent = [];

  pending.forEach((event) => {
    if (sendMetaEvent(event)) sentCount += 1;
    else unsent.push(event);
  });

  writePendingEvents(unsent);
  return sentCount;
}

function trackMetaEventInternal(custom, name, parameters = {}, options = {}) {
  if (typeof window === 'undefined' || !name) return 'unavailable';

  const event = {
    custom,
    name,
    parameters,
    eventID: options.eventID || null,
  };
  const consent = getMetaConsent();

  if (consent === 'declined') return 'blocked';

  if (consent === 'granted' && sendMetaEvent(event)) {
    return 'sent';
  }

  enqueueMetaEvent(event);
  return 'queued';
}

export function trackMetaEvent(name, parameters = {}, options = {}) {
  return trackMetaEventInternal(false, name, parameters, options);
}

export function trackMetaCustomEvent(name, parameters = {}, options = {}) {
  return trackMetaEventInternal(true, name, parameters, options);
}
