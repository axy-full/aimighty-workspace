/** How long a toast stays (docs/redesign/inventory.md § 4.4): 2.6 s, or 5 s when it carries an action. Pure. */
export const TOAST_MS = 2600;
export const TOAST_ACTION_MS = 5000;

export type ToastAction = { label: "Undo" | "View" | (string & {}); run: () => void };
export type ToastInput = { text: string; action?: ToastAction };

export const toastDuration = (toast: ToastInput) => (toast.action ? TOAST_ACTION_MS : TOAST_MS);
