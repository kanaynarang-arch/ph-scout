import { describe, expect, it } from "vitest";
import { draftInput, FIRST_NAME, handleDraft, isBrowserSameOrigin, sanitizeDraft, type DraftDeps, type DraftSource } from "../lib/draft";
import type { Launch } from "../lib/types";

const launch: Launch = {
  id: "42", name: "Velozity", tagline: "The Multiplayer AI Office", description: "Chat, audio and video calls with transcripts, tasks, calendar and files.",
  slug: "velozity", url: "https://www.producthunt.com/products/velozity", votesCount: 10, commentsCount: 2, createdAt: "2026-10-08T07:01:00Z", featuredAt: null,
  topics: [{ slug: "team-communication", name: "Team Communication" }], viaSlugs: [],
  makers: [{ id: "m1", name: "Ishu Darshan", username: "ishu" }], hunter: { name: "Hunter Person", username: "hp" },
};
const src: DraftSource = { launch, angle: "Your workspace consolidates chat; our async standups replace live meetings." };
const GOOD = `Hi ${FIRST_NAME},\n\nI saw Velozity brings chat, calls and tasks into one place for distributed teams. At our company we run async standups so remote teams can post a written daily update instead of joining a live meeting, and I think that could sit nicely next to what you are building.\n\nWould you be open to a quick 15 minute call next week to compare notes?\n\nKavya`;

describe("sanitizeDraft", () => {
  it("accepts a good draft and keeps the placeholder", () => {
    const d = sanitizeDraft({ subject: "Async standups for Velozity teams", body: GOOD });
    expect(d?.body.startsWith(`Hi ${FIRST_NAME},`)).toBe(true);
    expect(d?.body.trim().endsWith("Kavya")).toBe(true);
  });
  it("adds the greeting placeholder and the sign-off when they are missing", () => {
    const d = sanitizeDraft({ subject: "Async standups for Velozity", body: GOOD.replace(`Hi ${FIRST_NAME},\n\n`, "").replace("\n\nKavya", "") });
    expect(d?.body.startsWith(`Hi ${FIRST_NAME},`)).toBe(true);
    expect(d?.body.trim().endsWith("Kavya")).toBe(true);
  });
  it("normalises other placeholder spellings", () => {
    const d = sanitizeDraft({ subject: "Async standups for Velozity", body: GOOD.replace(FIRST_NAME, "[First name]") });
    expect(d?.body).toContain(FIRST_NAME);
    expect(d?.body).not.toContain("[First name]");
  });
  it("rejects links, email addresses, bad shapes and absurd lengths", () => {
    expect(sanitizeDraft({ subject: "Hello there", body: GOOD + " See https://example.com" })).toBeNull();
    expect(sanitizeDraft({ subject: "Hello there", body: GOOD + " Mail me at kavya@example.com" })).toBeNull();
    expect(sanitizeDraft({ subject: "Hello there", body: "Hi" })).toBeNull();
    expect(sanitizeDraft({ subject: "x", body: GOOD })).toBeNull();
    expect(sanitizeDraft({ subject: "Hello there", body: "a".repeat(2000) })).toBeNull();
    expect(sanitizeDraft(null)).toBeNull();
    expect(sanitizeDraft({ subject: 1, body: 2 })).toBeNull();
  });
});

describe("what Gemini receives", () => {
  it("is public launch text and the angle only: no maker, hunter or any person's name", () => {
    const json = JSON.stringify(draftInput(src));
    expect(json).toContain("Velozity");
    expect(json).not.toContain("Ishu");
    expect(json).not.toContain("Darshan");
    expect(json).not.toContain("Hunter Person");
    expect(json).not.toContain("m1");
  });
});

