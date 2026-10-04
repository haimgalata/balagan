import { test, expect } from "@playwright/test";
import { isDevHost } from "../../src/account/auth/devHost";

/** The addresses the real-database test login (dev only) may run on: this computer or a private network, never a public address. */
test("this computer and private networks are accepted", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "192.168.7.19", "192.168.0.1", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.255", "mypc.local", "Haims-Phone.local"]) {
    expect(isDevHost(host), host).toBe(true);
  }
});

test("public names and public addresses are refused, including look-alikes", () => {
  for (const host of ["", "  ", "example.com", "balagan.co.il", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "11.0.0.1", "192.168.1.1.evil.com", "localhost.evil.com", "10.0.0.1.example.com", "evil.local.example.com", "300.168.1.1", "192.168.1", "fe80::1"]) {
    expect(isDevHost(host), JSON.stringify(host)).toBe(false);
  }
});
