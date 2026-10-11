import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/refresh/route";
import { safeLaunchUrl } from "../lib/producthunt";
import { isRealGenerate } from "../lib/notify";
import { isBrowserSameOrigin } from "../lib/origin";

// Rule: /api/refresh does no work without the bearer secret (it fails closed), for GET and POST alike.
describe("/api/refresh authorisation", () => {
  const saved = process.env.CRON_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  const call = (m: typeof GET, headers: Record<string, string> = {}) => m(new Request("https://ph-scout.vercel.app/api/refresh", { method: "POST", headers }));

  it("is 401 when no secret is configured, even if a header is sent (fails closed)", async () => {
    delete process.env.CRON_SECRET;
    for (const m of [GET, POST]) {
      expect((await call(m)).status).toBe(401);
      expect((await call(m, { authorization: "Bearer " })).status).toBe(401);
      expect((await call(m, { authorization: "Bearer undefined" })).status).toBe(401);
    }
  });
  it("is 401 with no header, a wrong secret, a secret of the right length, or no Bearer prefix", async () => {
    process.env.CRON_SECRET = "s3cret-value-for-test";
    for (const m of [GET, POST]) {
      expect((await call(m)).status).toBe(401);
      expect((await call(m, { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await call(m, { authorization: "Bearer s3cret-value-for-tesX" })).status).toBe(401);
      expect((await call(m, { authorization: "s3cret-value-for-test" })).status).toBe(401);
    }
  });
  it("does not leak the secret or any detail in the 401 body", async () => {
    process.env.CRON_SECRET = "s3cret-value-for-test";
    const res = await call(GET, { authorization: "Bearer wrong" });
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "Unauthorized" }));
    expect(text).not.toContain("s3cret");
  });
});

// The browser-header check is a convenience boundary, not authentication. These tests document exactly what it does and does not stop.
describe("browser header check (convenience boundary)", () => {
  it("rejects requests without browser headers and requests from another site", () => {
    expect(isRealGenerate(new Headers(), false)).toBe(false);
    expect(isRealGenerate(new Headers({ "sec-fetch-site": "cross-site" }), false)).toBe(false);
    expect(isRealGenerate(new Headers({ origin: "https://evil.example", host: "ph-scout.vercel.app" }), false)).toBe(false);
    expect(isBrowserSameOrigin(new Headers({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
  it("a client that deliberately sets the header passes (known limit: the 1 per 5 minutes cooldown is the real protection)", () => {
    expect(isRealGenerate(new Headers({ "sec-fetch-site": "same-origin" }), false)).toBe(true);
    expect(isBrowserSameOrigin(new Headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("Refresh now never counts as a real Generate, even with the header", () => {
    expect(isRealGenerate(new Headers({ "sec-fetch-site": "same-origin" }), true)).toBe(false);
  });
});

describe("safeLaunchUrl", () => {
  it("keeps a Product Hunt link and drops the tracking query", () => {
    expect(safeLaunchUrl("https://www.producthunt.com/products/velozity-2?utm_source=x")).toBe("https://www.producthunt.com/products/velozity-2");
  });
  it("replaces anything else with the site home", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://www.producthunt.com/p", "https://evil.example/products/x", "https://www.producthunt.com.evil.example/p", "", null, undefined, "https://www.producthunt.com/a b"]) {
      expect(safeLaunchUrl(bad)).toBe("https://www.producthunt.com/");
    }
  });
});
