import { create } from "zustand";

export interface LightboxImage {
  src: string;
  name?: string;
  /** Local file path when the image is backed by disk (enables save-as / reveal). */
  path?: string;
}

interface LightboxState {
  image: LightboxImage | null;
  open: (image: LightboxImage) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>()((set) => ({
  image: null,
  open: (image) => set({ image }),
  close: () => set({ image: null })
}));

export function openLightbox(image: LightboxImage): void {
  useLightboxStore.getState().open(image);
}
