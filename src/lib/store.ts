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

/** A rect in page-normalised coordinates: fractions of page width and height. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * One page's share of a highlight. A selection dragged across a page break
 * yields one of these per page, sharing a `group` so removing either removes
 * both.
 */
export type Highlight = {
  id: string;
  group: string;
  page: number;
  rects: Rect[];
  /** The selected text. Kept for a future highlights list; not rendered today. */
  text: string;
  at: number;
};

type Persisted = {
  theme: Theme;
  focus: boolean;
  library: Record<string, Bookmark>;
  /**
   * Deliberately a sibling of `library` rather than a field on Bookmark:
   * `remember` rebuilds the whole bookmark on every scroll frame, so anything
   * nested inside one would be overwritten sixty times a second.
   */
  highlights: Record<string, Highlight[]>;
};

const DEFAULTS: Persisted = { theme: "paper", focus: false, library: {}, highlights: {} };

type Store = Persisted & {
  ready: boolean;
  hydrate: () => Promise<void>;
  setTheme: (t: Theme) => void;
  cycleTheme: () => void;
  toggleFocus: () => void;
  remember: (path: string, mark: Bookmark) => void;
  forget: (path: string) => void;
  addHighlights: (path: string, marks: Highlight[]) => void;
  removeHighlights: (path: string, groups: string[]) => void;
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
    const highlights = { ...get().highlights };
    delete highlights[path];
    set({ library, highlights });
  },

  addHighlights: (path, marks) =>
    set(({ highlights }) => ({
      highlights: { ...highlights, [path]: [...(highlights[path] ?? []), ...marks] },
    })),

  // Plural: a click can land on more than one highlight, and removing only the
  // topmost would leave the bar looking untouched.
  removeHighlights: (path, groups) =>
    set(({ highlights }) => {
      const gone = new Set(groups);
      const kept = (highlights[path] ?? []).filter((h) => !gone.has(h.group));
      return { highlights: { ...highlights, [path]: kept } };
    }),
}));

// Persist prefs + library, coalescing bursts of scroll updates.
// Zoom is deliberately absent: it is a transient reading aid, reset per document.
let timer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe(({ ready, theme, focus, library, highlights }) => {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => void saveState({ theme, focus, library, highlights }), 400);
});
