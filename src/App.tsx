import { AgeGate } from "@/storefront/components/AgeGate";
import { Header } from "@/storefront/components/Header";
import { Footer } from "@/storefront/components/Footer";
import { CartDrawer } from "@/storefront/components/CartDrawer";
import { CartSummaryBar } from "@/storefront/components/CartSummaryBar";
import { Toast } from "@/storefront/components/Toast";
import { CatalogProvider } from "@/storefront/context/CatalogContext";
import { BusinessSettingsProvider } from "@/storefront/context/BusinessSettingsContext";
import { CartProvider } from "@/storefront/context/CartContext";
import { HomePage } from "@/storefront/pages/HomePage";

function App() {
  return (
    <CatalogProvider>
      <BusinessSettingsProvider>
        <CartProvider>
          <AgeGate />
          <Header />
          <HomePage />
          <Footer />
          <CartSummaryBar />
          <CartDrawer />
          <Toast />
        </CartProvider>
      </BusinessSettingsProvider>
    </CatalogProvider>
  );
}

export default App;
