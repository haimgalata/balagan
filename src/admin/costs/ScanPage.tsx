import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Camera, CameraOff, Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { navigateAdmin } from "@/admin/adminPath";
import { COSTS_PATH } from "@/admin/costs/costsRoute";
import {
  attachBarcode, blockBarcode, createScannedProduct, loadCigaretteGroups, loadCostOverview, lookupBarcode, moveBarcode, searchProducts,
  type BarcodeProduct, type CigaretteGroup,
} from "@/admin/costs/costsApi";
import { costWithVat, formatShekels, missingBarcodes, normalizeBarcode, type CostOverview } from "@/admin/costs/costModel";
import { ProfitText } from "@/admin/costs/costsUi";
import { updateProduct, uploadProductImage } from "@/admin/products/productsApi";
import type { Scanner } from "@/admin/costs/barcodeScanner";

/**
 * The owner's barcode screen: SINGLE PACKS ONLY. A carton barcode is never saved on a product (so the till can't sell a
 * carton at the pack price) — the owner marks it "פקט" and it goes on the database's blocklist, which also refuses it
 * on any product (migration 0016 trigger). The camera stays open between products; typing the number always works.
 */
type Step =
  | { kind: "ready" }
  | { kind: "looking"; code: string }
  | { kind: "known"; code: string; product: BarcodeProduct }
  | { kind: "blocked"; code: string; note: string | null }
  | { kind: "single?"; code: string }
  | { kind: "choose"; code: string; moveFrom: BarcodeProduct | null }
  | { kind: "confirm"; code: string; target: BarcodeProduct; moveFrom: BarcodeProduct | null }
  | { kind: "create"; code: string }
  | { kind: "saved"; code: string; text: string };

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none focus-visible:border-brand-gold disabled:opacity-50";
const card = "rounded-xl border border-brand-border bg-brand-bg-elevated p-4";

