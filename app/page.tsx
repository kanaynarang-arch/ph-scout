"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, EXTRA_CATEGORIES, MAX_EXTRAS, categoryLabel, parseExtras, type CategoryId, type ExtraCategoryId } from "@/lib/categories";
import { rowsLabel, toCsv, type CsvRow } from "@/lib/csv";
import { WINDOW_DAYS } from "@/lib/config";
import { MAX_IMPORT_BYTES, daysLeftText, exportContacted, mergeContacted, parseContactedImport } from "@/lib/contacted";
import type { ScoredLaunch, ScoutResponse } from "@/lib/types";

const LAST_VISIT_KEY = "ph-scout:lastVisit";
const URGENCY_TEXT = { hot: "Hot: contact now", week: "Contact this week", closing: "Window closing" } as const;
const DENSITY_KEY = "ph-scout:density";
const FIT_TEXT = { strong: "Strong fit", possible: "Partial fit", weak: "Weak fit", competitor: "Likely competitor", unrated: "Not rated" } as const;

/** Copy text to the clipboard, with a fallback for browsers that block the async clipboard API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });


/** The score counts up once when a card appears (skipped when the visitor prefers reduced motion). */
function Score({ value, animate }: { value: number; animate: boolean }) {
  const [shown, setShown] = useState(value);
  useLayoutEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 400);
      setShown(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setShown(0);
    raf = requestAnimationFrame(tick);
    const done = setTimeout(() => setShown(value), 450); // never leave a stale number if frames are paused (background tab)
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [value, animate]);
  // Only show the animated number while this card is animating; otherwise always the real score (a card that moves out of the
  // top 10 after a filter change must never keep a half-finished animation value).
  return <>{(animate ? shown : value).toFixed(1)}</>;
}

/** Search by product name, one-liner or visible founder names (case-insensitive). Only hides rows. */
function matchesQuery(r: ScoredLaunch, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [r.name, r.ai.oneLiner, r.tagline, ...r.founders.names].some((t) => t.toLowerCase().includes(q));
}

function Founder({ r }: { r: ScoredLaunch }) {
  const { names, hiddenCount, hunter, people } = r.founders;
  if (names.length) {
    const list = people && people.length === names.length ? people : names.map((name) => ({ name, url: null as string | null }));
    return (
      <>
        {list.map((p, i) => (
          <span key={`${p.name}-${i}`}>
            {i > 0 && ", "}
            {p.url ? <a className="plink" href={p.url} target="_blank" rel="noreferrer" title="Their public Product Hunt profile">{p.name}</a> : p.name}
          </span>
        ))}
        {hiddenCount > 0 ? ` (+${hiddenCount} hidden)` : ""}
      </>
    );
  }
  if (hunter) return <>{hunter} <span className="meta">(hunter, may not be the founder)</span></>;
  return <>Not available. <a href={r.url} target="_blank" rel="noreferrer">See the launch page</a></>;
}

function FindContact({ r }: { r: ScoredLaunch }) {
  // Links only: each one opens a search page on click. The tool looks nothing up and stores nothing.
  const enc = encodeURIComponent;
  const people = r.founders.names.slice(0, 3);
  const links = [
    ...people.map((n) => ({ label: `${n} on LinkedIn`, url: `https://www.linkedin.com/search/results/people/?keywords=${enc(`${n} ${r.name}`)}` })),
    { label: `Search the web for ${r.name} contact`, url: `https://www.google.com/search?q=${enc(`${r.name} founder contact`)}` },
  ];
  return (
    <div className="findc">
      <div className="micro">Find contact yourself</div>
      <div className="d-actions">
        {links.map((l) => <a key={l.url} className="btn-link" href={l.url} target="_blank" rel="noreferrer noopener">{l.label} ↗</a>)}
      </div>
      <span className="note">These links open a search for you to run. The tool looks up no contact details and stores none.</span>
    </div>
  );
}

function HowScored({ r }: { r: ScoredLaunch }) {
  const p = r.parts;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <div className="how-wrap">
      <div className="micro">How this was scored</div>
      <dl className="how">
        <dt>Upvotes</dt>
        <dd>{p.votes} of the best {p.maxVotes} = {pct(p.votesShare)} × 50 = {p.votesPoints.toFixed(1)} points</dd>
        <dt>Maker comments</dt>
        {p.makerComments === null ? (
          <dd>Not counted (0 points, so this score is Provisional and can only go up)</dd>
        ) : (
          <dd>{p.makerComments}{r.makerCommentsStale ? " (saved copy older than 6 hours, CACHED)" : ""} of the best {p.maxMakerComments} = {pct(p.makerShare)} × 50 = {p.makerPoints.toFixed(1)} points</dd>
        )}
        <dt>Score</dt>
        <dd><b>{p.votesPoints.toFixed(1)} + {p.makerPoints.toFixed(1)} = {r.score.toFixed(1)}</b></dd>
      </dl>
      <p className="how-note">Only upvotes and maker comments count; fit, urgency and category never change the order.</p>
    </div>
  );
}

