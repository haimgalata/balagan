import { AgeGate } from "@/components/AgeGate";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CartDrawer } from "@/components/CartDrawer";
import { Toast } from "@/components/Toast";
import { CartProvider } from "@/context/CartContext";
import { HomePage } from "@/pages/HomePage";

function App() {
  return (
    <CartProvider>
      <AgeGate />
      <Header />
      {/* Reserves the space the fixed header occupies when visible — must match its height classes. */}
      <div className="h-12 lg:h-14" aria-hidden="true" />
      <HomePage />
      <Footer />
      <CartDrawer />
      <Toast />
    </CartProvider>
  );
}

export default App;
