import { useRef } from "react";

// Cap matches the server (MAX_IMAGES in server/index.mjs): extra shots are dropped.
export const MAX_IMAGES = 6;

let imgSeq = 0;

// Read image Files into { id, name, dataUrl }. Non-images are skipped, so a
// clipboard paste that also carries text/html doesn't produce junk attachments.
export async function filesToImages(files) {
  const out = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    out.push({ id: `img-${imgSeq++}`, name: f.name || "screenshot.png", dataUrl });
  }
  return out;
}

// 📎 button that opens the file picker. Chosen images are handed to onAdd.
export function AttachButton({ onAdd, disabled }) {
  const inputRef = useRef(null);
  const pick = async (e) => {
    const imgs = await filesToImages(e.target.files || []);
    if (imgs.length) onAdd(imgs);
    e.target.value = ""; // let the same file be picked again after removal
  };
  return (
    <>
      <button
        type="button"
        className="attachBtn ghost"
        title="Attach a screenshot"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        📎
      </button>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={pick} />
    </>
  );
}

// A strip of removable screenshot thumbnails. Renders nothing when empty.
export function Thumbnails({ images, onRemove }) {
  if (!images?.length) return null;
  return (
    <div className="thumbs">
      {images.map((img) => (
        <div className="thumb" key={img.id} title={img.name}>
          <img src={img.dataUrl} alt={img.name} />
          <button
            type="button"
            className="thumbX"
            title="Remove"
            onClick={() => onRemove(img.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
