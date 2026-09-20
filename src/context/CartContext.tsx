import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCatalog } from "@/context/CatalogContext";
import { CART_STORAGE_KEY, loadCart } from "@/lib/cartStorage";
import {
  getLineTotalCents,
  getOptionLabel,
  getOptionPricing,
  getSavingsCents,
  isOptionInStock,
  type OptionPricing,
} from "@/lib/pricing";
import type { CartItem, Product, PurchaseOption } from "@/types";

/** Hebrew add-to-cart confirmation, always built from the actual product name — never hardcoded. */
function getAddToCartMessage(productName: string): string {
  return `המוצר ${productName} התווסף לעגלה ✓`;
}

export interface CartToast {
  id: number;
  message: string;
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
  /** Adds `quantity` of the option the customer chose. Never opens the cart — the user keeps shopping. */
  addItem: (productId: string, option: PurchaseOption, quantity?: number) => void;
  increment: (productId: string, option: PurchaseOption) => void;
  decrement: (productId: string, option: PurchaseOption) => void;
  removeLine: (productId: string, option: PurchaseOption) => void;
  /** Most recent "added to cart" toast, or null once dismissed/expired. */
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
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { products } = useCatalog();
  const [items, setItems] = useState<CartItem[]>(readInitialCart);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<CartToast | null>(null);
  const nextToastId = useRef(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // localStorage unavailable (private mode, quota, etc.) — fail silently
    }
  }, [items]);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const dismissToast = () => setToast(null);

  const addItem = (productId: string, option: PurchaseOption, quantity = 1) => {
    const product = productsById.get(productId);
    // Only options that exist and can be bought (the UI disables the buttons; this is the guard).
    if (!product || !isOptionInStock(product, option)) return;

    setItems((prev) => {
      const existing = prev.find((item) => item.productId === productId && item.option === option);
      if (existing) {
        return prev.map((item) => (item === existing ? { ...item, quantity: item.quantity + quantity } : item));
      }
      return [...prev, { productId, option, quantity }];
    });
    nextToastId.current += 1;
    setToast({ id: nextToastId.current, message: getAddToCartMessage(product.name) });
  };

  const increment = (productId: string, option: PurchaseOption) => addItem(productId, option, 1);

  const decrement = (productId: string, option: PurchaseOption) => {
    setItems((prev) =>
      prev
        .map((item) =>
          item.productId === productId && item.option === option ? { ...item, quantity: item.quantity - 1 } : item
        )
        .filter((item) => item.quantity > 0)
    );
  };

  const removeLine = (productId: string, option: PurchaseOption) => {
    setItems((prev) => prev.filter((item) => !(item.productId === productId && item.option === option)));
  };

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
          },
        ];
      }),
    [items, productsById]
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
    openCart: () => setIsOpen(true),
    closeCart: () => setIsOpen(false),
    addItem,
    increment,
    decrement,
    removeLine,
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
