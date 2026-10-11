"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { CATEGORIES, categoryLabel, type CategoryId } from "@/lib/categories";
import { rowsLabel, toCsv, type CsvRow } from "@/lib/csv";
import type { ScoredLaunch, ScoutResponse } from "@/lib/types";

const LAST_VISIT_KEY = "ph-scout:lastVisit";
const URGENCY_TEXT = { hot: "Hot — contact now", week: "Contact this week", closing: "Window closing" } as const;
const FIT_TEXT = { strong: "Strong fit", possible: "Possible fit", weak: "Weak fit", competitor: "Likely competitor", unrated: "Not rated" } as const;

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

/** A monogram tile: first letter on a muted tint derived from the name (no images, nothing fetched). */
function Tile({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const hues = [32, 44, 160, 172, 276, 300]; // amber, gold, teal, mint, purple, orchid: no blues
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return <span className="tile" aria-hidden="true" style={{ "--h": hues[h % hues.length] } as React.CSSProperties}>{letter}</span>;
}

/** Score ring: the arc is the score out of 100. */
function Ring({ value, provisional, animate }: { value: number; provisional: boolean; animate: boolean }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={`ring${provisional ? " prov" : ""}`}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle className="trk" cx="30" cy="30" r={r} />
        <circle className={`prg${animate ? " go" : ""}`} cx="30" cy="30" r={r} strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 30 30)" />
      </svg>
      <span className="score"><Score value={value} animate={animate} /></span>
    </div>
  );
}

