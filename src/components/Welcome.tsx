import { useStore } from "../lib/store";

export const basename = (p: string) => p.split("/").pop() ?? p;

type Props = { onOpen: () => void; onPick: (path: string) => void };

export function Welcome({ onOpen, onPick }: Props) {
  const library = useStore((s) => s.library);
  const recents = Object.entries(library)
    .sort(([, a], [, b]) => b.lastOpened - a.lastOpened)
    .slice(0, 6);

  return (
    <div className="welcome">
      <h1>Zone</h1>
      <p>Drop a PDF anywhere in this window, or open one. Nothing else happens here.</p>
      <button className="open" onClick={onOpen}>
        Open a PDF
      </button>

      {recents.length > 0 && (
        <div className="recents">
          {recents.map(([path, mark]) => (
            <button key={path} className="recent" onClick={() => onPick(path)}>
              <span>{mark.title || basename(path)}</span>
              <em>
                {Math.round(((mark.page + 1) / Math.max(1, mark.pages)) * 100)}%
              </em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
