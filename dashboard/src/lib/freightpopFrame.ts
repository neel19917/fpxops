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
  shipmentId: string | null;
  // Tail of the URL the iframe was first asked to load. Stays the same
  // across navigations so the iframe `src` never changes (the iframe stays
  // logged in). null until something opens the drawer with embed enabled.
  url: string | null;
}

const INITIAL: FrameState = { visible: false, trackingNumber: null, shipmentId: null, url: null };

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
export function showFrame(input: { url: string; shipmentId: string | null; trackingNumber: string | null }) {
  state = {
    visible: true,
    trackingNumber: input.trackingNumber,
    shipmentId: input.shipmentId,
    // Only update url when it actually differs — preserves login session.
    url: state.url === input.url ? state.url : input.url,
  };
  publish();
}

export function hideFrame() {
  state = { ...state, visible: false };
  publish();
}

// React hook — components that want to render based on the frame's state
// (e.g. the overlay itself) subscribe via this.
export function useFrameState(): FrameState {
  const [s, setS] = useState<FrameState>(state);
  useEffect(() => subscribeFrame(setS), []);
  return s;
}
