import { create } from "zustand";

/**
 * In-app confirmation, replacing window.confirm everywhere.
 *
 *   if (!(await confirmAction({ title: "Remove Kaggle?", confirmLabel: "Remove", danger: true }))) return;
 *
 * Same shape of use as window.confirm (one awaited boolean), but rendered by
 * <ConfirmHost /> in each layout: themed, keyboard-accessible, and with the
 * consequence spelled out instead of a bare OK / Cancel.
 */

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve(ok: boolean): void }) | null;
  open(req: ConfirmRequest): Promise<boolean>;
  settle(ok: boolean): void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  open(req) {
    // A second request while one is open cancels the first.
    get().request?.resolve(false);
    return new Promise<boolean>((resolve) => set({ request: { ...req, resolve } }));
  },
  settle(ok) {
    const r = get().request;
    set({ request: null });
    r?.resolve(ok);
  },
}));

export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().open(req);
}
