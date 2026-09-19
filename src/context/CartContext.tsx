import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useCatalog } from "@/context/CatalogContext";
import { UNITS_PER_PACK, getPriceBreakdown, type PriceBreakdown } from "@/lib/pricing";
import type { CartItem, Product } from "@/types";
import { useLocalStorage } from "@/hooks/useLocalStorage";

const CART_STORAGE_KEY = "balagan_cart";

/** Hebrew add-to-cart confirmation, always built from the actual product name — never hardcoded. */
function getAddToCartMessage(productName: string): string {
  return `המוצר ${productName} התווסף לעגלה ✓`;
}

export interface CartToast {
  id: number;
  message: string;
}

export interface CartLine {
  product: Product;
  /** Total units of this product in the cart. */
  quantity: number;
  breakdown: PriceBreakdown;
}

interface CartContextValue {
  lines: CartLine[];
  /** Total physical units across the whole cart. */
  totalCount: number;
  totalPrice: number;
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  /** Adds `quantity` units of a product. Never opens the cart — the user keeps shopping. */
  addUnits: (productId: string, quantity: number) => void;
  increment: (productId: string) => void;
  decrement: (productId: string) => void;
  removeItem: (productId: string) => void;
  /** Most recent "added to cart" toast, or null once dismissed/expired. */
  toast: CartToast | null;
  dismissToast: () => void;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

/**
 * Cleans whatever was read from localStorage before it becomes cart state.
 * The cart model is "quantity = total units for a product". This also
 * migrates the older per-line-type (separate unit/pack lines) cart shape
 * into that model — a stored "pack" line's quantity counted packs, not
 * units, so it's expanded ×`UNITS_PER_PACK` here — and drops anything with a
 * malformed id or a bad quantity, so a corrupted cart never crashes the app.
 *
 * Deliberately does NOT check ids against the catalog: the catalog is loaded
 * asynchronously (and products can be hidden/removed in the admin), so an id
 * that can't be resolved right now must not be erased from storage. Such lines
 * are simply not rendered or priced — see `lines` below — and reappear if the
 * product does.
 */
function sanitizeCartItems(raw: CartItem[]): CartItem[] {
  if (!Array.isArray(raw)) return [];

  const totals = new Map<string, number>();
  for (const entry of raw as unknown as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.productId !== "string") continue;

    const rawQuantity = typeof entry.quantity === "number" ? Math.floor(entry.quantity) : 0;
    if (rawQuantity <= 0) continue;

    const units = entry.type === "pack" ? rawQuantity * UNITS_PER_PACK : rawQuantity;
    totals.set(entry.productId, (totals.get(entry.productId) ?? 0) + units);
  }

  return Array.from(totals.entries()).map(([productId, quantity]) => ({ productId, quantity }));
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { products } = useCatalog();
  const [items, setItems] = useLocalStorage<CartItem[]>(CART_STORAGE_KEY, [], sanitizeCartItems);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<CartToast | null>(null);
  const nextToastId = useRef(0);

  const dismissToast = () => setToast(null);

  const addUnits = (productId: string, quantity: number) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.productId === productId);
      if (existing) {
        return prev.map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity + quantity } : item
        );
      }
      return [...prev, { productId, quantity }];
    });
    nextToastId.current += 1;
    const product = products.find((p) => p.id === productId);
    setToast({ id: nextToastId.current, message: getAddToCartMessage(product?.name ?? "") });
  };

  const increment = (productId: string) => addUnits(productId, 1);

  const decrement = (productId: string) => {
    setItems((prev) =>
      prev
        .map((item) => (item.productId === productId ? { ...item, quantity: item.quantity - 1 } : item))
        .filter((item) => item.quantity > 0)
    );
  };

  const removeItem = (productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId));
  };

  const lines: CartLine[] = useMemo(
    () =>
      items
        .map((item) => {
          const product = products.find((p) => p.id === item.productId);
          if (!product) return null;
          return {
            product,
            quantity: item.quantity,
            breakdown: getPriceBreakdown(product.unitPrice, item.quantity),
          };
        })
        .filter((line): line is CartLine => line !== null),
    [items, products]
  );

  const totalCount = useMemo(() => lines.reduce((sum, l) => sum + l.quantity, 0), [lines]);
  const totalPrice = useMemo(() => lines.reduce((sum, l) => sum + l.breakdown.finalTotal, 0), [lines]);

  const value: CartContextValue = {
    lines,
    totalCount,
    totalPrice,
    isOpen,
    openCart: () => setIsOpen(true),
    closeCart: () => setIsOpen(false),
    addUnits,
    increment,
    decrement,
    removeItem,
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
