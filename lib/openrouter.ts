import { OPENROUTER_DEFAULT_MODEL } from "./config";

// BACKUP route to Gemini Flash. The app always tries Google directly first (@google/genai). Only when that call fails, and only when
// OPENROUTER_API_KEY is set, the same request is sent through the OpenRouter gateway to Google's own Gemini Flash model. Rules:
// only "google/" models, only Google's own infrastructure (provider.only) and no fallback to any other provider. The input is the
// same public launch text the direct call sends: never maker names. The key stays in the server environment and is never logged.

export const openrouterConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);
export const openrouterModel = () => process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;

const URL_CHAT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>; // a plain JSON Schema whose root is an object
  temperature: number;
  signal: AbortSignal;
}

/** Calls the Google model through OpenRouter and returns the parsed JSON answer. Throws a plain Error (status only) on any problem. */
export async function openrouterJson(req: OpenRouterJsonRequest, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OpenRouter is not configured");
  const model = openrouterModel();
  if (!model.startsWith("google/")) throw new Error("Only google/ models are allowed through OpenRouter");
  const res = await fetchFn(URL_CHAT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature,
      response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      provider: { only: ["google-vertex", "google-ai-studio"], allow_fallbacks: false },
      reasoning: { effort: "low" }, // the same low "thinking" level the direct Google call uses; measured: 11 s instead of 25 s per batch
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter returned no content");
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(text);
}
