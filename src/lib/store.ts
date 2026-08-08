import { create } from "zustand";
import { loadState, saveState } from "./bridge";

export const THEMES = ["paper", "sepia", "dim", "black"] as const;
export type Theme = (typeof THEMES)[number];

/** Where the reader was in a given document. */
export type Bookmark = {
  page: number;
  /** px offset from the top of `page`, so it survives zoom/placeholder changes. */
  offset: number;
  title: string;
  pages: number;
  lastOpened: number;
};

type Persisted = {
  theme: Theme;
  zoom: number;
  focus: boolean;
  library: Record<string, Bookmark>;
};

const DEFAULTS: Persisted = { theme: "paper", zoom: 1, focus: false, library: {} };

type Store = Persisted & {
  ready: boolean;
  hydrate: () => Promise<void>;
  setTheme: (t: Theme) => void;
  cycleTheme: () => void;
  setZoom: (z: number) => void;
  toggleFocus: () => void;
  remember: (path: string, mark: Bookmark) => void;
  forget: (path: string) => void;
};

export const useStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ready: false,

  hydrate: async () => {
    const saved = await loadState(DEFAULTS);
    set({ ...saved, ready: true });
  },

  setTheme: (theme) => set({ theme }),
  cycleTheme: () =>
    set(({ theme }) => ({
      theme: THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length],
    })),
  setZoom: (zoom) => set({ zoom: Math.min(3, Math.max(0.5, zoom)) }),
  toggleFocus: () => set(({ focus }) => ({ focus: !focus })),

  remember: (path, mark) => set({ library: { ...get().library, [path]: mark } }),
  forget: (path) => {
    const library = { ...get().library };
    delete library[path];
    set({ library });
  },
}));

// Persist prefs + library, coalescing bursts of scroll updates.
let timer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe(({ ready, theme, zoom, focus, library }) => {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => void saveState({ theme, zoom, focus, library }), 400);
});