function Founder({ r }: { r: ScoredLaunch }) {
  const { names, hiddenCount, hunter } = r.founders;
  if (names.length) return <>{names.join(", ")}{hiddenCount > 0 ? ` (+${hiddenCount} hidden)` : ""}</>;
  if (hunter) return <>{hunter} <span className="meta">(Posted by (hunter, may not be the founder))</span></>;
  return <>Not available — <a href={r.url} target="_blank" rel="noreferrer">see the launch page</a></>;
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

function Row({ r, rank, showNew, aiShown, index, onCopied }: { r: ScoredLaunch; rank?: number; showNew: boolean; aiShown: boolean; index?: number; onCopied: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const copy = async () => {
    const ok = await copyText(r.ai.angle);
    onCopied(ok ? "Angle copied" : "Copy failed: select the text");
  };
  // Draft message: a Gemini-written first message for Kavya to edit and send herself. The page fills in the founder's first name.
  const [dr, setDr] = useState<{ subject: string; body: string } | null>(null);
  const [drState, setDrState] = useState<"idle" | "loading" | "error">("idle");
  const [drErr, setDrErr] = useState("");
  const firstName = (r.founders.names[0] ?? "").split(/\s+/)[0] || "there";
  const makeDraft = async () => {
    setDrState("loading");
    setDrErr("");
    try {
      const res = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Drafting failed");
      setDr({ subject: String(j.subject), body: String(j.body).split("{{first_name}}").join(firstName) });
      setDrState("idle");
    } catch (e) {
      setDrErr(e instanceof Error ? e.message : "Drafting failed");
      setDrState("error");
    }
  };
  const copyDraft = async () => {
    if (!dr) return;
    onCopied((await copyText(`Subject: ${dr.subject}\n\n${dr.body}`)) ? "Message copied" : "Copy failed: select the text");
  };
  const competitor = aiShown && r.ai.fit === "competitor";
  const cls = ["lrow"];
  if (rank !== undefined && rank <= 3) cls.push(`top top${rank}`);
  if (competitor) cls.push("competitor");
  if (open) cls.push("open");
  if (index !== undefined && index < 10) cls.push("enter");
  const unverified = aiShown && r.ai.quoteStatus === "unverified" && r.ai.evidenceQuote;
  const detailId = `d-${r.id}`;
  return (
    <article className={cls.join(" ")} style={index !== undefined && index < 10 ? ({ "--i": index } as React.CSSProperties) : undefined}>
      <div className="c-rank">{rank !== undefined && <span className="rank">{rank}</span>}</div>
      <div className="c-prod">
        <Tile name={r.name} />
        <div className="pr-text">
        <div className="titleline">
          <a className="name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
          {showNew && <span className="pill p-new">New since your last visit</span>}
          {aiShown && <span className={`pill p-${r.ai.fit}`}>{FIT_TEXT[r.ai.fit]}</span>}
          {r.provisional && <span className="pill p-provisional">Provisional</span>}
          {r.votesHidden && <span className="pill">Votes hidden</span>}
        </div>
        <div className="founder">Founder: <Founder r={r} /></div>
        <p className="desc">{r.ai.oneLiner}</p>
        </div>
      </div>
      <div className="c-angle">
        {aiShown ? (
          <>
            <p className="angle-prev">{r.ai.angle}</p>
            {unverified && <span className="pill p-unverified">Unverified quote</span>}
          </>
        ) : <span className="noangle">No angle for this launch</span>}
        <p className="meta-line">
          <span>{r.votesHidden ? <b>votes hidden</b> : <><b>{r.votesCount}</b> upvotes</>}</span>
          <span>{r.makerComments === null ? <>maker comments <b title="Maker comments not counted">not counted</b></> : <><b>{r.makerComments}</b> maker comments</>}{r.makerCommentsStale && <em className="stale" title="Saved copy older than 6 hours; it will be refreshed on a later run"> (CACHED)</em>}</span>
          <span><b>{r.daysSinceLaunch}</b> days since launch</span>
        </p>
      </div>
      <div className="c-score">
        {r.votesHidden ? <div className="hidden">votes hidden</div> : <Ring value={r.score} provisional={r.provisional} animate={index !== undefined && index < 10} />}
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
                  {r.ai.angle && <button className="small accent" onClick={makeDraft} disabled={drState === "loading"}>{drState === "loading" ? "Drafting…" : dr ? "Reset draft" : "Draft message"}</button>}
                  <span className="note">The angle is a starting point for you, not a message.</span>
                </div>
                {drState === "error" && <p className="draft-err" role="alert">{drErr}</p>}
                {dr && (
                  <div className="draft">
                    <div className="micro">Draft message · for you to review and send yourself</div>
                    <label className="d-lbl">Subject<input value={dr.subject} onChange={(e) => setDr({ ...dr, subject: e.target.value })} /></label>
                    <label className="d-lbl">Message<textarea rows={12} value={dr.body} onChange={(e) => setDr({ ...dr, body: e.target.value })} /></label>
                    <div className="d-actions">
                      <button className="small primary" onClick={copyDraft}>Copy message</button>
                      <span className="note">AI draft. Check every claim, edit it, then send it from your own email or LinkedIn. This tool never sends it.</span>
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

const CAT_COLORS = ["#3ee8c8", "#ffb02e", "#a78bfa", "#d4f55a"];

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
          <li key={p.label}><i style={{ background: p.color }} /><span>{p.label}</span><b>{Math.round((p.n / total) * 100)}%</b></li>
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
      <div className="ac-legend"><span><i className="d-amber" />Upvote points</span><span><i className="d-mint" />Maker-comment points</span></div>
      <div className="ac-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Upvote points and maker-comment points of the top ${n} launches, out of 50 each`} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          <defs><linearGradient id="areafill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff9a2e" stopOpacity="0.55" /><stop offset="1" stopColor="#ff9a2e" stopOpacity="0" /></linearGradient></defs>
          {[0, 10, 20, 30, 40, 50].map((g) => (
            <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="gl" /><text x={L - 8} y={y(g) + 4} className="ax" textAnchor="end">{g}</text></g>
          ))}
          <path d={area} fill="url(#areafill)" />
          <path d={vLine} className="l-amber" />
          <path d={smooth(mp)} className="l-mint" />
          {rows.map((_, i) => <text key={i} x={x(i)} y={H - 8} className="ax" textAnchor="middle">{i + 1}</text>)}
          {hi !== null && (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} className="cross" />
              <circle cx={vp[hi][0]} cy={vp[hi][1]} r="5" className="pt-amber" />
              <circle cx={mp[hi][0]} cy={mp[hi][1]} r="5" className="pt-mint" />
            </g>
          )}
        </svg>
        {r && hi !== null && (
          <div className="ac-tip" style={{ left: `${(x(hi) / W) * 100}%` }}>
            <b>#{hi + 1} {r.name.length > 26 ? `${r.name.slice(0, 25)}…` : r.name}</b>
            <span><i className="d-amber" />{r.parts.votesPoints.toFixed(1)} upvote points</span>
            <span><i className="d-mint" />{r.parts.makerPoints.toFixed(1)} maker-comment points</span>
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
  const toggleCat = (id: CategoryId) =>
    setCats((cur) => {
      const next = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id];
      return next.length === CATEGORIES.length ? [] : next; // every category selected is the same as all
    });
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
      const res = await fetch("/api/scout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh }) });
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
    rows.filter((r) => (allCats || r.categories.some((c) => cats.includes(c))) && (!fitOnly || r.ai.fit === "strong" || r.ai.fit === "possible"));
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
  const exportCount = data ? ranked.length + tooEarly.length + (moreOpen ? more.length : 0) : 0;

  const catCount = (id: CategoryId) => (data ? data.ranked.filter((r) => r.categories.includes(id)).length : 0);

  const showHero = !data && !loading;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const aiOn = Boolean(data?.ai.available);
  const strongN = data ? data.ranked.filter((r) => r.ai.fit === "strong").length : 0;
  const hotRows = data ? data.ranked.filter((r) => r.urgency === "hot") : [];
  const coveragePct = data && data.counted.of ? Math.round((data.counted.n / data.counted.of) * 100) : 0;
  const top = data?.ranked[0];
  const catParts = CATEGORIES.map((c, i) => ({ label: c.label, n: catCount(c.id), color: CAT_COLORS[i % CAT_COLORS.length] }));
  const busy = loading !== null;

  const fitSwitch = (
    <label className="switch">
      <input type="checkbox" checked={fitOnly} disabled={!data?.ai.available} onChange={(e) => setFitOnly(e.target.checked)} />
      Strong and possible fit only
    </label>
  );
  const statusPill = data ? (
    <span className={`pill p-${data.source.toLowerCase()}`}>{data.source === "LIVE" && <span className="dot" aria-hidden="true" />}{data.source}<span className="when"> · {data.source === "SAMPLE" ? "bundled sample data from " : "fetched "}{fmtTime(data.fetchedAt)}</span></span>
  ) : null;
  const refreshLabel = loading === "refresh" ? "Refreshing…" : refreshWaitMin > 0 ? `Refresh now (in ${refreshWaitMin} min)` : "Refresh now";

  return (
    <>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><defs><linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7af5dc" /><stop offset="1" stopColor="#19c7a9" /></linearGradient></defs></svg>

      {showHero && (
        <>
          <div className="topbar"><div className="topbar-in"><div className="brand"><span className="mark" aria-hidden="true" />ProductHunt <span className="dim">Partnership Scout</span></div></div></div>
          <main className="landing">
            <section className="hero">
              <div className="hero-copy">
                <p className="eyebrow">Partnerships · last 7 days on Product Hunt</p>
                <h1>Find the launches worth a <em>conversation.</em></h1>
                <p className="sub">Launches from the last 7 days in project management, HR tech, developer productivity and team communication, ranked by upvotes and maker comments. It never contacts founders or sends outreach.</p>
                <div className="cta-bar">
                  <span className="cta-l"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13.2 13.2 17 17" /></svg>Scan Product Hunt, last 7 days, 4 categories</span>
                  <button className="primary" onClick={() => run(false)}>Generate</button>
                </div>
                <p className="hint">Takes up to a minute the first time.</p>
              </div>
              <div className="net" aria-hidden="true">
                <svg viewBox="0 0 520 440">
                  <defs><linearGradient id="netgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#ffd37a" /><stop offset="1" stopColor="#ff9a2e" /></linearGradient></defs>
                  {[40, 90, 140, 190, 240, 290, 340, 390].map((ty, i) => (
                    <g key={ty} opacity={0.35 + (i % 4 === 1 ? 0.5 : i % 3 === 0 ? 0.25 : 0.1)}>
                      <path d={`M70,220 C230,220 250,${ty} 380,${ty}`} className="net-line" />
                      <circle cx="380" cy={ty} r="5" className="net-node" />
                      <rect x="396" y={ty - 7} width={58 + (i % 3) * 14} height="14" rx="7" className="net-bar" />
                    </g>
                  ))}
                  <circle cx="70" cy="220" r="42" className="net-core-o" /><circle cx="70" cy="220" r="26" className="net-core" />
                </svg>
                <div className="net-card"><span className="fr-k" /><span className="fr-big" /><span className="fr-dots">{Array.from({ length: 22 }, (_, i) => <i key={i} style={{ height: `${20 + ((i * 37) % 70)}%` }} />)}</span></div>
              </div>
              <div className="strip" aria-label="Categories scanned"><span className="micro">Scans</span>{CATEGORIES.map((c) => <span key={c.id} className="strip-chip">{c.label}</span>)}</div>
              <ol className="steps" id="how">
                <li className="t-amber"><span className="ico ico-amber" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5" /><path d="M13.2 13.2 17 17" /></svg></span><span className="micro">01 · Scan</span><p>Product Hunt launches from the last 7 days across four categories, fetched live.</p></li>
                <li className="t-teal"><span className="ico ico-teal" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 16V9M10 16V4M16 16v-5" /></svg></span><span className="micro">02 · Rank</span><p>Half upvotes, half maker comments, each against the week&apos;s best. Computed in code.</p></li>
                <li className="t-purple"><span className="ico ico-purple" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 5h12v8H9l-3.5 3v-3H4z" /></svg></span><span className="micro">03 · Suggest</span><p>Gemini Flash writes an outreach angle backed by a quote from the launch page. It never changes the rank.</p></li>
              </ol>
            </section>
            {error && <div className="banner err">{error}</div>}
            <footer className="foot">
              <p>Review gate: you read the list and do all outreach yourself. The tool never contacts founders, never looks up emails and never sends outreach; its Draft message button only writes text for you to edit and send yourself. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email.</p>
              <p>Live data comes from the Product Hunt API (non-commercial use); AI text comes from Gemini Flash and never changes the order. Source badge: LIVE = fetched from Product Hunt now or within the last hour, CACHED = an older saved copy after a failed refresh, SAMPLE = bundled demo data.</p>
            </footer>
          </main>
        </>
      )}

      {!showHero && (
        <div className="shell">
          <aside className="side">
            <div className="brand"><span className="mark" aria-hidden="true" />Partnership Scout</div>
            {data && (
              <nav aria-label="Sections and filters">
                <p className="micro nav-h">Overview</p>
                <a className="nav on" href="#overview">Dashboard</a>
                <a className="nav" href="#list">Ranked list <span className="n">{data.ranked.length}</span></a>
                {data.tooEarly.length > 0 && <a className="nav" href="#early">Too early <span className="n">{data.tooEarly.length}</span></a>}
                {data.moreLaunches.length > 0 && <a className="nav" href="#more" onClick={() => setMoreOpen(true)}>More launches <span className="n">{data.moreLaunches.length}</span></a>}
                <p className="micro nav-h">Categories</p>
                <button className={`nav${allCats ? " on" : ""}`} aria-pressed={allCats} onClick={() => setCats([])}>All categories <span className="n">{data.ranked.length}</span></button>
                {CATEGORIES.map((c) => (
                  <button key={c.id} className={`nav${cats.includes(c.id) ? " on" : ""}`} aria-pressed={cats.includes(c.id)} onClick={() => toggleCat(c.id)}><span className="cb" aria-hidden="true" />{c.label} <span className="n">{catCount(c.id)}</span></button>
                ))}
                <p className="micro nav-h">View</p>
                <div className="side-switch">{fitSwitch}</div>
              </nav>
            )}
            {data && <div className="side-foot">{statusPill}{notice && <p className="notice" role="status">{notice}</p>}</div>}
          </aside>

          <div className="content">
            <header className="dash-head">
              <div className="brand m-brand"><span className="mark" aria-hidden="true" />Partnership Scout</div>
              <h1><span className="g">{greet}</span> <b>Kavya</b></h1>
              <p className="sub2">Here is this week&apos;s outreach shortlist.</p>
            </header>

            <section className="qas" aria-label="Actions">
              <button className="qa qa-main" onClick={() => run(false)} disabled={busy}><span>{loading === "generate" ? "Generating…" : "Generate"}<small>Build a fresh list</small></span><i className="qa-ico"><svg viewBox="0 0 20 20"><path d="M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z" /></svg></i></button>
              <button className="qa" onClick={() => run(true)} disabled={busy || !data || refreshWaitMin > 0} title="Fetch the launch list again (once every 5 minutes)"><span>{refreshLabel}<small>Once every 5 minutes</small></span><i className="qa-ico"><svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 1 1-2-4.5M16 3v3.500h-3.500" /></svg></i></button>
              <button className="qa" onClick={copyCsv} disabled={exportCount === 0}><span>Copy as CSV<small>{rowsLabel(exportCount)} visible</small></span><i className="qa-ico"><svg viewBox="0 0 20 20"><path d="M7 7h9v9H7zM4 13V4h9" /></svg></i></button>
              <button className="qa" onClick={downloadCsv} disabled={exportCount === 0}><span>Download CSV<small>{rowsLabel(exportCount)} visible</small></span><i className="qa-ico"><svg viewBox="0 0 20 20"><path d="M10 3v9m-3.500-3.500L10 12l3.500-3.500M4 16h12" /></svg></i></button>
            </section>

            {error && <div className="banner err">{error}</div>}
            {loading && (
              <>
                <div className="banner info" role="status">Scanning Product Hunt and writing outreach angles. The first run can take up to a minute.</div>
                <div className="panel" aria-hidden="true"><div className="table">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" />)}</div></div>
              </>
            )}
            {data?.warnings.map((w, i) => <div key={i} className={`banner ${w.startsWith("AI summaries unavailable") || w.startsWith("Live Product Hunt") ? "err" : ""}`}>{w}</div>)}

            {data && (
              <>
                <section className="kpis" id="overview" aria-label="Summary">
                  <div className="kpi k-amber"><span className="ico ico-amber" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5" /><path d="M13.2 13.2 17 17" /></svg></span><div className="kn">{data.counted.of}</div><div className="kl">Launches scanned</div></div>
                  <div className="kpi k-teal"><span className="ico ico-teal" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M4 6h12M4 10h12M4 14h8" /></svg></span><div className="kn">{data.ranked.length}</div><div className="kl">Ranked launches</div></div>
                  <div className="kpi k-lime"><span className="ico ico-lime" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m4 10.500 4 4 8-9" /></svg></span><div className="kn">{aiOn ? strongN : "–"}</div><div className="kl">Strong-fit launches</div></div>
                  <div className="kpi k-purple"><span className="ico ico-purple" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 3c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4 .3 1 1 1.500 1.500 1.500C10.500 7 10 5 10 3z" /></svg></span><div className="kn">{hotRows.length}</div><div className="kl">Contact now</div></div>
                </section>

                <section className="bento" aria-label="Insights">
                  <div className="card flat c-chart">
                    <div className="card-h"><h3>Where the points come from</h3><span className="micro">Top {Math.min(10, data.ranked.length)} launches</span></div>
                    <AreaChart rows={data.ranked.slice(0, 10)} />
                  </div>
                  <div className="card flat c-hot">
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
                          <a className="btn-a" href={top.url} target="_blank" rel="noreferrer">Open launch ↗</a>
                          {aiOn && top.ai.angle && <button className="ghost-dark" onClick={async () => flash((await copyText(top.ai.angle)) ? "Angle copied" : "Copy failed: select the text")}>Copy angle</button>}
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
                    {CATEGORIES.map((c) => (
                      <button key={c.id} className={`chip ${cats.includes(c.id) ? "on" : ""}`} aria-pressed={cats.includes(c.id)} onClick={() => toggleCat(c.id)}>{c.label} <span className="n">{catCount(c.id)}</span></button>
                    ))}
                  </div>
                  {fitSwitch}
                  {notice && <p className="notice" role="status">{notice}</p>}
                </div>

                <section className="panel flat" id="list">
                  <div className="listhead">
                    <h2>Ranked outreach list <span className="count">{ranked.length}</span></h2>
                    <span className="micro">Sorted by score</span>
                  </div>
                  <p className="hint">In order of score. Filters only hide rows. Window: {fmtTime(data.window.from)} to {fmtTime(data.window.to)}. Exports the {rowsLabel(exportCount)} currently visible.</p>
                  {ranked.length === 0 && <div className="empty">No launches match. Widen the filters{data.counted.of === 0 ? `, or no launches were found between ${fmtTime(data.window.from)} and ${fmtTime(data.window.to)}` : ""}.</div>}
                  {ranked.length > 0 && (
                    <div className="table">
                      <div className="thead" aria-hidden="true"><span>#</span><span>Product</span><span>Suggested outreach angle</span><span>Score</span><span /></div>
                      {ranked.map((r, i) => <Row key={r.id} r={r} rank={data.ranked.indexOf(r) + 1 || i + 1} showNew={isNew(r)} aiShown index={i} onCopied={flash} />)}
                    </div>
                  )}
                </section>

                {data.tooEarly.length > 0 && (
                  <section className="panel flat" id="early">
                    <div className="listhead"><h2>Too early to rank <span className="count">{tooEarly.length}</span></h2></div>
                    <p className="hint">Launched today; Product Hunt is still hiding the votes. They have no score yet and are not ranked.</p>
                    <div className="table">{tooEarly.map((r) => <Row key={r.id} r={r} showNew={isNew(r)} aiShown={r.ai.angle !== ""} onCopied={flash} />)}</div>
                  </section>
                )}

                {data.moreLaunches.length > 0 && (
                  <details className="panel flat more" id="more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
                    <summary>More launches ({more.length}), in score order, without an angle</summary>
                    <div className="table">{more.map((r) => <Row key={r.id} r={r} rank={data.ranked.length + data.moreLaunches.indexOf(r) + 1} showNew={isNew(r)} aiShown={false} onCopied={flash} />)}</div>
                  </details>
                )}
              </>
            )}

            <footer className="foot">
              <p>Review gate: you read the list and do all outreach yourself. The tool never contacts founders, never looks up emails and never sends outreach; its Draft message button only writes text for you to edit and send yourself. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email.</p>
              <p>Live data comes from the Product Hunt API (non-commercial use); AI text comes from Gemini Flash and never changes the order. Source badge: LIVE = fetched from Product Hunt now or within the last hour, CACHED = an older saved copy after a failed refresh, SAMPLE = bundled demo data.</p>
            </footer>
          </div>
        </div>
      )}
      <div role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
    </>
  );
}