const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const req = (body: unknown, headers: Record<string, string> = SAME) => new Request("https://ph-scout.vercel.app/api/draft", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const deps = (over: Partial<DraftDeps> = {}): DraftDeps => ({
  lookup: async (id) => (id === "42" ? src : null),
  draftFor: async () => ({ subject: "Async standups for Velozity", body: GOOD }),
  ...over,
});

describe("isBrowserSameOrigin", () => {
  it("accepts same-origin and a matching Origin header, rejects everything else", () => {
    expect(isBrowserSameOrigin(new Headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isBrowserSameOrigin(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isBrowserSameOrigin(new Headers({ origin: "https://a.example", host: "a.example" }))).toBe(true);
    expect(isBrowserSameOrigin(new Headers({ origin: "https://evil.example", host: "a.example" }))).toBe(false);
    expect(isBrowserSameOrigin(new Headers())).toBe(false);
  });
});

describe("handleDraft", () => {
  it("returns a draft for a known launch id", async () => {
    const out = await handleDraft(req({ id: "42" }), deps());
    expect(out.status).toBe(200);
    expect(String(out.body.body)).toContain(FIRST_NAME);
  });
  it("refuses calls that do not come from the page", async () => {
    let called = false;
    const out = await handleDraft(req({ id: "42" }, { "content-type": "application/json" }), deps({ lookup: async () => { called = true; return src; } }));
    expect(out.status).toBe(403);
    expect(called).toBe(false);
  });
  it("only accepts a launch id, never text: bad bodies and ids are refused", async () => {
    expect((await handleDraft(req("not json"), deps())).status).toBe(400);
    expect((await handleDraft(req({ id: "../etc/passwd" }), deps())).status).toBe(400);
    expect((await handleDraft(req({ id: 42 }), deps())).status).toBe(400);
    expect((await handleDraft(req({ id: "42", text: "x".repeat(600) }), deps())).status).toBe(400);
  });
  it("says so when the launch is not in the saved list", async () => {
    const out = await handleDraft(req({ id: "999" }), deps());
    expect(out.status).toBe(404);
  });
  it("fails calmly when Gemini or the check fails, never sending anything", async () => {
    const out = await handleDraft(req({ id: "42" }), deps({ draftFor: async () => { throw new Error("boom"); } }));
    expect(out.status).toBe(503);
    expect(String(out.body.error)).toMatch(/unavailable/i);
  });
});

describe("short direct message (dm) channel", () => {
  const DM = `Hi ${FIRST_NAME},\n\nVelozity pulling chat, calls and tasks into one place caught my eye. We run async standups for remote teams, so I think our products could sit well together. Open to a quick chat next week?\n\nKavya`;
  it("needs no subject and allows a shorter message", () => {
    const d = sanitizeDraft({ subject: "DM", body: DM }, "dm");
    expect(d?.subject).toBe("");
    expect(d?.body.startsWith(`Hi ${FIRST_NAME},`)).toBe(true);
    expect(sanitizeDraft({ subject: "DM", body: DM }, "email")).toBeNull(); // an email still needs a real subject
    expect(sanitizeDraft({ subject: "Async standups for Velozity", body: DM }, "email")).not.toBeNull();
  });
  it("applies the same safety rules: no links or email addresses, sign-off enforced", () => {
    expect(sanitizeDraft({ subject: "DM", body: DM + " https://x.example" }, "dm")).toBeNull();
    expect(sanitizeDraft({ subject: "DM", body: DM.replace("\n\nKavya", "") }, "dm")?.body.trim().endsWith("Kavya")).toBe(true);
  });
  it("the handler passes the channel through, and anything except dm means email", async () => {
    const seen: string[] = [];
    const d = { lookup: async () => src, draftFor: async (_s: DraftSource, c: string) => { seen.push(c); return { subject: "s", body: DM }; } } as unknown as DraftDeps;
    await handleDraft(req({ id: "42", channel: "dm" }), d);
    await handleDraft(req({ id: "42", channel: "carrier-pigeon" }), d);
    await handleDraft(req({ id: "42" }), d);
    expect(seen).toEqual(["dm", "email", "email"]);
  });
});