function Row({ r, rank, showNew, aiShown, index, onCopied, contacted, onContacted, active }: { r: ScoredLaunch; rank?: number; showNew: boolean; aiShown: boolean; index?: number; onCopied: (msg: string) => void; contacted: boolean; onContacted: () => void; active: boolean }) {
  const [open, setOpen] = useState(false);
  const copy = async () => {
    const ok = await copyText(r.ai.angle);
    onCopied(ok ? "Angle copied" : "Copy failed: select the text");
  };
  // Draft message: a Gemini-written first message for Kavya to edit and send herself. The page fills in the founder's first name.
  const [dr, setDr] = useState<{ subject: string; body: string; channel: "email" | "dm" } | null>(null);
  const [drState, setDrState] = useState<"idle" | "loading" | "error">("idle");
  const [drErr, setDrErr] = useState("");
  const firstName = (r.founders.names[0] ?? "").split(/\s+/)[0] || "there";
  const makeDraft = async (channel: "email" | "dm") => {
    setDrState("loading");
    setDrErr("");
    try {
      const res = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, channel }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Drafting failed");
      setDr({ subject: String(j.subject ?? ""), body: String(j.body).split("{{first_name}}").join(firstName), channel });
      setDrState("idle");
    } catch (e) {
      setDrErr(e instanceof Error ? e.message : "Drafting failed");
      setDrState("error");
    }
  };
  const copyDraft = async () => {
    if (!dr) return;
    onCopied((await copyText(dr.channel === "email" ? `Subject: ${dr.subject}\n\n${dr.body}` : dr.body)) ? "Message copied" : "Copy failed: select the text");
  };
  const competitor = aiShown && r.ai.fit === "competitor";
  const cls = ["lrow"];
  if (rank !== undefined && rank <= 3) cls.push(`top top${rank}`);
  if (competitor) cls.push("competitor");
  if (open) cls.push("open");
  if (contacted) cls.push("done");
  if (active) cls.push("kb");
  if (index !== undefined && index < 10) cls.push("enter");
  const unverified = aiShown && r.ai.quoteStatus === "unverified" && r.ai.evidenceQuote;
  const detailId = `d-${r.id}`;
  const dl = daysLeftText(r.daysSinceLaunch);
  const winLeft = Math.max(0, Math.min(WINDOW_DAYS, WINDOW_DAYS - r.daysSinceLaunch));
  return (
    <article className={cls.join(" ")} data-id={r.id} tabIndex={-1} aria-label={`${r.name}${rank !== undefined ? `, rank ${rank}` : ""}`} style={index !== undefined && index < 10 ? ({ "--i": index } as React.CSSProperties) : undefined}>
      <div className="c-rank">{rank !== undefined && <span className="rank">{rank}</span>}</div>
      <div className="c-prod">
        <div className="titleline">
          <a className="name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
          {aiShown && <span className={`fit fit-${r.ai.fit}`}><i aria-hidden="true" />{FIT_TEXT[r.ai.fit]}</span>}
          {showNew && <span className="tag new">New since your last visit</span>}
          {r.provisional && <span className="tag">Provisional</span>}
          {contacted && <span className="tag contacted">Contacted</span>}
          {r.votesHidden && <span className="tag">Votes hidden</span>}
        </div>
        <div className="founder">Founder: <Founder r={r} /></div>
        <p className="desc">{r.ai.oneLiner}</p>
      </div>
      <div className="c-angle">
        {aiShown ? (
          <>
            <p className="angle-prev">{r.ai.angle}</p>
            {unverified && <span className="tag unv">Unverified quote</span>}
          </>
        ) : <span className="noangle">No angle for this launch</span>}
      </div>
      <div className="c-metrics">
        <div className="c-up"><b className={r.votesHidden ? "dim" : ""}>{r.votesHidden ? "hidden" : r.votesCount}</b><span className="lbl">upvotes</span></div>
        <div className="c-mk" title={r.makerCommentsStale ? "Saved copy older than 6 hours; it will be refreshed on a later run" : undefined}><b className={r.makerComments === null ? "dim" : ""}>{r.makerComments === null ? "–" : r.makerComments}</b><span className="lbl">{r.makerComments === null ? "maker comments, not counted" : r.makerCommentsStale ? "maker comments (cached)" : "maker comments"}</span></div>
        <div className="c-win" title="Product Hunt gives launch dates by day, so this is approximate. Outreach works best inside the first 7 days.">
          <b>{r.daysSinceLaunch}d</b><span className="lbl">since launch</span>
          <span className={`wbar${dl.closing ? " closing" : ""}`} aria-hidden="true">{Array.from({ length: WINDOW_DAYS }, (_, i) => <i key={i} className={i >= WINDOW_DAYS - winLeft ? "left" : ""} />)}</span>
          <em className={dl.closing ? "closing" : ""}>{dl.text}</em>
        </div>
      </div>
      <div className="c-score">
        {r.votesHidden ? <div className="hidden">votes hidden</div> : (
          <>
            <span className="sc"><Score value={r.score} animate={index !== undefined && index < 10} /></span>
            <span className={`sbar${r.provisional ? " prov" : ""}`} aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, r.score))}%` }} /></span>
            {r.provisional && <span className="prov-l">provisional</span>}
          </>
        )}
      </div>
      <button className="c-toggle" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? "Hide" : "Show"} details for ${r.name}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      </button>
      {open && (
        <div className="c-detail" id={detailId}>
          <div className="d-col">
            {aiShown && (
              <>
                <div className="micro">Suggested outreach angle</div>
                <p className="angle-full">{r.ai.angle}</p>
                {r.ai.quoteStatus !== "none" && r.ai.evidenceQuote && (
                  <div className={`quote${r.ai.quoteStatus === "verified" ? "" : " unv"}`}>
                    {r.ai.quoteStatus === "verified" ? <span className="q-lbl">From the launch page</span> : <span className="q-lbl">Unverified</span>}
                    “{r.ai.evidenceQuote}”
                  </div>
                )}
                <div className="d-actions">
                  <button className="small" onClick={copy}>Copy angle</button>
                  {r.ai.angle && <button className="small accent" onClick={() => makeDraft("email")} disabled={drState === "loading"}>{drState === "loading" ? "Drafting…" : dr?.channel === "email" ? "Reset email draft" : "Draft email"}</button>}
                  {r.ai.angle && <button className="small accent" onClick={() => makeDraft("dm")} disabled={drState === "loading"}>{dr?.channel === "dm" ? "Reset short DM" : "Draft short DM"}</button>}
                  {r.websiteUrl && <a className="btn-link" href={r.websiteUrl} target="_blank" rel="noreferrer">Product site ↗</a>}
                  <button className={`small${contacted ? " on-contacted" : ""}`} onClick={onContacted} aria-pressed={contacted}>{contacted ? "✓ Contacted (undo)" : "Mark as contacted"}</button>
                  <span className="note">The angle is a starting point for you, not a message. "Contacted" is only a note kept in this browser: the tool never contacts anyone.</span>
                </div>
                <FindContact r={r} />
                {drState === "error" && <p className="draft-err" role="alert">{drErr}</p>}
                {dr && (
                  <div className="draft">
                    <div className="micro">{dr.channel === "email" ? "Draft email" : "Draft short DM"} · for you to review and send yourself</div>
                    {dr.channel === "email" && <label className="d-lbl">Subject<input value={dr.subject} onChange={(e) => setDr({ ...dr, subject: e.target.value })} /></label>}
                    <label className="d-lbl">Message<textarea rows={dr.channel === "dm" ? 7 : 12} value={dr.body} onChange={(e) => setDr({ ...dr, body: e.target.value })} /></label>
                    <div className="d-actions">
                      <button className="small primary" onClick={copyDraft}>Copy message</button>
                      <span className="note">AI draft. Check every claim, edit it, then send it yourself from your own email, LinkedIn or Product Hunt. This tool never sends it.</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="d-col">
            {aiShown && r.ai.fitReason && <p className="fitline"><span className="micro">Fit</span><br />{r.ai.fitReason}</p>}
            <div className="urgrow"><span className={`urg urg-${r.urgency}`}><i aria-hidden="true" />{URGENCY_TEXT[r.urgency]}</span>{r.categories.length > 0 && <span className="cats">{r.categories.map(categoryLabel).join(" · ")}</span>}</div>
            {!r.votesHidden && <HowScored r={r} />}
          </div>
        </div>
      )}
    </article>
  );
}

const CAT_COLORS = ["#46b590", "#7fd3b4", "#2f7f64", "#a9c9bd", "#5d6f68", "#3b4a44"]; // one green ramp plus greys: the colour only tells the slices apart
const EXTRAS_KEY = "ph-scout:extras";
const CONTACTED_KEY = "ph-scout:contacted";

/** Donut of how the ranked launches split across the four categories (a launch can carry more than one tag). */
function Donut({ parts }: { parts: { label: string; n: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  const r = 38;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 100 100" className="donut" aria-hidden="true">
        <circle className="trk" cx="50" cy="50" r={r} />
        {parts.map((p) => {
          const len = (c * p.n) / total;
          const el = <circle key={p.label} cx="50" cy="50" r={r} fill="none" stroke={p.color} strokeWidth="11" strokeDasharray={`${Math.max(0, len - 2.5)} ${c}`} strokeDashoffset={-off} transform="rotate(-90 50 50)" />;
          off += len;
          return el;
        })}
      </svg>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.label}><i style={{ background: p.color }} aria-hidden="true" /><span>{p.label}</span><b>{Math.round((p.n / total) * 100)}%</b></li>
        ))}
      </ul>
    </div>
  );
}

/** Pill-shaped bars: the score (out of 100) of each of the top launches, in rank order. */
function PillBars({ rows }: { rows: ScoredLaunch[] }) {
  return (
    <div className="pbars" role="img" aria-label={`Scores of the top ${rows.length} launches`}>
      {rows.map((r, i) => (
        <div key={r.id} className="pb" title={`${r.name}: ${r.score.toFixed(1)}`}>
          <span className="pb-n">{r.score.toFixed(0)}</span>
          <span className="pb-track"><i style={{ height: `${Math.max(6, Math.min(100, r.score))}%` }} /></span>
          <span className="pb-l">{String(i + 1).padStart(2, "0")}</span>
        </div>
      ))}
    </div>
  );
}

function Gauge({ pct, label }: { pct: number; label: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className="gauge">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="trk" cx="50" cy="50" r={r} />
        <circle className="prg" cx="50" cy="50" r={r} strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <span className="g-n">{label}</span>
    </div>
  );
}

/** Area chart of where the top launches get their points: upvote points (area) and maker-comment points (dashed), 0 to 50 each. */
function AreaChart({ rows }: { rows: ScoredLaunch[] }) {
  const [hi, setHi] = useState<number | null>(null);
  const n = rows.length;
  if (n < 2) return <p className="hint">Not enough launches to chart.</p>;
  const W = 640, H = 250, L = 40, R = 14, T = 14, B = 30;
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => T + (H - T - B) * (1 - Math.max(0, Math.min(50, v)) / 50);
  const clampY = (v: number) => Math.max(T, Math.min(H - B, v));
  const smooth = (p: [number, number][]) => {
    let d = `M${p[0][0]},${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] ?? p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] ?? p2;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${clampY(p1[1] + (p2[1] - p0[1]) / 6)} ${p2[0] - (p3[0] - p1[0]) / 6},${clampY(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]},${p2[1]}`;
    }
    return d;
  };
  const vp = rows.map((r, i) => [x(i), y(r.parts.votesPoints)] as [number, number]);
  const mp = rows.map((r, i) => [x(i), y(r.parts.makerPoints)] as [number, number]);
  const vLine = smooth(vp);
  const area = `${vLine} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    setHi(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  const r = hi !== null ? rows[hi] : null;
  return (
    <div className="areachart">
      <div className="ac-legend"><span><i className="d-up" />Upvote points</span><span><i className="d-mk" />Maker-comment points</span></div>
      <div className="ac-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Upvote points and maker-comment points of the top ${n} launches, out of 50 each`} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          {[0, 10, 20, 30, 40, 50].map((g) => (
            <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="gl" /><text x={L - 8} y={y(g) + 4} className="ax" textAnchor="end">{g}</text></g>
          ))}
          <path d={area} className="areafill" />
          <path d={vLine} className="l-up" />
          <path d={smooth(mp)} className="l-mk" />
          {rows.map((_, i) => <text key={i} x={x(i)} y={H - 8} className="ax" textAnchor="middle">{i + 1}</text>)}
          {hi !== null && (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} className="cross" />
              <circle cx={vp[hi][0]} cy={vp[hi][1]} r="5" className="pt-up" />
              <circle cx={mp[hi][0]} cy={mp[hi][1]} r="5" className="pt-mk" />
            </g>
          )}
        </svg>
        {r && hi !== null && (
          <div className="ac-tip" style={{ left: `${(x(hi) / W) * 100}%` }}>
            <b>#{hi + 1} {r.name.length > 26 ? `${r.name.slice(0, 25)}…` : r.name}</b>
            <span><i className="d-up" />{r.parts.votesPoints.toFixed(1)} upvote points</span>
            <span><i className="d-mk" />{r.parts.makerPoints.toFixed(1)} maker-comment points</span>
          </div>
        )}
      </div>
      <p className="hint">Rank on the bottom axis. Each launch earns up to 50 points from upvotes and up to 50 from maker comments.</p>
    </div>
  );
}

