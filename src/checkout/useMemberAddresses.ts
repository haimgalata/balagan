import { useEffect, useState } from "react";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { getMyAddresses } from "@/account/memberApi";
import type { SavedAddress } from "@/account/types";

export type MemberAddressesState =
  | { status: "idle"; addresses: SavedAddress[] } //     not a member (or no token): nothing to load
  | { status: "loading"; addresses: SavedAddress[] }
  | { status: "ready"; addresses: SavedAddress[] };

const config = getCatalogConfig();

/**
 * The signed-in member's saved addresses, loaded once per sign-in. A failure is deliberately NOT an error state:
 * saved addresses are a convenience, so the form just starts empty (the member types the address, and the database
 * saves it again after the order) — checkout never blocks on them.
 */
export function useMemberAddresses(accessToken: string | null): MemberAddressesState {
  const [state, setState] = useState<MemberAddressesState>({ status: accessToken ? "loading" : "idle", addresses: [] });

  useEffect(() => {
    if (!accessToken) {
      setState({ status: "idle", addresses: [] });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", addresses: [] });
    getMyAddresses(config, accessToken)
      .then((addresses) => {
        if (!cancelled) setState({ status: "ready", addresses });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "ready", addresses: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return state;
}
