import { useEffect, useState } from "react";

// Tiny pub/sub for the singleton FreightPOP overlay. Pages publish what's
// currently focused; <FreightPopOverlay/> in App reads from here. The whole
// point of this layer is to keep the iframe mounted across route changes
// — walking between tasks (which churns the route) used to remount the
// iframe, which logged the user out of FreightPOP every step. Now the
// iframe lives at App scope and only its visibility / decoration changes.

export interface FrameState {
  // Drawer is open and split-view is on for this surface.
  visible: boolean;
  // Which shipment the right-side drawer is currently showing — drives the
  // tracking-number bar above the iframe. Null when no shipment is focused.
  trackingNumber: string | null;
  // FreightPOP's user-facing shipment id (the unique identifier in the
  // operator's mental map). Surfaced prominently in the overlay header.
  shipmentLabel: string | null;
  // Internal DB row id, used only when callers need to tie state back to
  // the row. Not displayed.
  shipmentId: string | null;
  customerName: string | null;
  // Tail of the URL the iframe was first asked to load. Stays the same
  // across navigations so the iframe `src` never changes (the iframe stays
  // logged in). null until something opens the drawer with embed enabled.
  url: string | null;
  // Monotonic tick that bumps each time a caller asks the overlay to
  // re-fire the Kendo grid filter (Tasks "Load shipment", drawer "Load in
  // FreightPOP", etc.). The overlay keys auto-fires on (trackingNumber,
  // tick): a new tracking number fires once; a tick bump on the same
  // tracking number forces a re-fire (user manually cleared the filter
  // in FreightPOP and wants to reload). Starts at 0 so first render is
  // a fresh key for the first non-null trackingNumber.
  autoFilterTick: number;
  // Sister tick to autoFilterTick — bumps whenever a caller wants the
  // overlay to ask the extension to open the FP-native tracking modal
  // for the current trackingNumber. Same keying pattern: overlay fires
  // exactly once per (trackingNumber, openTrackingTick) pair.
  openTrackingTick: number;
}

const INITIAL: FrameState = {
  visible: false,
  trackingNumber: null,
  shipmentLabel: null,
  shipmentId: null,
  customerName: null,
  url: null,
  autoFilterTick: 0,
  openTrackingTick: 0,
};

let state: FrameState = INITIAL;
const listeners = new Set<(s: FrameState) => void>();

function publish() {
  for (const cb of listeners) cb(state);
}

export function getFrameState(): FrameState {
  return state;
}

export function subscribeFrame(cb: (s: FrameState) => void): () => void {
  listeners.add(cb);
  // Immediate emit so subscribers don't render stale defaults.
  cb(state);
  return () => listeners.delete(cb);
}

// Page-side helpers. Mounting context (e.g. ShipmentsPage with split view on)
// calls showFrame() with the resolved iframe URL + the focused shipment.
// On close / split-view-off, call hideFrame(). The iframe URL is sticky:
// once set, subsequent showFrame() calls only update visibility +
// trackingNumber unless the URL itself genuinely changes (e.g. admin
// updates the template in Settings).
export function showFrame(input: {
  url: string;
  shipmentId: string | null;
  shipmentLabel?: string | null;
  trackingNumber: string | null;
  customerName?: string | null;
}) {
  state = {
    visible: true,
    trackingNumber: input.trackingNumber,
    shipmentLabel: input.shipmentLabel ?? null,
    shipmentId: input.shipmentId,
    customerName: input.customerName ?? null,
    // Only update url when it actually differs — preserves login session.
    url: state.url === input.url ? state.url : input.url,
    autoFilterTick: state.autoFilterTick,
    openTrackingTick: state.openTrackingTick,
  };
  publish();
}

export function hideFrame() {
  state = { ...state, visible: false };
  publish();
}

// Tasks page calls this when the user clicks "Load shipment" — bumps the
// tick so the overlay re-fires the Kendo-grid filter for the current
// tracking number even if it hasn't changed (e.g. the user manually
// cleared the FreightPOP filter and wants to reload). The overlay keys
// auto-fires on (trackingNumber, tick) so this is also race-free with
// upstream showFrame calls: tick bump + trackingNumber arrival in either
// order produces exactly one fire per (trackingNumber, tick) pair.
export function requestAutoFilter() {
  state = { ...state, autoFilterTick: state.autoFilterTick + 1 };
  publish();
}

// Drawer "Open tracking #" button calls this to ask the embedded
// FreightPOP iframe (via the Chrome extension's content script) to open
// FP's native tracking modal for the current trackingNumber. Bumps a
// dedicated tick so the overlay can fire exactly once per request,
// independent of the auto-filter tick.
export function requestOpenTracking() {
  state = { ...state, openTrackingTick: state.openTrackingTick + 1 };
  publish();
}

// React hook — components that want to render based on the frame's state
// (e.g. the overlay itself) subscribe via this.
export function useFrameState(): FrameState {
  const [s, setS] = useState<FrameState>(state);
  useEffect(() => subscribeFrame(setS), []);
  return s;
}
