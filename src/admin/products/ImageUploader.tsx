import { useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageOff, Loader2, Trash2, Upload } from "lucide-react";
import { productImageUrl, removeProductImage, uploadProductImage, validateImageFile } from "@/admin/products/productsApi";
import type { AdminError } from "@/admin/products/productErrors";

interface ImageUploaderProps {
  client: SupabaseClient;
  productId: string;
  imagePath: string | null;
  disabled?: boolean;
  /**
   * Persists the new path (or null after a removal) on the product row and reloads the screen — image
   * changes save immediately and independently of the rest of the form, so a failed upload never blocks or
   * gets bundled with unrelated field edits, and editing other fields never depends on the photo existing.
   */
  onSaved: (path: string | null) => Promise<AdminError | null>;
}

/**
 * A product's optional photo (create mode never shows this — an image is never required to create a
 * product; add or replace one afterwards, here, in Edit). Client-side checks mirror the storage bucket's own
 * limits (JPEG/PNG/WebP, ≤2MB) so a bad file is rejected immediately with no round trip; the server enforces
 * them regardless. A rejected or failed upload leaves the product exactly as it was, with just an error
 * message — never a partial or broken state.
 */
export function ImageUploader({ client, productId, imagePath, disabled, onSaved }: ImageUploaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The drawer stays open after an image change (see onSaved), so the parent's `imagePath` prop — a snapshot
  // taken when the drawer opened — never refreshes on its own. Track the saved path locally instead.
  const [currentPath, setCurrentPath] = useState(imagePath);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File) => {
    setError(null);
    const invalid = validateImageFile(file);
    if (invalid) {
      setError(invalid.message);
      return;
    }
    setBusy(true);
    const uploaded = await uploadProductImage(client, productId, file);
    if (!uploaded.ok) {
      setBusy(false);
      setError(uploaded.error.message);
      return;
    }
    const previousPath = currentPath;
    const saveError = await onSaved(uploaded.data);
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      void removeProductImage(client, uploaded.data); // the row was not updated — don't leave the upload orphaned
      return;
    }
    setCurrentPath(uploaded.data);
    if (previousPath) void removeProductImage(client, previousPath); // replaced — the old object is no longer referenced
  };

  const remove = async () => {
    if (!currentPath) return;
    setError(null);
    setBusy(true);
    const pathToRemove = currentPath;
    const saveError = await onSaved(null);
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setCurrentPath(null);
    void removeProductImage(client, pathToRemove);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-brand-text">תמונה (אופציונלי)</span>
      <div className="flex items-center gap-3">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-brand-border bg-brand-bg">
          {currentPath ? (
            <img src={productImageUrl(client, currentPath)} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageOff size={24} className="text-brand-text-muted" aria-hidden="true" />
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <Loader2 size={20} className="animate-spin text-white" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled || busy}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = ""; // lets picking the SAME file again re-trigger onChange
              if (file) void pick(file);
            }}
          />
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-brand-border px-2.5 py-1.5 text-xs font-medium text-brand-text outline-none transition-colors hover:border-brand-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50"
          >
            <Upload size={13} aria-hidden="true" />
            {currentPath ? "החלפת תמונה" : "העלאת תמונה"}
          </button>
          {currentPath && (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void remove()}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-brand-text-muted outline-none transition-colors hover:text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50"
            >
              <Trash2 size={13} aria-hidden="true" />
              הסרת תמונה
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-brand-text-muted">JPEG, PNG או WebP, עד 2MB. אפשר לשמור מוצר גם בלי תמונה.</p>
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}
