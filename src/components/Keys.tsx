const BINDINGS: [string, string][] = [
  ["space", "forward a screen"],
  ["⇧space  k  ↑", "back a screen"],
  ["j  ↓", "forward a screen"],
  ["n  p", "next / previous page"],
  ["g  ⇧g", "start / end"],
  ["+  −  0", "zoom in / out / reset"],
  ["pinch  ⇧scroll", "zoom at the cursor"],
  ["drag", "pan a zoomed page"],
  ["t", "cycle theme"],
  ["d", "focus band"],
  ["f", "fullscreen"],
  ["o", "open a PDF"],
  ["w", "close"],
  ["?  esc", "this list"],
];

export function Keys({ onClose }: { onClose: () => void }) {
  return (
    <div className="keys" onClick={onClose}>
      <dl>
        {BINDINGS.map(([key, what]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{key}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