export default function Page() {
  const [data, setData] = useState<ScoutResponse | null>(null);
  const [loading, setLoading] = useState<"generate" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cats, setCats] = useState<CategoryId[]>([]); // selected categories; empty means all
  const allCats = cats.length === 0;
  const [extras, setExtras] = useState<ExtraCategoryId[]>([]); // optional categories to scan on the next Generate (off by default)
  const [extraNote, setExtraNote] = useState<string | null>(null);
  const [contacted, setContacted] = useState<Record<string, string>>({}); // launch id -> when Kavya marked it (kept only in this browser)
  const [hideContacted, setHideContacted] = useState(false);
  const [query, setQuery] = useState("");
  const [recency, setRecency] = useState<"any" | "hot" | "week" | "closing">("any"); // filter by how recently a launch happened (only hides rows)
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(CONTACTED_KEY) ?? "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) setContacted(Object.fromEntries(Object.entries(v).filter(([k, t]) => typeof k === "string" && typeof t === "string")) as Record<string, string>);
    } catch { /* storage blocked or bad value */ }
  }, []);
  const persistContacted = (next: Record<string, string>) => {
    try { localStorage.setItem(CONTACTED_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  const toggleContacted = (id: string) =>
    setContacted((cur) => {
      const next = { ...cur };
      if (next[id]) delete next[id];
      else next[id] = new Date().toISOString();
      persistContacted(next);
      return next;
    });
  useEffect(() => {
    try { setExtras(parseExtras(JSON.parse(localStorage.getItem(EXTRAS_KEY) ?? "[]"))); } catch { /* storage blocked or bad value */ }
  }, []);
  const toggleExtra = (id: ExtraCategoryId) => {
    setExtraNote(null);
    setExtras((cur) => {
      if (!cur.includes(id) && cur.length >= MAX_EXTRAS) {
        setExtraNote(`Up to ${MAX_EXTRAS} extra categories at a time, so a run stays fast and within Product Hunt's limits.`);
        return cur;
      }
      const next = parseExtras(cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]);
      try { localStorage.setItem(EXTRAS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  };
  const [fitOnly, setFitOnly] = useState(false);
  const [prevVisit, setPrevVisit] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [noticeUntil, setNoticeUntil] = useState<number | null>(null); // when a "next copy in" countdown ends
  const [clock, setClock] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    try { setPrevVisit(localStorage.getItem(LAST_VISIT_KEY)); } catch { /* storage blocked */ }
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  async function run(refresh: boolean) {
    setLoading(refresh ? "refresh" : "generate");
    setError(null);
    try {
      const res = await fetch("/api/scout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh, extras }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json as ScoutResponse);
      const n = (json as ScoutResponse).notification;
      setNoticeUntil(n?.status === "cooldown" && n.retryInSeconds ? Date.now() + n.retryInSeconds * 1000 : null);
      if ((json as ScoutResponse).source === "LIVE") {
        try { localStorage.setItem(LAST_VISIT_KEY, (json as ScoutResponse).generatedAt); } catch { /* storage blocked */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    if (noticeUntil === null) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [noticeUntil]);

  // One quiet line about the copy sent to Kavya. Shows nothing when sending is off, skipped, or already over.
  const notice = (() => {
    const n = data?.notification;
    if (!n) return null;
    const where = n.channels?.length === 2 ? "Telegram and email" : n.channels?.[0] === "telegram" ? "Telegram" : "email";
    if (n.status === "sending") return `Copy being sent to Kavya's ${where}`;
    if (n.status === "cooldown" && noticeUntil !== null) {
      const left = Math.ceil((noticeUntil - clock) / 1000);
      if (left > 0) return `Not sent: next copy in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    }
    return null;
  })();

  const refreshWaitMin = useMemo(() => {
    void tick;
    if (!data?.refresh.nextAvailableAt) return 0;
    const ms = Date.parse(data.refresh.nextAvailableAt) - Date.now();
    return ms > 0 ? Math.ceil(ms / 60_000) : 0;
  }, [data, tick]);

  const visible = (rows: ScoredLaunch[]) =>
    rows.filter(
      (r) =>
        (allCats || r.categories.some((c) => cats.includes(c))) &&
        (!fitOnly || (r.ai.fit !== "weak" && r.ai.fit !== "competitor")) && // unrated rows (AI down) stay visible
        (recency === "any" || r.urgency === recency) &&
        (!hideContacted || !contacted[r.id]) &&
        matchesQuery(r, query),
    );
  const isNew = (r: ScoredLaunch) =>
    Boolean(data && data.source === "LIVE" && data.newTagging && prevVisit && r.firstSeenAt && Date.parse(r.firstSeenAt) > Date.parse(prevVisit));

  const ranked = data ? visible(data.ranked) : [];
  const tooEarly = data ? visible(data.tooEarly) : [];
  const more = data ? visible(data.moreLaunches) : [];

  // Coverage of maker comments, straight from the data on the page.
  const provisionalRows = data ? [...data.ranked, ...data.moreLaunches].filter((r) => r.provisional).length : 0;

  // CSV: exactly the rows currently visible (chips and fit switch applied), in the order shown.
  // "More launches" rows are included only while that section is open.
  const csvRows = (): CsvRow[] => {
    if (!data) return [];
    const out: CsvRow[] = ranked.map((launch) => ({ rank: data.ranked.indexOf(launch) + 1, launch }));
    for (const launch of tooEarly) out.push({ rank: null, launch });
    if (moreOpen) for (const launch of more) out.push({ rank: data.ranked.length + data.moreLaunches.indexOf(launch) + 1, launch });
    return out;
  };
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };
  const copyCsv = async () => {
    const rows = csvRows();
    const ok = await copyText(toCsv(rows));
    flash(ok ? `Copied ${rowsLabel(rows.length)}` : "Copy failed: use Download CSV instead");
  };
  const downloadCsv = () => {
    const rows = csvRows();
    const blob = new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ph-scout-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Downloaded ${rowsLabel(rows.length)}`);
  };
  // Kavya's "contacted" notes live only in this browser. Export and import let her keep or move them; the file stays on her computer.
  const exportContactedFile = () => {
    const names: Record<string, string> = {};
    if (data) for (const r of [...data.ranked, ...data.tooEarly, ...data.moreLaunches]) names[r.id] = r.name;
    const blob = new Blob([exportContacted(contacted, names)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ph-scout-contacted-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Saved ${Object.keys(contacted).length} contacted ${Object.keys(contacted).length === 1 ? "note" : "notes"}`);
  };
  const importContactedFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) return flash("That file is too big to be a contacted list");
      const parsed = parseContactedImport(await file.text());
      if (!parsed) return flash("That is not a contacted list saved by this tool");
      const merged = mergeContacted(contacted, parsed);
      const added = Object.keys(merged).length - Object.keys(contacted).length;
      setContacted(merged);
      persistContacted(merged);
      flash(`Imported ${Object.keys(parsed).length} notes (${added} new)`);
    };
    input.click();
  };
  const exportCount = data ? ranked.length + tooEarly.length + (moreOpen ? more.length : 0) : 0;

  const catCount = (id: CategoryId) => (data ? data.ranked.filter((r) => r.categories.includes(id)).length : 0);
  const availableCats = [...CATEGORIES, ...EXTRA_CATEGORIES.filter((c) => data?.extras?.includes(c.id as ExtraCategoryId))];
  const scannedExtras = (data?.extras ?? []) as ExtraCategoryId[];
  const extrasPending = Boolean(data) && [...extras].sort().join() !== [...scannedExtras].sort().join();
  const toggleCat = (id: CategoryId) =>
    setCats((cur) => {
      const next = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id];
      return next.length === availableCats.length ? [] : next; // every available category selected is the same as all
    });
  useEffect(() => {
    // a category filter can only stay selected while that category is part of the current results
    setCats((cur) => (cur.every((id) => availableCats.some((c) => c.id === id)) ? cur : cur.filter((id) => availableCats.some((c) => c.id === id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- row density, keyboard, list animation, waiting time
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  useEffect(() => {
    try { if (localStorage.getItem(DENSITY_KEY) === "compact") setDensity("compact"); } catch { /* storage blocked */ }
  }, []);
  const chooseDensity = (d: "comfortable" | "compact") => {
    setDensity(d);
    try { localStorage.setItem(DENSITY_KEY, d); } catch { /* storage blocked */ }
  };
  const [activeId, setActiveId] = useState<string | null>(null); // the row the keyboard is on
  const [sheet, setSheet] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading]);

  // Keyboard: j/k move, Enter opens, c marks contacted, / searches, ? lists the keys. Nothing fires while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "Escape") {
        if (sheet) setSheet(false);
        else if (typing) t?.blur();
        else setActiveId(null);
        return;
      }
      if (typing || !data) return;
      const rowsEls = Array.from(document.querySelectorAll<HTMLElement>(".lrow[data-id]")).filter((el) => el.getClientRects().length > 0);
      const idx = rowsEls.findIndex((el) => el.dataset.id === activeId);
      if (e.key === "j" || e.key === "k") {
        if (rowsEls.length === 0) return;
        const next = idx < 0 ? 0 : e.key === "j" ? Math.min(rowsEls.length - 1, idx + 1) : Math.max(0, idx - 1);
        const el = rowsEls[next];
        e.preventDefault();
        setActiveId(el.dataset.id ?? null);
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      } else if (e.key === "o" || (e.key === "Enter" && (t === document.body || t?.classList.contains("lrow")))) {
        if (idx >= 0) { e.preventDefault(); rowsEls[idx].querySelector<HTMLButtonElement>(".c-toggle")?.click(); }
      } else if (e.key === "c") {
        if (idx >= 0 && activeId) {
          toggleContacted(activeId);
          flash(contacted[activeId] ? "Contacted note removed" : "Marked as contacted");
        }
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search")?.focus();
      } else if (e.key === "?") {
        setSheet((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Rows slide to their new place (about 200 ms) when a filter, search or density change moves them. Skipped for reduced motion
  // and whenever the page itself scrolled, so it never animates a jump the visitor caused.
  const flipRef = useRef<{ y: Map<string, number>; scroll: number }>({ y: new Map(), scroll: 0 });
  useLayoutEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lrow[data-id]"));
    const next = new Map<string, number>();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sameScroll = Math.abs(window.scrollY - flipRef.current.scroll) < 1;
    for (const el of els) {
      const id = el.dataset.id as string;
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const prev = flipRef.current.y.get(id);
      if (!reduce && sameScroll && prev !== undefined && Math.abs(prev - top) > 1 && Math.abs(prev - top) < 1200 && typeof el.animate === "function") {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
      }
    }
    flipRef.current = { y: next, scroll: window.scrollY };
  });

  const ageMin = useMemo(() => {
    void tick;
    return data ? Math.max(0, Math.round((Date.now() - Date.parse(data.fetchedAt)) / 60_000)) : 0;
  }, [data, tick]);
  const ageText = ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`;
  const srcKind = data ? (data.source === "LIVE" && ageMin > 75 ? "aging" : data.source.toLowerCase()) : "live";

  const showHero = !data && !loading;
  // The logo is the homepage button: it goes back to the landing screen (the saved list is fetched again on the next Generate).
  const goHome = (e: React.MouseEvent) => {
    e.preventDefault();
    if (loading) return;
    setData(null);
    setError(null);
    window.scrollTo({ top: 0 });
  };
  const aiOn = Boolean(data?.ai.available);
  const strongN = data ? data.ranked.filter((r) => r.ai.fit === "strong").length : 0;
  const hotRows = data ? data.ranked.filter((r) => r.urgency === "hot") : [];
  const coveragePct = data && data.counted.of ? Math.round((data.counted.n / data.counted.of) * 100) : 0;
  const top = data?.ranked[0];
  const catParts = availableCats.map((c, i) => ({ label: c.label, n: catCount(c.id), color: CAT_COLORS[i % CAT_COLORS.length] }));
  const busy = loading !== null;

  const fitSwitch = (
    <label className="switch">
      <input type="checkbox" checked={fitOnly} disabled={!data?.ai.available} onChange={(e) => setFitOnly(e.target.checked)} />
      Hide weak fits and competitors
    </label>
  );
  const contactedCount = data ? [...data.ranked, ...data.tooEarly, ...data.moreLaunches].filter((r) => contacted[r.id]).length : 0;
  const contactedSwitch = (
    <label className="switch">
      <input type="checkbox" checked={hideContacted} disabled={contactedCount === 0 && !hideContacted} onChange={(e) => setHideContacted(e.target.checked)} />
      Hide contacted{contactedCount ? ` (${contactedCount})` : ""}
    </label>
  );
  const contactedIO = (
    <div className="cio">
      <button type="button" onClick={exportContactedFile} disabled={Object.keys(contacted).length === 0}>Export contacted</button>
      <button type="button" onClick={importContactedFile}>Import</button>
    </div>
  );
  const recencyPicker = (
    <div className="recency" role="group" aria-label="Launched">
      <p className="micro nav-h">Launched</p>
      <div className="seg seg-wrap">
        {([["any", "Any time"], ["hot", "Last 2 days"], ["week", "3–5 days"], ["closing", "6–7 days"]] as const).map(([id, label]) => (
          <button key={id} className={`chip ${recency === id ? "on" : ""}`} aria-pressed={recency === id} onClick={() => setRecency(id)}>{label}</button>
        ))}
      </div>
    </div>
  );
  const extraPicker = (
    <div className="extras" role="group" aria-label="Optional categories to scan">
      <p className="micro nav-h">More categories · optional</p>
      <p className="hint">Not scanned by default. Pick up to {MAX_EXTRAS}; they are added the next time you click Generate.</p>
      <div className="extra-list">
        {EXTRA_CATEGORIES.map((c) => {
          const on = extras.includes(c.id as ExtraCategoryId);
          return (
            <button key={c.id} className={`xchip${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleExtra(c.id as ExtraCategoryId)}>{on ? "✓" : "+"} {c.label}</button>
          );
        })}
      </div>
      {extraNote && <p className="hint pending" role="status">{extraNote}</p>}
      {extrasPending && !extraNote && <p className="hint pending" role="status">Click Generate to {extras.length ? "scan your choice" : "go back to the four main categories"}.</p>}
    </div>
  );
  const refreshLabel = loading === "refresh" ? "Refreshing…" : refreshWaitMin > 0 ? `Refresh now (in ${refreshWaitMin} min)` : "Refresh now";

  const rowProps = (r: ScoredLaunch) => ({ showNew: isNew(r), onCopied: flash, contacted: Boolean(contacted[r.id]), onContacted: () => toggleContacted(r.id), active: activeId === r.id });

  return (
    <>
      {showHero && (
        <>
          <div className="topbar" role="banner"><div className="topbar-in"><a className="brand" href="/" onClick={goHome} aria-label="ProductHunt Partnership Scout, go to the homepage"><span className="mark" aria-hidden="true" />ProductHunt <span className="dim">Partnership Scout</span></a></div></div>
          <main className="landing">
            <section className="hero">
              <p className="eyebrow">Last 7 days on Product Hunt</p>
              <h1>Find the launches worth a conversation.</h1>
              <p className="sub">Launches from the last 7 days in project management, HR tech, developer productivity and team communication, ranked by upvotes and maker comments. It never contacts founders or sends outreach.</p>
              <div className="cta"><button className="primary big" onClick={() => run(false)}>Generate</button><span className="hint">Takes up to a minute the first time.</span></div>
              <details className="extras-box"><summary>Add optional categories{extras.length ? ` (${extras.length} on)` : ""}</summary>{extraPicker}</details>
            </section>
            <div className="scans" aria-label="Categories scanned"><b>Scans</b>{CATEGORIES.map((c) => <span key={c.id}>{c.label}</span>)}{EXTRA_CATEGORIES.filter((c) => extras.includes(c.id as ExtraCategoryId)).map((c) => <span key={c.id} className="opt">{c.label} (optional)</span>)}</div>
            <ol className="how3" id="how">
              <li><span className="n">01</span><h2>Scan</h2><p>Product Hunt launches from the last 7 days across four categories, fetched live.</p></li>
              <li><span className="n">02</span><h2>Rank</h2><p>Half upvotes, half maker comments, each against the week&apos;s best. Computed in code.</p></li>
              <li><span className="n">03</span><h2>Suggest</h2><p>Gemini Flash writes an outreach angle backed by a quote from the launch page. It never changes the rank.</p></li>
            </ol>
            {error && <div className="banner err">{error}</div>}
          </main>
        </>
      )}

      {!showHero && (
        <div className="shell">
          <aside className="side">
            <a className="brand" href="/" onClick={goHome} aria-label="Partnership Scout, go to the homepage"><span className="mark" aria-hidden="true" />Partnership Scout</a>
            {data && (
              <nav aria-label="Sections and filters">
                <p className="micro nav-h">Overview</p>
                <a className="nav on" href="#overview">Dashboard</a>
                <a className="nav" href="#list">Ranked list <span className="n">{data.ranked.length}</span></a>
                {data.tooEarly.length > 0 && <a className="nav" href="#early">Too early <span className="n">{data.tooEarly.length}</span></a>}
                {data.moreLaunches.length > 0 && <a className="nav" href="#more" onClick={() => setMoreOpen(true)}>More launches <span className="n">{data.moreLaunches.length}</span></a>}
                <p className="micro nav-h">Categories</p>
                <button className={`nav${allCats ? " on" : ""}`} aria-pressed={allCats} onClick={() => setCats([])}>All categories <span className="n">{data.ranked.length}</span></button>
                {availableCats.map((c) => (
                  <button key={c.id} className={`nav${cats.includes(c.id) ? " on" : ""}`} aria-pressed={cats.includes(c.id)} onClick={() => toggleCat(c.id)}><span className="cb" aria-hidden="true" />{c.label} <span className="n">{catCount(c.id)}</span></button>
                ))}
                <p className="micro nav-h">View</p>
                <div className="side-switch">{fitSwitch}</div>
                <div className="side-switch">{contactedSwitch}</div>
                <div className="side-switch">{contactedIO}</div>
                {recencyPicker}
                {extraPicker}
              </nav>
            )}
            {data && notice && <div className="side-foot"><p className="notice" role="status">{notice}</p></div>}
          </aside>

          <div className="content" role="main">
            <div className="dash-head">
              <a className="brand m-brand" href="/" onClick={goHome} aria-label="Partnership Scout, go to the homepage"><span className="mark" aria-hidden="true" />Partnership Scout</a>
              <h1>Outreach shortlist</h1>
              {data && (
                <p className="meta">
                  <span className={`src src-${srcKind}`}><i aria-hidden="true" />{data.source}{srcKind === "aging" ? " (aging)" : ""}</span>
                  <span>{data.source === "SAMPLE" ? "Bundled sample data from" : "Data as of"} {fmtTime(data.fetchedAt)} ({ageText})</span>
                  <span>{data.ranked.length} ranked of {data.counted.of} launches</span>
                </p>
              )}
            </div>

            <section className="toolbar" aria-label="Actions">
              <button className="tb main" onClick={() => run(false)} disabled={busy}><span>{loading === "generate" ? "Generating…" : "Generate"}</span><small>{extras.length ? `Four main + ${extras.length} optional` : "Build a fresh list"}</small></button>
              <button className="tb" onClick={() => run(true)} disabled={busy || !data || refreshWaitMin > 0} title="Fetch the launch list again (once every 5 minutes)"><span>{refreshLabel}</span><small>Once every 5 minutes</small></button>
              <button className="tb" onClick={copyCsv} disabled={exportCount === 0}><span>Copy as CSV</span><small>{rowsLabel(exportCount)} visible</small></button>
              <button className="tb" onClick={downloadCsv} disabled={exportCount === 0}><span>Download CSV</span><small>{rowsLabel(exportCount)} visible</small></button>
            </section>

            {error && <div className="banner err">{error}</div>}
            {loading && (
              <>
                <div className="banner info" role="status">Scanning Product Hunt and writing outreach angles: {elapsed} s so far. This is usually quick because saved results are reused; a cold start can take up to a minute.</div>
                <div className="panel" aria-hidden="true"><div className="table">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" />)}</div></div>
              </>
            )}
            {data?.warnings.map((w, i) => <div key={i} className={`banner ${w.startsWith("AI summaries unavailable") || w.startsWith("Live Product Hunt") ? "err" : ""}`}>{w}</div>)}

            {data && (
              <>
                <section className="kpis" id="overview" aria-label="Summary">
                  <div className="kpi"><div className="kl">Launches scanned</div><div className="kn">{data.counted.of}</div></div>
                  <div className="kpi"><div className="kl">Ranked launches</div><div className="kn">{data.ranked.length}</div></div>
                  <div className="kpi"><div className="kl">Strong-fit launches</div><div className="kn">{aiOn ? strongN : "–"}</div></div>
                  <div className="kpi"><div className="kl">Contact now (last 2 days)</div><div className="kn">{hotRows.length}</div></div>
                </section>

                <section className="bento" id="insights" aria-label="Insights">
                  <h2 className="sr-only">Insights</h2>
                  <div className="card c-chart">
                    <div className="card-h"><h3>Where the points come from</h3><span className="micro">Top {Math.min(10, data.ranked.length)} launches</span></div>
                    <AreaChart rows={data.ranked.slice(0, 10)} />
                  </div>
                  <div className="card c-hot">
                    <div className="card-h"><h3>Contact now</h3><span className="micro">Launched in the last 2 days</span></div>
                    {hotRows.length === 0 ? <p className="hint">Nothing launched in the last 2 days.</p> : (
                      <ul className="hotlist">
                        {hotRows.slice(0, 4).map((r) => (
                          <li key={r.id}>
                            <i className="hd" aria-hidden="true" />
                            <div><a href={r.url} target="_blank" rel="noreferrer">{r.name}</a><span>{r.daysSinceLaunch === 0 ? "Launched today" : `Launched ${r.daysSinceLaunch} ${r.daysSinceLaunch === 1 ? "day" : "days"} ago`} · ranked #{data.ranked.indexOf(r) + 1} overall</span></div>
                            <b>{r.score.toFixed(1)}</b>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="gauge-row"><Gauge pct={coveragePct} label={`${coveragePct}%`} /><div className="cov-text"><b>{data.counted.n} of {data.counted.of}</b> launches counted<p className="hint">{provisionalRows > 0 ? `${provisionalRows} ${provisionalRows === 1 ? "row is" : "rows are"} Provisional: ${provisionalRows === 1 ? "its" : "their"} score is a lower bound until counted.` : "No row is Provisional."}{data.counted.stale > 0 ? ` ${data.counted.stale} ${data.counted.stale === 1 ? "count comes" : "counts come"} from a saved copy older than 6 hours (CACHED).` : ""}</p></div></div>
                  </div>
                  <div className="card c-scores">
                    <div className="card-h"><h3>Top scores</h3><span className="micro">Top {Math.min(8, data.ranked.length)} by score</span></div>
                    <PillBars rows={data.ranked.slice(0, 8)} />
                  </div>
                  <div className="card c-cats">
                    <div className="card-h"><h3>By category</h3><span className="micro">Share of tags</span></div>
                    <Donut parts={catParts} />
                  </div>
                  {top && (
                    <div className="card c-top">
                      <div className="top-l">
                        <span className="micro">Start here</span>
                        <h3>{top.name}</h3>
                        {aiOn && top.ai.angle && <p>{top.ai.angle}</p>}
                        <div className="top-actions">
                          <a className="btn-link" href={top.url} target="_blank" rel="noreferrer">Open launch ↗</a>
                          {aiOn && top.ai.angle && <button className="small" onClick={async () => flash((await copyText(top.ai.angle)) ? "Angle copied" : "Copy failed: select the text")}>Copy angle</button>}
                        </div>
                      </div>
                      <div className="top-stats">
                        <div><b>{top.score.toFixed(1)}</b><span>Score</span></div>
                        <div><b>{top.votesHidden ? "–" : top.votesCount}</b><span>Upvotes</span></div>
                        <div><b>{top.makerComments === null ? "–" : top.makerComments}</b><span>Maker comments</span></div>
                        <div><b>{top.daysSinceLaunch}</b><span>Days since launch</span></div>
                      </div>
                    </div>
                  )}
                </section>

                <div className="m-filters">
                  <div className="seg" role="group" aria-label="Categories, pick one or more">
                    <button className={`chip ${allCats ? "on" : ""}`} aria-pressed={allCats} onClick={() => setCats([])}>All <span className="n">{data.ranked.length}</span></button>
                    {availableCats.map((c) => (
                      <button key={c.id} className={`chip ${cats.includes(c.id) ? "on" : ""}`} aria-pressed={cats.includes(c.id)} onClick={() => toggleCat(c.id)}>{c.label} <span className="n">{catCount(c.id)}</span></button>
                    ))}
                  </div>
                  {fitSwitch}
                  {contactedSwitch}
                  {contactedIO}
                  {recencyPicker}
                  <details className="extras-box"><summary>Add optional categories{extras.length ? ` (${extras.length} on)` : ""}</summary>{extraPicker}</details>
                  {notice && <p className="notice" role="status">{notice}</p>}
                </div>

                <section className="panel" id="list">
                  <div className="listhead">
                    <h2>Ranked outreach list <span className="count">{ranked.length}</span></h2>
                    <div className="right">
                      <input type="search" className="search" placeholder="Search product or founder" aria-label="Search the list by product or founder" value={query} onChange={(e) => setQuery(e.target.value)} />
                      <div className="seg" role="group" aria-label="Row density">
                        {([["comfortable", "Comfortable"], ["compact", "Compact"]] as const).map(([id, label]) => (
                          <button key={id} className={`chip ${density === id ? "on" : ""}`} aria-pressed={density === id} onClick={() => chooseDensity(id)}>{label}</button>
                        ))}
                      </div>
                      <button className="linkbtn" onClick={() => setSheet((v) => !v)} aria-expanded={sheet}>Shortcuts <span className="kbd">?</span></button>
                    </div>
                  </div>
                  <p className="hint">In order of score (upvotes and maker comments only). Filters and search only hide rows. Window: {fmtTime(data.window.from)} to {fmtTime(data.window.to)}. Exports the {rowsLabel(exportCount)} currently visible.</p>
                  <details className="fit-guide">
                    <summary>What do the fit tags mean?</summary>
                    <dl>
                      <dt>Strong fit</dt><dd>Serves remote or distributed teams and sits next to async standups, so a partnership makes sense for both sides.</dd>
                      <dt>Partial fit</dt><dd>The audience overlaps with remote teams, but the link to standups is indirect.</dd>
                      <dt>Weak fit</dt><dd>Little audience overlap or no clear reason to partner.</dd>
                      <dt>Likely competitor</dt><dd>Does the same job as an async standup tool.</dd>
                    </dl>
                    <p>The tags come from Gemini Flash reading the launch text. They never change the order: rank is only upvotes and maker comments.</p>
                  </details>
                  {ranked.length === 0 && <div className="empty">No launches match. Widen the filters{data.counted.of === 0 ? `, or no launches were found between ${fmtTime(data.window.from)} and ${fmtTime(data.window.to)}` : ""}.</div>}
                  {ranked.length > 0 && (
                    <div className={`table${density === "compact" ? " compact" : ""}`}>
                      <div className="thead" aria-hidden="true"><span>#</span><span>Product</span><span>Suggested outreach angle</span><span className="r">Upvotes</span><span className="r">Maker comments</span><span className="r">Window</span><span className="r">Score ↓</span><span /></div>
                      {ranked.map((r, i) => <Row key={r.id} r={r} rank={data.ranked.indexOf(r) + 1 || i + 1} aiShown index={i} {...rowProps(r)} />)}
                    </div>
                  )}
                </section>

                {data.tooEarly.length > 0 && (
                  <section className="panel" id="early">
                    <div className="listhead"><h2>Too early to rank <span className="count">{tooEarly.length}</span></h2></div>
                    <p className="hint">Launched today; Product Hunt is still hiding the votes. They have no score yet and are not ranked.</p>
                    <div className={`table${density === "compact" ? " compact" : ""}`}>{tooEarly.map((r) => <Row key={r.id} r={r} aiShown={r.ai.angle !== ""} {...rowProps(r)} />)}</div>
                  </section>
                )}

                {data.moreLaunches.length > 0 && (
                  <details className="panel more" id="more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
                    <summary>More launches ({more.length}), in score order, without an angle</summary>
                    <div className={`table${density === "compact" ? " compact" : ""}`}>{more.map((r) => <Row key={r.id} r={r} rank={data.ranked.length + data.moreLaunches.indexOf(r) + 1} aiShown={false} {...rowProps(r)} />)}</div>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <div role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
      {sheet && (
        <div className="sheet" role="dialog" aria-label="Keyboard shortcuts">
          <div className="sheet-h"><h2>Keyboard shortcuts</h2><button className="small" onClick={() => setSheet(false)}>Close</button></div>
          <dl>
            <dt><span className="kbd">j</span><span className="kbd">k</span></dt><dd>Next or previous launch</dd>
            <dt><span className="kbd">Enter</span></dt><dd>Open or close its details</dd>
            <dt><span className="kbd">c</span></dt><dd>Mark as contacted, or undo</dd>
            <dt><span className="kbd">/</span></dt><dd>Search</dd>
            <dt><span className="kbd">?</span></dt><dd>Show or hide this list</dd>
            <dt><span className="kbd">Esc</span></dt><dd>Close, or leave a field</dd>
          </dl>
          <p className="hint">Shortcuts do nothing while you are typing in a field.</p>
        </div>
      )}
    </>
  );
}