function CameraBox({ active, onCode }: { active: boolean; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let scanner: Scanner | null = null;
    let timer = 0;
    let last = "";
    let lastAt = 0;

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (scanner && video && activeRef.current) {
        try {
          const code = await scanner.read(video);
          // The same pack held in front of the camera must not fire twice in a row.
          if (code && (code !== last || Date.now() - lastAt > 4000)) {
            last = code;
            lastAt = Date.now();
            if (typeof navigator.vibrate === "function") navigator.vibrate(80);
            onCodeRef.current(code);
          }
        } catch {
          /* a frame that could not be read — try the next one */
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 250);
    };

    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("המצלמה עובדת רק באתר המאובטח (https). אפשר להקליד את המספר שמתחת לברקוד.");
        setOn(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        scanner = (await import("@/admin/costs/barcodeScanner")).createScanner();
        void tick();
      } catch {
        setError("לא ניתן לפתוח את המצלמה. אשרו גישה למצלמה בדפדפן, או הקלידו את המספר שמתחת לברקוד.");
        setOn(false);
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);

  return (
    <div className="space-y-2">
      {on ? (
        <div className="relative overflow-hidden rounded-xl border border-brand-border bg-black">
          <video ref={videoRef} muted playsInline className="aspect-[4/3] w-full object-cover" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-brand-danger/80" />
          {!active && <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white">ממתין להחלטה על הברקוד שנסרק</div>}
        </div>
      ) : null}
      <Button type="button" variant={on ? "outline" : "primary"} onClick={() => { setError(null); setOn((v) => !v); }}>
        {on ? <CameraOff size={16} aria-hidden="true" /> : <Camera size={16} aria-hidden="true" />}
        {on ? "כיבוי מצלמה" : "פתיחת מצלמה"}
      </Button>
      {error && <p role="alert" className="text-sm text-brand-danger">{error}</p>}
    </div>
  );
}

function ProductLine({ product, overview }: { product: BarcodeProduct; overview: CostOverview | null }) {
  const row = overview?.rows.find((r) => r.id === product.id);
  return (
    <div className="space-y-1">
      <p className="text-lg font-bold text-brand-text">{product.name}</p>
      <p className="text-sm text-brand-text-muted">
        מחיר: {formatShekels(product.salePrice)}
        {!product.isVisible && " · מוסתר באתר"}
      </p>
      {row && overview && (
        <p className="text-sm">
          {row.costExVat !== null && <span className="text-brand-text-muted">עלות כולל מע"מ: {formatShekels(costWithVat(row.costExVat, overview.vatPercent))} · </span>}
          רווח נקי: <ProfitText row={row} overview={overview} />
        </p>
      )}
    </div>
  );
}

function ChooseProduct({ client, code, moveFrom, onPick, onCreate, onCancel }: {
  client: SupabaseClient; code: string; moveFrom: BarcodeProduct | null; onPick: (p: BarcodeProduct) => void; onCreate: () => void; onCancel: () => void;
}) {
  const [term, setTerm] = useState("");
  const [all, setAll] = useState(false);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: BarcodeProduct[] }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const t = window.setTimeout(() => {
      void searchProducts(client, term, !all).then((r) => {
        if (!cancelled) setState(r.ok ? { status: "ready", items: r.data } : { status: "error", message: r.error.message });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [client, term, all]);

  return (
    <div className={`${card} space-y-3`}>
      <p className="font-semibold text-brand-text">
        {moveFrom ? `לאיזה מוצר להעביר את הברקוד ${code}?` : `לאיזה מוצר שייך הברקוד ${code}?`}
      </p>
      <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="חיפוש לפי שם, למשל מרלבורו" aria-label="חיפוש מוצר" className={inputClasses} autoFocus />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-brand-gold" />
        לחפש בכל המוצרים (לא רק סיגריות)
      </label>
      {state.status === "loading" && <Loader2 size={18} className="animate-spin text-brand-text-muted" aria-label="טוען" />}
      {state.status === "error" && <p className="text-sm text-brand-danger">{state.message}</p>}
      {state.status === "ready" && (
        <ul className="max-h-80 divide-y divide-brand-border overflow-y-auto rounded-lg border border-brand-border" data-testid="scan-results">
          {state.items.filter((p) => p.id !== moveFrom?.id).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p)} className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-brand-bg">
                <span className="text-brand-text">{p.name}{!p.isVisible && <span className="ms-1 text-xs text-brand-text-muted">(מוסתר)</span>}</span>
                <span className="text-xs text-brand-text-muted">{formatShekels(p.salePrice)}{p.barcode && " · יש כבר ברקוד"}</span>
              </button>
            </li>
          ))}
          {state.items.length === 0 && <li className="px-3 py-2 text-sm text-brand-text-muted">לא נמצא.</li>}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!moveFrom && (
          <Button type="button" variant="secondary" onClick={onCreate}>
            המוצר לא קיים באתר
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </div>
  );
}

function CreateProduct({ client, code, onDone, onCancel }: { client: SupabaseClient; code: string; onDone: (text: string) => void; onCancel: () => void }) {
  const [groups, setGroups] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; categoryId: string; list: CigaretteGroup[] }>({ status: "loading" });
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [price, setPrice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadCigaretteGroups(client).then((r) => setGroups(r.ok ? { status: "ready", categoryId: r.data.categoryId, list: r.data.groups } : { status: "error", message: r.error.message }));
  }, [client]);

  const priceNum = price.trim() === "" ? null : Number(price);
  const priceInvalid = priceNum !== null && (!Number.isFinite(priceNum) || priceNum <= 0);
  const canSave = groups.status === "ready" && name.trim() !== "" && group !== "" && !priceInvalid && !busy;

  const save = async () => {
    if (!canSave || groups.status !== "ready") return;
    setBusy(true);
    setError(null);
    const r = await createScannedProduct(client, { categoryId: groups.categoryId, subcategoryId: group, name: name.trim(), price: priceNum, barcode: code });
    if (!r.ok) {
      setBusy(false);
      setError(r.error.message);
      return;
    }
    let imageNote = "";
    if (file) {
      const up = await uploadProductImage(client, r.data.id, file);
      const saved = up.ok ? await updateProduct(client, r.data.id, { image_path: up.data }) : up;
      if (!saved.ok) imageNote = " (התמונה לא נשמרה — אפשר להוסיף אותה במסך המוצרים)";
    }
    setBusy(false);
    onDone(priceNum === null ? `המוצר נוצר מוסתר, כי חסר לו מחיר. הוסיפו מחיר במסך המוצרים כדי שיופיע באתר.${imageNote}` : `המוצר נוצר ומופיע באתר.${imageNote}`);
  };

  return (
    <form className={`${card} space-y-3`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="font-semibold text-brand-text">מוצר חדש עם הברקוד {code}</p>
      {groups.status === "error" && <p className="text-sm text-brand-danger">{groups.message}</p>}
      <label className="block text-sm">
        <span className="mb-1 block text-brand-text-muted">שם (כמו בקופה)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} maxLength={120} disabled={busy} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-text-muted">מותג</span>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={inputClasses} disabled={busy || groups.status !== "ready"}>
          <option value="">בחרו…</option>
          {groups.status === "ready" && groups.list.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-text-muted">מחיר לחפיסה (לא חובה — בלי מחיר המוצר יישמר מוסתר)</span>
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" dir="ltr" className={inputClasses} disabled={busy} aria-invalid={priceInvalid} />
        {priceInvalid && <span className="mt-1 block text-xs text-brand-danger">מחיר לא תקין</span>}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-text-muted">תמונה (לא חובה)</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} className="text-sm" />
      </label>
      {error && <p role="alert" className="text-sm text-brand-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canSave}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          יצירת מוצר
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

export function ScanPage({ client }: { client: SupabaseClient }) {
  const [step, setStep] = useState<Step>({ kind: "ready" });
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [overview, setOverview] = useState<CostOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadOverview = useCallback(() => {
    void loadCostOverview(client).then((r) => setOverview(r.ok ? r.data : null));
  }, [client]);
  useEffect(reloadOverview, [reloadOverview]);

  const handleCode = useCallback(
    async (raw: string) => {
      const code = normalizeBarcode(raw);
      if (!code) return;
      setError(null);
      setStep({ kind: "looking", code });
      const r = await lookupBarcode(client, code);
      if (!r.ok) {
        setError(r.error.message);
        setStep({ kind: "ready" });
        return;
      }
      const found = r.data;
      setStep(found.kind === "product" ? { kind: "known", code, product: found.product } : found.kind === "blocked" ? { kind: "blocked", code, note: found.note } : { kind: "single?", code });
    },
    [client]
  );

  const done = (code: string, text: string) => {
    setBusy(false);
    setStep({ kind: "saved", code, text });
    reloadOverview();
  };

  const markCarton = async (code: string) => {
    setBusy(true);
    const r = await blockBarcode(client, code, "פקט — סומן בסריקה");
    if (r.ok) done(code, "סומן כברקוד של פקט. הוא לא יישמר על אף מוצר.");
    else {
      setBusy(false);
      setError(r.error.message);
    }
  };

  const confirmAttach = async (code: string, target: BarcodeProduct, moveFrom: BarcodeProduct | null) => {
    setBusy(true);
    setError(null);
    const r = moveFrom ? await moveBarcode(client, moveFrom.id, target.id, code) : await attachBarcode(client, target.id, code);
    if (r.ok) done(code, moveFrom ? `הברקוד הועבר מ"${moveFrom.name}" אל "${target.name}".` : `הברקוד נשמר על "${target.name}".`);
    else {
      setBusy(false);
      setError(r.error.message);
    }
  };

  const next = () => {
    setError(null);
    setStep({ kind: "ready" });
  };
  const cameraActive = step.kind === "ready" || step.kind === "saved" || step.kind === "known" || step.kind === "blocked";
  const missing = overview ? missingBarcodes(overview.rows) : [];
  const missingCount = missing.reduce((n, g) => n + g.names.length, 0);

  return (
    <section aria-labelledby="scan-title" className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="scan-title" className="text-xl font-bold text-brand-text">סריקת ברקודים</h1>
          <p className="mt-1 text-sm text-brand-text-muted">סורקים רק חפיסה בודדת — לא את הפקט.</p>
        </div>
        <Button type="button" variant="ghost" onClick={() => navigateAdmin(COSTS_PATH)}>
          לעלויות ורווח
        </Button>
      </div>

      <CameraBox active={cameraActive} onCode={(c) => void handleCode(c)} />

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const code = normalizeBarcode(manual);
          if (!code) return setManualError("הקלידו את המספר שמתחת לברקוד (ספרות בלבד).");
          setManualError(null);
          setManual("");
          void handleCode(code);
        }}
      >
        <input value={manual} onChange={(e) => setManual(e.target.value)} inputMode="numeric" dir="ltr" placeholder="או הקלידו את מספר הברקוד" aria-label="מספר ברקוד" className={inputClasses} />
        <Button type="submit" variant="secondary">חיפוש</Button>
      </form>
      {manualError && <p role="alert" className="text-sm text-brand-danger">{manualError}</p>}
      {error && <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">{error}</p>}

      <div data-testid="scan-step" data-step={step.kind}>
        {step.kind === "looking" && (
          <p className="flex items-center gap-2 text-brand-text-muted"><Loader2 size={18} className="animate-spin" aria-hidden="true" /> מחפש את {step.code}…</p>
        )}
        {step.kind === "known" && (
          <div className={`${card} space-y-3`}>
            <p className="text-xs text-brand-text-muted" dir="ltr">{step.code}</p>
            <ProductLine product={step.product} overview={overview} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={next}>סריקה הבאה</Button>
              <Button type="button" variant="ghost" onClick={() => setStep({ kind: "choose", code: step.code, moveFrom: step.product })}>
                זה לא המוצר הנכון
              </Button>
            </div>
          </div>
        )}
        {step.kind === "blocked" && (
          <div role="alert" className={`${card} space-y-3 border-brand-gold/60`}>
            <p className="font-semibold text-brand-gold">זה ברקוד של פקט. סרקו חפיסה בודדת.</p>
            <p className="text-xs text-brand-text-muted" dir="ltr">{step.code}</p>
            <Button type="button" onClick={next}>הבנתי</Button>
          </div>
        )}
        {step.kind === "single?" && (
          <div className={`${card} space-y-3`}>
            <p className="text-lg font-bold text-brand-text">ברקוד חדש: <span dir="ltr">{step.code}</span></p>
            <p className="text-brand-text">זו חפיסה בודדת?</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => setStep({ kind: "choose", code: step.code, moveFrom: null })}>כן, חפיסה בודדת</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void markCarton(step.code)}>לא, זה פקט</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={next}>ביטול</Button>
            </div>
          </div>
        )}
        {step.kind === "choose" && (
          <ChooseProduct
            client={client}
            code={step.code}
            moveFrom={step.moveFrom}
            onPick={(target) => setStep({ kind: "confirm", code: step.code, target, moveFrom: step.moveFrom })}
            onCreate={() => setStep({ kind: "create", code: step.code })}
            onCancel={next}
          />
        )}
        {step.kind === "confirm" && (
          <div className={`${card} space-y-3`}>
            {step.moveFrom ? (
              <p className="text-brand-text">להעביר את הברקוד <span dir="ltr">{step.code}</span> מ-"{step.moveFrom.name}" אל "{step.target.name}"?</p>
            ) : (
              <p className="text-brand-text">לשמור את הברקוד <span dir="ltr">{step.code}</span> על "{step.target.name}"?</p>
            )}
            {step.target.barcode && (
              <p className="text-sm text-brand-gold">למוצר הזה כבר יש ברקוד (<span dir="ltr">{step.target.barcode}</span>) — הוא יוחלף.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => void confirmAttach(step.code, step.target, step.moveFrom)}>
                {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {step.moveFrom ? "כן, להעביר" : "כן, לשמור"}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep({ kind: "choose", code: step.code, moveFrom: step.moveFrom })}>חזרה</Button>
            </div>
          </div>
        )}
        {step.kind === "create" && <CreateProduct client={client} code={step.code} onDone={(text) => done(step.code, text)} onCancel={() => setStep({ kind: "choose", code: step.code, moveFrom: null })} />}
        {step.kind === "saved" && (
          <div role="status" className={`${card} space-y-3 border-brand-success/50`}>
            <p className="text-brand-success">{step.text}</p>
            <Button type="button" onClick={next}>סריקה הבאה</Button>
          </div>
        )}
      </div>

      {overview && (
        <details className={card} data-testid="missing-barcodes">
          <summary className="cursor-pointer font-semibold text-brand-text">סיגריות בלי ברקוד: {missingCount}</summary>
          {missing.length === 0 ? (
            <p className="mt-2 text-sm text-brand-success">לכל הסיגריות באתר יש ברקוד.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {missing.map((g) => (
                <div key={g.group}>
                  <p className="text-sm font-semibold text-brand-gold">{g.group} ({g.names.length})</p>
                  <ul className="mt-1 text-sm text-brand-text-muted">
                    {g.names.map((n) => <li key={n.id}>{n.name}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </details>
      )}
    </section>
  );
}
