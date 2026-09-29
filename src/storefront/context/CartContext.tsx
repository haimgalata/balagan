import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCatalog } from "@/storefront/context/CatalogContext";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { CART_STORAGE_KEY, loadCart } from "@/storefront/lib/cartStorage";
import {
  getLineBaseUnits,
  getLineTotalCents,
  getOptionLabel,
  getOptionPricing,
  getSavingsCents,
  isOptionInStock,
  type OptionPricing,
} from "@/storefront/lib/pricing";
import { checkStockAvailability } from "@/storefront/lib/stockApi";
import type { CartItem, Product, PurchaseOption } from "@/storefront/types";

const config = getCatalogConfig();

/** Hebrew add-to-cart confirmation, always built from the actual product name — never hardcoded. */
function getAddToCartMessage(productName: string): string {
  return `המוצר ${productName} התווסף לעגלה ✓`;
}
const STOCK_LIMIT_MESSAGE = "אי אפשר להוסיף כמות כזו — המלאי הזמין אינו מספיק.";
const STOCK_CHECK_FAILED_MESSAGE = "לא ניתן לבדוק את זמינות המלאי כרגע. נסו שוב בעוד רגע.";

export interface CartToast {
  id: number;
  message: string;
  /** "success" (added) vs. "warning" (blocked — not enough stock, or availability couldn't be confirmed). */
  kind: "success" | "warning";
}

/** One line of the cart: a product + the option the customer explicitly chose. */
export interface CartLine {
  /** Stable React key: `${productId}:${option}`. */
  key: string;
  product: Product;
  option: PurchaseOption;
  /** How many of THIS option (2 packages = 2, never 20 units). */
  quantity: number;
  /** "יחידה" or the product's package label. */
  label: string;
  pricing: OptionPricing;
  lineTotalCents: number;
  /** Saved versus the regular price, agorot (0 when not on sale). */
  savingsCents: number;
  /** False when this option is currently out of stock — shown as "אזל" and left out of count and total. */
  available: boolean;
  /**
   * True when the PRODUCT's total requested quantity (this line plus any of its other lines, in base units)
   * no longer fits the shared stock — checked when the cart opens, and after the customer adjusts a
   * flagged line (see CartProvider.revalidateProduct), never continuously. Independent of `available`.
   */
  overLimit: boolean;
}

