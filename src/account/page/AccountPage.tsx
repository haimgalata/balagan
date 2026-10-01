import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { AccountPanelBody } from "@/account/AccountPanel";
import { Card, Notice } from "@/account/page/pageUi";
import { OrdersTab } from "@/account/page/OrdersTab";
import { AddressesTab } from "@/account/page/AddressesTab";
import { DetailsTab } from "@/account/page/DetailsTab";
import { PreferencesTab } from "@/account/page/PreferencesTab";

type TabId = "orders" | "addresses" | "details" | "preferences";
const TABS: { id: TabId; label: string }[] = [
  { id: "orders", label: "ההזמנות שלי" },
  { id: "addresses", label: "כתובות" },
  { id: "details", label: "הפרטים שלי" },
  { id: "preferences", label: "העדפות" },
];

function PageHeader() {
  return (
    <header className="border-b border-brand-tobacco-strong bg-brand-bg-secondary">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-md p-1 text-sm text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <ArrowRight size={18} />
          חזרה לחנות
        </a>
        <span className="font-display text-xl text-brand-gold">בלאגן</span>
      </div>
    </header>
  );
}

/**
 * `/account` — the club member's personal area. Deliberately small: orders (with "order again"), saved addresses,
 * name/e-mail, and the marketing/deletion choices the law requires. Anyone who is not (yet) a member lands on the same
 * login panel the drawer and checkout use.
 */
export function AccountPage() {
  const { state } = useCustomerSession();
  const [tab, setTab] = useState<TabId>("orders");
  const [deleted, setDeleted] = useState(false);

  let content;
  if (state.status === "member") {
    const { profile } = state;
    content = (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-xl font-semibold text-brand-text">{profile.firstName ? `היי ${profile.firstName}` : "האזור האישי"}</h1>
          <p className="text-sm text-brand-text-muted">
            חבר/ת מועדון בלאגן · <span dir="ltr">{formatLocalPhone(profile.phone)}</span>
          </p>
        </div>

        <div role="tablist" aria-label="האזור האישי" className="grid grid-cols-2 gap-1 rounded-xl border border-brand-border bg-brand-bg-elevated p-1 sm:grid-cols-4">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`account-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`account-panel-${id}`}
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold ${
                tab === id ? "bg-brand-gold text-brand-bg" : "text-brand-text-muted hover:text-brand-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`account-panel-${tab}`} aria-labelledby={`account-tab-${tab}`}>
          {tab === "orders" && <OrdersTab />}
          {tab === "addresses" && <AddressesTab />}
          {tab === "details" && <DetailsTab profile={profile} />}
          {tab === "preferences" && <PreferencesTab profile={profile} onDeleted={() => setDeleted(true)} />}
        </div>
      </div>
    );
  } else if (deleted && state.status === "guest") {
    content = (
      <div className="flex flex-col gap-4">
        <Notice kind="success">החשבון נמחק. תודה שהייתם איתנו. אפשר תמיד להזמין כאורח, ולהצטרף שוב בכל עת.</Notice>
        <a href="/" className="text-sm text-brand-gold underline underline-offset-2">
          חזרה לחנות
        </a>
      </div>
    );
  } else {
    // loading / guest / needs-join / error: the same panel as the drawer and checkout, as a page
    content = (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-brand-text">האזור האישי</h1>
        <Card className="overflow-hidden !p-0">
          <AccountPanelBody />
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-bg">
      <PageHeader />
      <main className="mx-auto max-w-2xl px-4 py-8">{content}</main>
    </div>
  );
}
