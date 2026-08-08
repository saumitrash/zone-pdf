import { create } from "zustand";
import { loadState, saveState } from "./bridge";

export const THEMES = ["paper", "sepia", "dim", "black"] as const;
export type Theme = (typeof THEMES)[number];

/** Where the reader was in a given document. */
export type Bookmark = {
  page: number;
  /** px offset from the top of `page`, at the zoom the mark was taken at. */
  offset: number;
  /** The same offset as a fraction of page height, so it survives zoom. */
  frac?: number;
  title: string;
  pages: number;
  lastOpened: number;
};

type Persisted = {
  theme: Theme;
  focus: boolean;
  library: Record<string, Bookmark>;
};

const DEFAULTS: Persisted = { theme: "paper", focus: false, library: {} };

type Store = Persisted & {
  ready: boolean;
  hydrate: () => Promise<void>;
  setTheme: (t: Theme) => void;
  cycleTheme: () => void;
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
  toggleFocus: () => set(({ focus }) => ({ focus: !focus })),

  remember: (path, mark) => set({ library: { ...get().library, [path]: mark } }),
  forget: (path) => {
    const library = { ...get().library };
    delete library[path];
    set({ library });
  },
}));

// Persist prefs + library, coalescing bursts of scroll updates.
// Zoom is deliberately absent: it is a transient reading aid, reset per document.
let timer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe(({ ready, theme, focus, library }) => {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => void saveState({ theme, focus, library }), 400);
});
