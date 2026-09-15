import { AgeGate } from "@/components/AgeGate";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CartDrawer } from "@/components/CartDrawer";
import { CartSummaryBar } from "@/components/CartSummaryBar";
import { Toast } from "@/components/Toast";
import { CartProvider } from "@/context/CartContext";
import { HomePage } from "@/pages/HomePage";

function App() {
  return (
    <CartProvider>
      <AgeGate />
      <Header />
      <HomePage />
      <Footer />
      <CartSummaryBar />
      <CartDrawer />
      <Toast />
    </CartProvider>
  );
}

export default App;
