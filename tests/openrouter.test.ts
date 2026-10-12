import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primarySignal, withBackup } from "../lib/ai-backup";
import { callGemini, geminiConfigured } from "../lib/gemini";
import type { Launch } from "../lib/types";
import { openrouterJson } from "../lib/openrouter";

const KEY = "sk-or-v1-TESTKEY-not-a-real-key";
const baseReq = () => ({ system: "SYS", user: "USER", schemaName: "t", schema: { type: "object", properties: {} }, temperature: 0.2, signal: new AbortController().signal });
const okResponse = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { OR: process.env.OPENROUTER_API_KEY, G: process.env.GEMINI_API_KEY, M: process.env.OPENROUTER_MODEL };
  process.env.OPENROUTER_API_KEY = KEY;
  delete process.env.OPENROUTER_MODEL;
});
afterEach(() => {
  for (const [k, v] of [["OPENROUTER_API_KEY", saved.OR], ["GEMINI_API_KEY", saved.G], ["OPENROUTER_MODEL", saved.M]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("openrouterJson (backup route to Gemini Flash)", () => {
  it("sends one request to OpenRouter with Google-only routing, the key only in the header, and returns the parsed JSON", async () => {
    const f = vi.fn(async () => okResponse('{"results":[1]}'));
    const out = await openrouterJson(baseReq(), f as unknown as typeof fetch);
    expect(out).toEqual({ results: [1] });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.provider).toEqual({ only: ["google-vertex", "google-ai-studio"], allow_fallbacks: false });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
    expect(String(init.body)).not.toContain(KEY); // the key is never in the body
  });
  it("accepts JSON wrapped in a code fence", async () => {
    const f = vi.fn(async () => okResponse('```json\n{"a":1}\n```'));
    expect(await openrouterJson(baseReq(), f as unknown as typeof fetch)).toEqual({ a: 1 });
  });
  it("throws a plain error (status only, no body, no key) when OpenRouter answers an error", async () => {
    const f = vi.fn(async () => new Response(`denied for ${KEY}`, { status: 401 }));
    const err = await openrouterJson(baseReq(), f as unknown as typeof fetch).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("OpenRouter answered 401");
    expect((err as Error).message).not.toContain(KEY);
  });
  it("throws on empty content, missing choices and invalid JSON", async () => {
    for (const make of [() => okResponse(""), () => okResponse(null), () => new Response("{}", { status: 200 }), () => okResponse("not json")]) {
      await expect(openrouterJson(baseReq(), (async () => make()) as unknown as typeof fetch)).rejects.toThrow();
    }
  });
  it("refuses any model that is not a google/ model, before making a request", async () => {
    process.env.OPENROUTER_MODEL = "anthropic/claude-something";
    const f = vi.fn();
    await expect(openrouterJson(baseReq(), f as unknown as typeof fetch)).rejects.toThrow(/google\//);
    expect(f).not.toHaveBeenCalled();
  });
  it("does nothing without a key (no request)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const f = vi.fn();
    await expect(openrouterJson(baseReq(), f as unknown as typeof fetch)).rejects.toThrow(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });
  it("passes the abort signal on", async () => {
    const ctl = new AbortController();
    const f = vi.fn(async () => okResponse("{}"));
    await openrouterJson({ ...baseReq(), signal: ctl.signal }, f as unknown as typeof fetch);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
  });
});

describe("withBackup (Google first, OpenRouter only when Google fails)", () => {
  it("uses Google and never touches the backup when Google works", async () => {
    process.env.GEMINI_API_KEY = "g";
    const backup = vi.fn(async () => "backup");
    expect(await withBackup(async () => "google", backup, true)).toBe("google");
    expect(backup).not.toHaveBeenCalled();
  });
  it("falls back when Google throws and the backup is configured", async () => {
    process.env.GEMINI_API_KEY = "g";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await withBackup(async () => { throw new Error("quota"); }, async () => "backup", true)).toBe("backup");
    expect(log).toHaveBeenCalledWith("ai backup used"); // outcome only
  });
  it("rethrows Google's own error when there is no backup", async () => {
    process.env.GEMINI_API_KEY = "g";
    await expect(withBackup(async () => { throw new Error("quota"); }, async () => "backup", false)).rejects.toThrow("quota");
  });
  it("rethrows Google's original error (not the backup's) when both fail", async () => {
    process.env.GEMINI_API_KEY = "g";
    await expect(withBackup(async () => { throw new Error("google down"); }, async () => { throw new Error("gateway down"); }, true)).rejects.toThrow("google down");
  });
  it("goes straight to the backup when there is no Google key, without calling Google", async () => {
    delete process.env.GEMINI_API_KEY;
    const primary = vi.fn(async () => "google");
    expect(await withBackup(primary, async () => "backup", true)).toBe("backup");
    expect(primary).not.toHaveBeenCalled();
  });
  it("without a Google key and without a backup, Google is tried and its error surfaces (as before)", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(withBackup(async () => { throw new Error("no key"); }, async () => "backup", false)).rejects.toThrow("no key");
  });
});

describe("configuration and rules", () => {
  it("counts the backup key as 'AI configured'", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(geminiConfigured()).toBe(false);
    process.env.OPENROUTER_API_KEY = KEY;
    expect(geminiConfigured()).toBe(true);
  });
  it("only lib/openrouter.ts talks to openrouter.ai, and the page never mentions OpenRouter or its key", () => {
    const files = [...readdirSync("lib").map((f) => `lib/${f}`), "app/page.tsx", "app/layout.tsx", "app/api/scout/route.ts", "app/api/send/route.ts", "app/api/draft/route.ts", "app/api/refresh/route.ts"];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (f !== "lib/openrouter.ts") expect(text, f).not.toContain("openrouter.ai");
    }
    expect(readFileSync("app/page.tsx", "utf8")).not.toMatch(/openrouter|OPENROUTER/i);
  });
  it("no other AI vendor is called anywhere", () => {
    for (const f of readdirSync("lib").map((x) => `lib/${x}`)) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/api\.openai\.com|api\.anthropic\.com|x\.ai\/|api\.mistral|cohere\.(ai|com)/i);
    }
  });
  it("the real backup request carries public launch text only (no makers, hunter, ids of people) and unwraps {results}", async () => {
    delete process.env.GEMINI_API_KEY; // no Google key: callGemini goes straight to the backup route
    const launch: Launch = {
      id: "42", name: "Acme", tagline: "Plan work", description: "A planning tool", slug: "acme", url: "https://www.producthunt.com/products/acme",
      votesCount: 10, commentsCount: 2, createdAt: "2026-10-10T00:00:00Z", featuredAt: null, topics: [{ slug: "t", name: "Productivity" }], viaSlugs: ["t"],
      makers: [{ id: "m9", name: "Secret Maker", username: "secretmaker" }], hunter: { name: "Secret Hunter", username: "secrethunter" },
    };
    let sent = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      sent = String((init as RequestInit).body);
      const row = { id: "42", oneLiner: "x", fit: "strong", fitReason: "y", angle: "z", evidenceQuote: "q" };
      return okResponse(JSON.stringify({ results: [row] }));
    });
    const out = await callGemini([launch], new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("42");
    expect(sent).toContain("Acme");
    expect(sent).not.toMatch(/Secret|secretmaker|secrethunter|m9|makers|hunter/i);
    expect(sent).not.toContain(KEY);
  });
  it("no other AI vendor package or API is used anywhere (app, lib, package.json)", () => {
    const pkg = readFileSync("package.json", "utf8");
    expect(pkg).not.toMatch(/@anthropic-ai|"openai"|@ai-sdk|"ai":|@mistralai|cohere-ai|groq-sdk/i);
    const files = ["lib", "app", "app/api/scout", "app/api/send", "app/api/draft", "app/api/refresh"].flatMap((d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${d}/${e.name}`));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/from ["'](openai|@anthropic-ai|@ai-sdk|groq-sdk|cohere-ai|@mistralai)/);
  });
  it("a Google call that hangs is cut off after its own cap, so the backup still has time (primarySignal)", async () => {
    process.env.GEMINI_API_KEY = "test-google-key"; // restored by afterEach; without it withBackup goes straight to the backup
    const overall = new AbortController();
    const hang = (signal: AbortSignal) => new Promise<string>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    let backupSawLiveSignal = false;
    const out = await withBackup(
      () => hang(primarySignal(overall.signal, 30, true)),
      async () => { backupSawLiveSignal = !overall.signal.aborted; return "from backup"; },
      true,
    );
    expect(out).toBe("from backup");
    expect(backupSawLiveSignal).toBe(true);
  });
  it("primarySignal leaves the caller's signal alone when no backup is configured, and still honours the caller's abort", () => {
    const c = new AbortController();
    expect(primarySignal(c.signal, 10, false)).toBe(c.signal);
    const s = primarySignal(c.signal, 60_000, true);
    expect(s.aborted).toBe(false);
    c.abort();
    expect(s.aborted).toBe(true);
  });
});
