import { create } from "zustand";
import { newId } from "../lib/utils";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: string) => void;
}

const TOAST_TTL = 3600;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const toast: ToastItem = { id: newId("toast"), kind, message };
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
    setTimeout(() => get().dismiss(toast.id), TOAST_TTL);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push("success", message),
  error: (message: string) => useToastStore.getState().push("error", message),
  info: (message: string) => useToastStore.getState().push("info", message)
};
