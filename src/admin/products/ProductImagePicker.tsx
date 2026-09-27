import { useRef, useState } from "react";
import { ImageOff, Trash2, Upload } from "lucide-react";
import { validateImageFile } from "@/admin/products/productsApi";

interface ProductImagePickerProps {
  disabled?: boolean;
  onChange: (file: File | null) => void;
}

/**
 * Create-mode image picker. There's no product id yet (ids come from the database on insert), so there's
 * nothing to upload to — this only holds the chosen file locally (with a preview) until the product itself
 * is created; the caller (ProductsListTab.submitCreate) then uploads it via the same
 * uploadProductImage/updateProduct the edit-flow ImageUploader already uses.
 */
export function ProductImagePicker({ disabled, onChange }: ProductImagePickerProps) {
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (file: File) => {
    setError(null);
    const invalid = validateImageFile(file);
    if (invalid) {
      setError(invalid.message);
      return;
    }
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    onChange(file);
  };

  const clear = () => {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError(null);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-brand-text">תמונה (אופציונלי)</span>
      <div className="flex items-center gap-3">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-brand-border bg-brand-bg">
          {previewUrl ? (
            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageOff size={24} className="text-brand-text-muted" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = ""; // lets picking the SAME file again re-trigger onChange
              if (file) pick(file);
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-brand-border px-2.5 py-1.5 text-xs font-medium text-brand-text outline-none transition-colors hover:border-brand-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50"
          >
            <Upload size={13} aria-hidden="true" />
            {previewUrl ? "החלפת תמונה" : "בחירת תמונה"}
          </button>
          {previewUrl && (
            <button
              type="button"
              disabled={disabled}
              onClick={clear}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-brand-text-muted outline-none transition-colors hover:text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50"
            >
              <Trash2 size={13} aria-hidden="true" />
              הסרה
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-brand-text-muted">JPEG, PNG או WebP, עד 2MB. התמונה תעלה לאחר שמירת המוצר. אפשר לשמור מוצר גם בלי תמונה.</p>
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}