interface CartContextValue {
  lines: CartLine[];
  /** Purchase items in the cart: one package counts as 1, two units as 2 (out-of-stock lines excluded). */
  totalCount: number;
  /** Cart total in agorot (out-of-stock lines excluded); format with `formatPrice`. */
  totalPriceCents: number;
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  /**
   * Adds `quantity` of the option the customer chose, after confirming (server-side) that the product's
   * resulting total still fits its shared stock — see src/lib/stockApi.ts. Resolves once settled; rejected
   * checks and stock-limit refusals leave the cart unchanged and surface a toast instead of throwing. Never
   * opens the cart — the user keeps shopping.
   */
  addItem: (productId: string, option: PurchaseOption, quantity?: number) => Promise<void>;
  increment: (productId: string, option: PurchaseOption) => Promise<void>;
  decrement: (productId: string, option: PurchaseOption) => void;
  removeLine: (productId: string, option: PurchaseOption) => void;
  /** Empties the cart outright — used once a real order has actually been created from it. */
  clearCart: () => void;
  /**
   * Re-checks every distinct product currently in the cart against its current shared stock (see
   * `revalidateCart` below) and returns once that pass has settled. `openCart` already fires this in the
   * background; checkout calls it directly (without opening the drawer) as part of its own validation.
   */
  revalidateCart: () => Promise<void>;
  /** Most recent toast (added / blocked), or null once dismissed/expired. */
  toast: CartToast | null;
  dismissToast: () => void;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

function readInitialCart(): CartItem[] {
  try {
    return loadCart(window.localStorage);
  } catch {
    return []; // storage unavailable (private mode etc.)
  }
}

/**
 * Cart state. Lines are (product, option) pairs kept under `balagan_cart_v2`; prices are never stored —
 * they are read live from the catalog, so a price change in the admin shows immediately. The previous
 * cart format is migrated once from `balagan_cart` (see `src/lib/cartStorage.ts`) and that old key is
 * never written or removed.
 *
 * A stored line whose product/option can't be resolved right now (catalog still loading, product hidden,
 * package removed) is not rendered or priced but stays in storage, and reappears if the product does.
 *
 * Shared-stock quantity check (added after Step 7): before ADDING or INCREASING any line, `addItem` asks
 * `check_stock_availability()` (supabase/migrations/0007_stock_availability.sql) whether the product's total
 * requested quantity — across ALL of its lines, unit and package converted to the same base-unit count —
 * still fits the shared pool. This never reserves stock and can't guarantee it a moment later; it only stops
 * the cart from silently growing past what is currently available. If the check itself can't be completed
 * (network error), the add is refused too (fail CLOSED) rather than let an unverified quantity through.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { products } = useCatalog();
  const [items, setItems] = useState<CartItem[]>(readInitialCart);
  // Mirrors `items` synchronously (React state commits are async/batched) so a chain of queued `addItem`
  // calls for the same product always computes its proposed quantity from the TRUE current cart — see commit().
  const itemsRef = useRef<CartItem[]>(items);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<CartToast | null>(null);
  /** Product ids whose total in-cart quantity no longer fits the shared stock (see revalidateCart). */
  const [overLimitProducts, setOverLimitProducts] = useState<ReadonlySet<string>>(new Set());
  const nextToastId = useRef(0);
  /** One promise chain per product, so rapid clicks on the SAME product are checked one at a time against
   * the up-to-date cart instead of racing each other (different products run independently). */
  const pendingByProduct = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // localStorage unavailable (private mode, quota, etc.) — fail silently
    }
  }, [items]);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const showToast = (message: string, kind: CartToast["kind"]) => {
    nextToastId.current += 1;
    setToast({ id: nextToastId.current, message, kind });
  };
  const dismissToast = () => setToast(null);

  /** The one place cart contents actually change: keeps the ref and the React state in lockstep. */
  const commit = (next: CartItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const baseUnitsInCartFor = (productId: string, product: Product): number =>
    itemsRef.current
      .filter((item) => item.productId === productId)
      .reduce((sum, item) => sum + getLineBaseUnits(product, item.option, item.quantity), 0);

  /** The actual add — runs only after any earlier queued add for the SAME product has fully settled (see addItem). */
  const performAdd = async (productId: string, option: PurchaseOption, quantity: number): Promise<void> => {
    const product = productsById.get(productId);
    // Only options that exist and can be bought at all (the UI disables the buttons; this is the guard).
    if (!product || !isOptionInStock(product, option)) return;

    const proposedBaseUnits = baseUnitsInCartFor(productId, product) + getLineBaseUnits(product, option, quantity);
    let results;
    try {
      results = await checkStockAvailability(config, [{ productId, baseUnits: proposedBaseUnits }]);
    } catch {
      // Fail CLOSED: the customer must know availability was actually confirmed — never add on an unverified check.
      showToast(STOCK_CHECK_FAILED_MESSAGE, "warning");
      return;
    }
    if (results.find((r) => r.productId === productId)?.available !== true) {
      showToast(STOCK_LIMIT_MESSAGE, "warning");
      return;
    }

    const existing = itemsRef.current.find((item) => item.productId === productId && item.option === option);
    const next = existing
      ? itemsRef.current.map((item) => (item === existing ? { ...item, quantity: item.quantity + quantity } : item))
      : [...itemsRef.current, { productId, option, quantity }];
    commit(next);
    showToast(getAddToCartMessage(product.name), "success");
  };

  const addItem = (productId: string, option: PurchaseOption, quantity = 1): Promise<void> => {
    const queued = (pendingByProduct.current.get(productId) ?? Promise.resolve()).then(() => performAdd(productId, option, quantity));
    const settled = queued.catch(() => undefined);
    pendingByProduct.current.set(productId, settled);
    void settled.finally(() => {
      if (pendingByProduct.current.get(productId) === settled) pendingByProduct.current.delete(productId);
    });
    return settled;
  };

  const increment = (productId: string, option: PurchaseOption) => addItem(productId, option, 1);

  /** Re-checks ONE product's current in-cart total against its current shared stock and updates the flag. */
  const revalidateProduct = async (productId: string): Promise<void> => {
    const product = productsById.get(productId);
    const stillInCart = itemsRef.current.some((item) => item.productId === productId);
    if (!product || !stillInCart) {
      setOverLimitProducts((current) => {
        if (!current.has(productId)) return current;
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
      return;
    }
    try {
      const [result] = await checkStockAvailability(config, [{ productId, baseUnits: baseUnitsInCartFor(productId, product) }]);
      setOverLimitProducts((current) => {
        const next = new Set(current);
        if (result?.available === false) next.add(productId);
        else next.delete(productId);
        return next;
      });
    } catch {
      // couldn't verify right now — leave whatever was already shown; the next cart-open retries
    }
  };

  /** Re-checks every distinct product currently in the cart — catches stock that dropped after the customer
   * already added items. `openCart` fires this in the background and never waits on it; checkout awaits it. */
  const revalidateCart = async (): Promise<void> => {
    const productIds = [...new Set(itemsRef.current.map((item) => item.productId))];
    await Promise.all(productIds.map((id) => revalidateProduct(id)));
  };

  const decrement = (productId: string, option: PurchaseOption) => {
    const next = itemsRef.current
      .map((item) => (item.productId === productId && item.option === option ? { ...item, quantity: item.quantity - 1 } : item))
      .filter((item) => item.quantity > 0);
    commit(next);
    if (overLimitProducts.has(productId)) void revalidateProduct(productId); // the reduction may have resolved it
  };

  const removeLine = (productId: string, option: PurchaseOption) => {
    const next = itemsRef.current.filter((item) => !(item.productId === productId && item.option === option));
    commit(next);
    if (overLimitProducts.has(productId)) void revalidateProduct(productId);
  };

  const clearCart = () => commit([]);

  const lines: CartLine[] = useMemo(
    () =>
      items.flatMap((item) => {
        const product = productsById.get(item.productId);
        if (!product) return [];
        const pricing = getOptionPricing(product, item.option);
        if (!pricing) return [];
        return [
          {
            key: `${item.productId}:${item.option}`,
            product,
            option: item.option,
            quantity: item.quantity,
            label: getOptionLabel(product, item.option),
            pricing,
            lineTotalCents: getLineTotalCents(pricing, item.quantity),
            savingsCents: getSavingsCents(pricing, item.quantity),
            available: isOptionInStock(product, item.option),
            overLimit: overLimitProducts.has(item.productId),
          },
        ];
      }),
    [items, productsById, overLimitProducts]
  );

  const totalCount = useMemo(
    () => lines.reduce((sum, line) => (line.available ? sum + line.quantity : sum), 0),
    [lines]
  );
  const totalPriceCents = useMemo(
    () => lines.reduce((sum, line) => (line.available ? sum + line.lineTotalCents : sum), 0),
    [lines]
  );

  const value: CartContextValue = {
    lines,
    totalCount,
    totalPriceCents,
    isOpen,
    openCart: () => {
      setIsOpen(true);
      void revalidateCart();
    },
    closeCart: () => setIsOpen(false),
    addItem,
    increment,
    decrement,
    removeLine,
    clearCart,
    revalidateCart,
    toast,
    dismissToast,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within a CartProvider");
  return ctx;
}
