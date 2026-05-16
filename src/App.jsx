import { useState, useEffect } from "react";

// ─── VIX REGIME DATA (static, not user-parameterized) ─────────────
const VIX_REGIMES = [
  {
    id:"low",label:"Complacent",range:"< 15",color:"#4a9fd4",mult:0.75,
    contracts:{r1:5,r2:3,r3:2},
    strikes:{
      r1:{delta:"0.08–0.10",otm:"1.1–1.4%",prem:"$0.35–0.50"},
      r2:{delta:"0.10–0.13",otm:"1.9–2.4%",prem:"$1.50–2.50"},
      r3:{delta:"0.12–0.15",otm:"3.0–3.8%",prem:"$4.00–6.00"},
    },
    action:"Reduce to 10 contracts. Premiums are thin — don't stretch delta to chase income.",
    trap:"Do not go closer to ATM to maintain income. The risk/reward breaks down below VIX 15.",
  },
  {
    id:"normal",label:"Normal",range:"15–20",color:"#3aaa6a",mult:1.0,
    contracts:{r1:5,r2:5,r3:5},
    strikes:{
      r1:{delta:"0.10–0.12",otm:"1.4–1.6%",prem:"$0.50–0.80"},
      r2:{delta:"0.13–0.16",otm:"2.2–2.7%",prem:"$2.00–3.50"},
      r3:{delta:"0.15–0.18",otm:"3.4–4.1%",prem:"$5.50–8.50"},
    },
    action:"Full 15-contract ladder. Standard discipline on all three rungs.",
    trap:null,
  },
  {
    id:"elevated",label:"Elevated",range:"20–27",color:"#c8a84b",mult:1.45,
    contracts:{r1:5,r2:5,r3:5},
    strikes:{
      r1:{delta:"0.10–0.12",otm:"1.6–2.2%",prem:"$0.90–1.40"},
      r2:{delta:"0.13–0.15",otm:"2.7–3.5%",prem:"$3.50–5.50"},
      r3:{delta:"0.15–0.18",otm:"4.1–5.2%",prem:"$8.00–13.00"},
    },
    action:"Full ladder. Lock in Rung 3 early — VIX will revert. Same delta = strikes move further OTM automatically.",
    trap:"Rich premiums tempt you closer to ATM. Resist. VIX is elevated because risk is real.",
  },
  {
    id:"high",label:"High Vol",range:"27–35",color:"#e87a00",mult:1.9,
    contracts:{r1:3,r2:5,r3:5},
    strikes:{
      r1:{delta:"0.08–0.10",otm:"2.0–3.0%",prem:"$1.20–2.00"},
      r2:{delta:"0.12–0.15",otm:"3.8–4.9%",prem:"$5.00–9.00"},
      r3:{delta:"0.15–0.18",otm:"5.2–6.8%",prem:"$12.00–20.00"},
    },
    action:"Reduce Rung 1 to 3 contracts. Roll aggressively — elevated IV means credits on defensive rolls.",
    trap:"Don't sell 1-DTE puts near ATM chasing big premiums. Gap risk is acute in VIX 30+.",
  },
  {
    id:"spike",label:"Vol Spike",range:"> 35",color:"#cc3333",mult:2.5,
    contracts:{r1:0,r2:3,r3:5},
    strikes:{
      r1:{delta:"OFF",otm:"N/A",prem:"N/A"},
      r2:{delta:"0.10–0.12",otm:"4.8–6.8%",prem:"$4.00–8.00"},
      r3:{delta:"0.12–0.15",otm:"6.8–9.5%",prem:"$15.00–30.00"},
    },
    action:"Zero Rung 1. Take assignments, switch to covered calls. Rung 3 entries here are generational.",
    trap:"Do not catch falling knives with near-ATM puts. Market can go far lower than you think.",
  },
];

const ROLL_RULES = [
  {
    rung:"Rung 1 · 1–5 DTE",color:"#4a9fd4",canRoll:false,
    noRollNote:"At 1–5 DTE there is no meaningful extrinsic value left to roll. Close and re-enter as a fresh trade.",
    triggers:[
      {trigger:"1 DTE — within $5 of strike, still falling",action:"Buy back ($0.05–0.25). Re-enter next expiry 1–1.5% lower.",severity:"critical"},
      {trigger:"2 DTE (Mon expiry) — Friday close within $8",action:"Buy back Friday 3:45pm. Never carry Monday puts over weekend within $8.",severity:"critical"},
      {trigger:"3–5 DTE — SPY closes below strike",action:"Buy back at next open. Re-enter same week 1.5–2% lower.",severity:"high"},
      {trigger:"SPY gaps down 2%+ at open, puts < $12 OTM",action:"Close immediately. Do not wait for bounce.",severity:"critical"},
    ],
  },
  {
    rung:"Rung 2 · 7–14 DTE",color:"#8b6fd4",canRoll:true,noRollNote:null,
    triggers:[
      {trigger:"Delta expands to 0.30+",action:"Roll: buy current, sell 2–3% lower, +1 week. Target credit ≥ $0.10.",severity:"high"},
      {trigger:"SPY closes below strike 2 consecutive days",action:"Roll down and out immediately while extrinsic remains.",severity:"high"},
      {trigger:"7 DTE remaining, delta > 0.25",action:"Apply Rung 1 rules from here. No more rolling.",severity:"medium"},
      {trigger:"Can't roll for any credit",action:"Accept assignment. Sell covered calls at cost basis immediately.",severity:"medium"},
    ],
  },
  {
    rung:"Rung 3 · 21–30 DTE",color:"#3aaa6a",canRoll:true,noRollNote:null,
    triggers:[
      {trigger:"Delta expands to 0.35+",action:"Roll 3–5% lower, out 3–4 weeks. Collect $1–10 credit depending on IV.",severity:"high"},
      {trigger:"14 DTE remaining, delta > 0.25",action:"Switch to Rung 2 rules for remainder of position.",severity:"medium"},
      {trigger:"VIX spikes 30%+ in week 1",action:"OPPORTUNITY: Roll down 5–8%, collect large credit. April playbook.",severity:"opportunity"},
      {trigger:"Deep ITM (delta > 0.50), SPY down 8%+",action:"Roll 60–90 days if credit available. Accept small debit only at clear support.",severity:"critical"},
    ],
  },
];

const ITM_TREE = [
  {step:"1",q:"Put ITM with 5+ DTE remaining?",yes:"→ Step 2",no:"Buy back, take assignment, or hold if within $2 at expiry"},
  {step:"2",q:"Can you roll down/out for net credit ≥ $0.05?",yes:"Roll — choose best combo (Step 3)",no:"→ Step 4"},
  {step:"3",q:"Which roll type?",yes:"Same expiry lower strike (rising IV day) · +1 wk lower (normal) · +3-4 wks much lower (best, use for R3)",no:""},
  {step:"4",q:"Can you roll for small debit (<$1.00) to significantly better strike?",yes:"Only if SPY at clear technical support + strong bounce conviction",no:"→ Step 5"},
  {step:"5",q:"Rung 3 with 14+ DTE?",yes:"Wait 2–3 days — theta + any bounce may open a credit roll. Set alert.",no:"Take assignment. Begin covered call cycle."},
];

// ─── FORMATTERS ───────────────────────────────────────────────────
const fmt = (n) => n === undefined || n === null ? "—" : `$${Math.round(n).toLocaleString()}`;
const fmtPct = (n) => `${n.toFixed(1)}%`;
const fmtNum = (n) => Math.round(n).toLocaleString();

// ─── STORAGE KEY ─────────────────────────────────────────────────
const STORAGE_KEY = "wheel:params";

// Personal fields that are saved/loaded (never shared)
const PERSONAL_FIELDS = [
  "ticker","underlyingPrice",
  "totalCash","heloc","reservedForOptions",
  "stocks",
];

// Default form — personal fields blank, strategy fields have defaults
const DEFAULT_STOCK = { ticker: "", price: "", unrestrictedShares: "", restrictedShares: "", ccAvgPremium: 7.00, ccCyclesPerYear: 48 };
const DEFAULT_FORM = {
  // Personal — blank until user enters
  ticker: "",
  underlyingPrice: "",
  totalCash: "",
  heloc: "",
  reservedForOptions: "",
  stocks: [{ ...DEFAULT_STOCK }],   // array of stock positions for covered calls
  // Strategy — keep defaults (not personal data)
  avgPremium: 0.60,
  cyclesPerWeek: 5,
};

async function loadSavedParams() {
  try {
    const result = await window.storage.get(STORAGE_KEY, false);
    return result ? JSON.parse(result.value) : null;
  } catch {
    return null;
  }
}

async function saveParams(params) {
  // Only persist personal fields — strategy params are defaults and don't need saving
  const toSave = {};
  PERSONAL_FIELDS.forEach(k => { toSave[k] = params[k]; });
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(toSave), false);
  } catch (e) {
    console.error("Storage save failed:", e);
  }
}

async function clearSavedParams() {
  try {
    await window.storage.delete(STORAGE_KEY, false);
  } catch {}
}


// ─── ENTRY FIELD — standalone so React never remounts inputs ─────
// Must live outside EntryPage. Receives state via explicit props.
function EntryField({ label, k, type, prefix, step, note, form, errors, hasSaved, setForm, setErrors }) {
  const isNum = type !== "text";
  const hasError = !!(errors && errors[k]);
  const isPersonal = PERSONAL_FIELDS.includes(k);

  const handleChange = (e) => {
    if (errors && errors[k]) {
      setErrors(prev => { const n = {...prev}; delete n[k]; return n; });
    }
    const raw = e.target.value;
    setForm(f => ({ ...f, [k]: isNum ? (raw === "" ? "" : Number(raw)) : raw }));
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <label style={{ fontSize: 10, color: hasError ? "#e87a7a" : isPersonal ? "#c8a84b" : "#4a9fd4", letterSpacing: "0.12em" }}>
          {label}
        </label>
        {hasError && <span style={{ fontSize: 9, color: "#e87a7a" }}>required</span>}
        {isPersonal && !hasError && hasSaved && form[k] !== "" &&
          <span style={{ fontSize: 9, color: "#2a6a4a" }}>saved</span>
        }
      </div>
      <div style={{ display: "flex", alignItems: "center", background: "#06101a", border: `1px solid ${hasError ? "#6a2a2a" : "#1e3a50"}`, borderRadius: 4, overflow: "hidden" }}>
        {prefix && (
          <span style={{ padding: "0 10px", color: "#3a6a8a", fontSize: 13, background: "#0a1a2a", borderRight: "1px solid #1e3a50" }}>
            {prefix}
          </span>
        )}
        <input
          type={isNum ? "number" : "text"}
          value={form[k] ?? ""}
          step={step || 1}
          placeholder="--"
          autoComplete="off"
          onChange={handleChange}
          style={{
            flex: 1, padding: "10px 12px", background: "transparent",
            border: "none", color: "#f0f8ff", fontSize: 14, fontFamily: "monospace",
            outline: "none",
          }}
        />
      </div>
      {note && !hasError && <div style={{ fontSize: 10, color: "#2a5a6a", marginTop: 3 }}>{note}</div>}
    </div>
  );
}

// ─── ENTRY PAGE ───────────────────────────────────────────────────
function EntryPage({ onSubmit, savedValues, onClearData }) {
  const [form, setForm] = useState(() => ({
    ...DEFAULT_FORM,
    // Overlay any previously saved personal fields
    ...(savedValues || {}),
  }));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [hasSaved, setHasSaved] = useState(!!savedValues);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const num = (k, v) => set(k, v === "" ? "" : Number(v));

  // Validation — personal numeric fields must be filled and positive
  const REQUIRED_NUMERIC = [
    {k:"underlyingPrice", label:"Underlying Price"},
    {k:"totalCash", label:"Total Cash"},
    {k:"heloc", label:"HELOC"},
    {k:"reservedForOptions", label:"Reserved for Open Puts"},
  ];
  const REQUIRED_TEXT = [
    {k:"ticker", label:"Underlying Ticker"},
  ];

  const validate = () => {
    const errs = {};
    REQUIRED_NUMERIC.forEach(({k,label}) => {
      if (form[k] === "" || form[k] === null || form[k] === undefined) errs[k] = `${label} is required`;
      else if (Number(form[k]) < 0) errs[k] = `${label} must be ≥ 0`;
    });
    REQUIRED_TEXT.forEach(({k,label}) => {
      if (!form[k] || String(form[k]).trim() === "") errs[k] = `${label} is required`;
    });
    return errs;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setSaving(true);
    // Coerce all numeric fields to numbers before saving
    const coerced = { ...form };
    REQUIRED_NUMERIC.forEach(({k}) => { coerced[k] = Number(coerced[k]); });
    await saveParams(coerced);
    setSaving(false);
    setHasSaved(true);
    onSubmit(coerced);
  };

  // Derived previews — guard against blank values
  const hasCash = form.totalCash !== "" && form.reservedForOptions !== "" && form.underlyingPrice !== "";
  const freeCash = hasCash ? Math.max(0, Number(form.totalCash) - Number(form.reservedForOptions)) : null;
  const accountValue = hasCash ? Number(form.totalCash) + form.stocks.reduce((s,st) => s + (Number(st.unrestrictedShares)||0+Number(st.restrictedShares)||0)*Number(st.price||0), 0) : null;
  const maxContractsCash = hasCash ? Math.floor(Number(form.totalCash) / (Number(form.underlyingPrice) * 100)) : null;
  const spyAnnual = form.underlyingPrice !== "" ? form.avgPremium * 100 * 10 * form.cyclesPerWeek * 52 : null;
  const stocksAnnual = form.stocks.reduce((s,st) => {
    const ccC = Math.floor((Number(st.unrestrictedShares)||0)/100);
    return s + ccC * Number(st.ccAvgPremium||0) * 100 * Number(st.ccCyclesPerYear||48);
  }, 0);
  const gsAnnual = stocksAnnual > 0 ? stocksAnnual : null;


  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", background: "#050d14", minHeight: "100vh", color: "#d0dde8" }}>

      {/* Hero header */}
      <div style={{ background: "linear-gradient(135deg, #060f1a 0%, #0a1e30 60%, #0d2540 100%)", padding: "40px 32px 32px", borderBottom: "1px solid #1a3a50" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.35em", color: "#4a9fd4", marginBottom: 12 }}>WHEEL STRATEGY · COMMAND CENTER</div>
          <h1 style={{ fontSize: 32, fontWeight: "700", color: "#f0f8ff", margin: "0 0 8px", letterSpacing: "-1px" }}>
            Portfolio Setup
          </h1>
          <p style={{ fontSize: 13, color: "#4a7a9a", margin: 0, lineHeight: 1.6 }}>
            Enter your current account parameters. All analytics, projections, shock tests, and sizing recommendations will be generated from these inputs.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 32px" }}>

        {/* Saved data banner */}
        {savedValues && (
          <div style={{ background: "#0a2a18", border: "1px solid #1a5a3a", borderRadius: 6, padding: "10px 16px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: 10, color: "#3aaa6a", letterSpacing: "0.1em" }}>🔒 SAVED CONFIGURATION LOADED</span>
              <div style={{ fontSize: 11, color: "#2a6a4a", marginTop: 2 }}>
                Your previously entered account data has been restored. Review and update any values that have changed, then regenerate.
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

          {/* Col 1 */}
          <div>
            {/* Underlying */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#c8a84b", letterSpacing: "0.2em", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #1a2a3a" }}>
                UNDERLYING (PUT WHEEL)
              </div>
              <EntryField label="TICKER" k="ticker" type="text" note="The index or ETF you're writing puts on"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>
              <EntryField label="CURRENT PRICE" k="underlyingPrice" prefix="$" step={0.01} note="Today's market price"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>
            </div>

            {/* Cash */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#c8a84b", letterSpacing: "0.2em", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #1a2a3a" }}>
                CASH & COLLATERAL
              </div>
              <EntryField label="TOTAL CASH (brokerage)" k="totalCash" prefix="$" note="All cash including settled option proceeds"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>
              <EntryField label="RESERVED FOR OPEN PUTS" k="reservedForOptions" prefix="$" note="Fidelity 'Cash reserved for options strategies'"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>
              <EntryField label="HELOC / EXTERNAL BACKSTOP" k="heloc" prefix="$" note="Available credit line for assignment funding"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>

              {/* Derived preview */}
              <div style={{ background: "#06101a", border: "1px solid #1a3a50", borderRadius: 6, padding: "12px 14px", marginTop: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { label: "Free cash (unencumbered)", value: freeCash !== null ? fmt(freeCash) : "—", color: freeCash !== null ? "#3aaa6a" : "#2a4a5a" },
                    { label: "Max contracts (cash only)", value: maxContractsCash !== null ? `${maxContractsCash}c` : "—", color: maxContractsCash !== null ? "#4a9fd4" : "#2a4a5a" },
                  ].map((r, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 9, color: "#3a5a6a", marginBottom: 2 }}>{r.label}</div>
                      <div style={{ fontSize: 14, fontWeight: "700", color: r.color }}>{r.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Col 2 */}
          <div>
            {/* Stock positions — multi-row */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #1a2a3a" }}>
                <div style={{ fontSize: 10, color: "#c8a84b", letterSpacing: "0.2em" }}>STOCK POSITIONS (COVERED CALLS)</div>
                <button onClick={() => setForm(f => ({ ...f, stocks: [...f.stocks, { ...DEFAULT_STOCK }] }))}
                  style={{ padding: "3px 10px", background: "#0a2a18", color: "#3aaa6a", border: "1px solid #1a5a3a", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}>
                  + ADD STOCK
                </button>
              </div>

              {form.stocks.map((stock, si) => {
                const setStock = (k, v) => setForm(f => {
                  const updated = [...f.stocks];
                  updated[si] = { ...updated[si], [k]: v };
                  return { ...f, stocks: updated };
                });
                const ccContracts = Math.floor((Number(stock.unrestrictedShares)||0) / 100);
                const stockValue = (Number(stock.unrestrictedShares)||0 + Number(stock.restrictedShares)||0) * Number(stock.price||0);
                return (
                  <div key={si} style={{ background: "#06101a", border: "1px solid #1a3a50", borderRadius: 6, padding: "12px 14px", marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: "#4a9fd4", letterSpacing: "0.1em" }}>POSITION {si + 1}</div>
                      {form.stocks.length > 1 && (
                        <button onClick={() => setForm(f => ({ ...f, stocks: f.stocks.filter((_,i) => i !== si) }))}
                          style={{ padding: "2px 8px", background: "transparent", color: "#6a3a3a", border: "1px solid #3a2a2a", borderRadius: 3, cursor: "pointer", fontSize: 9, fontFamily: "monospace" }}>
                          REMOVE
                        </button>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {[
                        { label: "TICKER", k: "ticker", type: "text" },
                        { label: "PRICE", k: "price", prefix: "$", step: 0.01 },
                        { label: "UNRESTRICTED SHARES", k: "unrestrictedShares" },
                        { label: "RESTRICTED SHARES (RSU)", k: "restrictedShares" },
                        { label: "AVG CC PREMIUM / CONTRACT", k: "ccAvgPremium", prefix: "$", step: 0.25 },
                        { label: "CC CYCLES / YEAR", k: "ccCyclesPerYear", step: 1 },
                      ].map(({ label, k, type, prefix, step }) => (
                        <div key={k} style={{ marginBottom: 0 }}>
                          <div style={{ fontSize: 9, color: "#3a6a8a", marginBottom: 4, letterSpacing: "0.08em" }}>{label}</div>
                          <div style={{ display: "flex", alignItems: "center", background: "#040c14", border: "1px solid #1a3a50", borderRadius: 3, overflow: "hidden" }}>
                            {prefix && <span style={{ padding: "0 8px", color: "#3a6a8a", fontSize: 12, background: "#080f18", borderRight: "1px solid #1a3a50" }}>{prefix}</span>}
                            <input
                              type={type === "text" ? "text" : "number"}
                              value={stock[k] ?? ""}
                              step={step || 1}
                              placeholder="—"
                              autoComplete="off"
                              onChange={e => setStock(k, type === "text" ? e.target.value : (e.target.value === "" ? "" : Number(e.target.value)))}
                              style={{ flex: 1, padding: "8px 10px", background: "transparent", border: "none", color: "#f0f8ff", fontSize: 13, fontFamily: "monospace", outline: "none" }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 10, fontFamily: "monospace", color: "#3a6a8a" }}>
                      <span>Contracts: <span style={{ color: "#8b6fd4" }}>{ccContracts}</span></span>
                      <span>Est. CC income: <span style={{ color: "#3aaa6a" }}>{fmt(ccContracts * Number(stock.ccAvgPremium||0) * 100 * Number(stock.ccCyclesPerYear||48))}/yr</span></span>
                      {hasSaved && <span style={{ color: "#2a6a4a" }}>● saved</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* SPY Put strategy params */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#c8a84b", letterSpacing: "0.2em", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid #1a2a3a" }}>
                PUT STRATEGY PARAMETERS
              </div>
              <EntryField label={`AVG PUT PREMIUM / CONTRACT (${form.ticker})`} k="avgPremium" prefix="$" step={0.05} note="Your actual avg — typically $0.50–$0.70 for 1–5 DTE"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>
              <EntryField label="PUT CYCLES PER WEEK" k="cyclesPerWeek" step={1} note="How many open/close cycles you run weekly"  form={form} errors={errors} hasSaved={hasSaved} setForm={setForm} setErrors={setErrors}/>

              {/* Income preview */}
              <div style={{ background: "#06101a", border: "1px solid #1a3a50", borderRadius: 6, padding: "12px 14px", marginTop: 4 }}>
                <div style={{ fontSize: 9, color: "#3a5a6a", marginBottom: 8 }}>EST. ANNUAL INCOME PREVIEW (10 put contracts)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[
                    { label: `${form.ticker || "—"} puts`, value: spyAnnual !== null ? fmt(spyAnnual) : "—", color: spyAnnual !== null ? "#4a9fd4" : "#2a4a5a" },
                    { label: "All CC income", value: gsAnnual !== null ? fmt(gsAnnual) : "—", color: gsAnnual !== null ? "#8b6fd4" : "#2a4a5a" },
                    { label: "Combined", value: (spyAnnual !== null && gsAnnual !== null) ? fmt(spyAnnual + gsAnnual) : "—", color: (spyAnnual !== null && gsAnnual !== null) ? "#c8a84b" : "#2a4a5a" },
                  ].map((r, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 9, color: "#3a5a6a", marginBottom: 2 }}>{r.label}</div>
                      <div style={{ fontSize: 14, fontWeight: "700", color: r.color }}>{r.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Validation summary */}
        {Object.keys(errors).length > 0 && (
          <div style={{ background: "#1a0808", border: "1px solid #6a2a2a", borderRadius: 6, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#e87a7a", letterSpacing: "0.1em", marginBottom: 4 }}>PLEASE COMPLETE ALL REQUIRED FIELDS</div>
            <div style={{ fontSize: 11, color: "#a06060" }}>
              {Object.values(errors).join(" · ")}
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{
            width: "100%", padding: "16px", marginTop: 8,
            background: saving ? "#1a3a5a" : "linear-gradient(135deg, #1a4a7a, #1a6aa8)",
            color: saving ? "#5a8ab0" : "#f0f8ff", border: "1px solid #2a6aa8",
            borderRadius: 6, cursor: saving ? "default" : "pointer", fontSize: 14, fontWeight: "700",
            fontFamily: "monospace", letterSpacing: "0.1em",
          }}
        >
          {saving ? "SAVING…" : "GENERATE STRATEGY ANALYSIS →"}
        </button>

        {/* Storage notice + clear option */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          <div style={{ fontSize: 10, color: "#1a3a4a", lineHeight: 1.6 }}>
            <span style={{ color: "#2a6a4a" }}>🔒</span> Your account data is saved privately to this browser only — never shared with other users.
          </div>
          {savedValues && (
            <button
              onClick={onClearData}
              style={{ padding: "4px 12px", background: "transparent", color: "#4a3a3a", border: "1px solid #2a2a2a", borderRadius: 4, cursor: "pointer", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.08em", whiteSpace: "nowrap", marginLeft: 16 }}
            >
              CLEAR SAVED DATA
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MAIN DASHBOARD ───────────────────────────────────────────────
function Dashboard({ params, onReset }) {
  // ── Derive everything from params ──
  const P = params;
  const SPY = P.underlyingPrice;
  const CASH = P.totalCash;
  const RESERVED = P.reservedForOptions;
  const FREE_CASH = Math.max(0, CASH - RESERVED);
  const HELOC = P.heloc;
  // Multi-stock aggregates
  const STOCKS = P.stocks || [];
  const TOTAL_UNREST = STOCKS.reduce((s,st) => s + (Number(st.unrestrictedShares)||0), 0);
  const TOTAL_REST = STOCKS.reduce((s,st) => s + (Number(st.restrictedShares)||0), 0);
  const TOTAL_STOCK_VALUE = STOCKS.reduce((s,st) => s + ((Number(st.unrestrictedShares)||0)+(Number(st.restrictedShares)||0))*(Number(st.price)||0), 0);
  const ACCOUNT = CASH + TOTAL_STOCK_VALUE;
  // Backward compat aliases (used in shock calc — use first stock as primary)
  const GS_PRICE = STOCKS[0] ? Number(STOCKS[0].price)||0 : 0;
  const GS_UNREST = STOCKS[0] ? Number(STOCKS[0].unrestrictedShares)||0 : 0;
  const GS_REST = STOCKS[0] ? Number(STOCKS[0].restrictedShares)||0 : 0;
  const CYCLES = P.cyclesPerWeek;
  const PREM = P.avgPremium;
  const PREM_MID = 0.60;

  // Rung specs (strikes scale with SPY price)
  const RUNGS = [
    { label: `Rung 1 · 1–5 DTE`, color: "#4a9fd4", delta: "0.08–0.12", otmPct: 1.4, premMid: PREM, cycles: CYCLES * 52, dte: "1–5" },
    { label: `Rung 2 · 7–14 DTE`, color: "#8b6fd4", delta: "0.12–0.18", otmPct: 2.4, premMid: 2.50, cycles: 36, dte: "7–14" },
    { label: `Rung 3 · 21–30 DTE`, color: "#3aaa6a", delta: "0.15–0.22", otmPct: 3.8, premMid: 6.50, cycles: 15, dte: "21–30" },
  ];

  // State
  const [section, setSection] = useState("capital");
  const [shockPct, setShockPct] = useState(10);
  const [useHeloc, setUseHeloc] = useState(true);
  const [contracts, setContracts] = useState(10);
  const [premSlider, setPremSlider] = useState(PREM);
  const [vixLive, setVixLive] = useState(17);
  const [activeRegime, setActiveRegime] = useState(1);
  const [activeRoll, setActiveRoll] = useState(0);
  const [itmScenario, setItmScenario] = useState(0);
  const [ladderRung, setLadderRung] = useState(0);

  // Derived income
  const spyGross = premSlider * 100 * contracts * CYCLES * 52;
  const commissions = contracts * 0.65 * CYCLES * 52;
  const spyNet = spyGross - commissions;
  const gsCallGross = STOCKS.reduce((s,st) => {
    const c = Math.floor((Number(st.unrestrictedShares)||0)/100);
    return s + c * (Number(st.ccAvgPremium)||0) * 100 * (Number(st.ccCyclesPerYear)||48);
  }, 0);
  const gsCallComm = STOCKS.reduce((s,st) => {
    const c = Math.floor((Number(st.unrestrictedShares)||0)/100);
    return s + c * 0.65 * (Number(st.ccCyclesPerYear)||48);
  }, 0);
  const gsCallNet = gsCallGross - gsCallComm;
  const spaxxNet = FREE_CASH * 0.042;
  const totalNet = spyNet + gsCallNet + spaxxNet;

  // Shock
  const spyShocked = Math.round(SPY * (1 - shockPct / 100));
  const gsShockedPct = Math.min(shockPct * 1.3, 65);
  const gsShocked = Math.round(GS_PRICE * (1 - gsShockedPct / 100));
  const strikeEst = Math.round(SPY * 0.985);
  const assigned = spyShocked < strikeEst;
  const assignCost = contracts * strikeEst * 100;
  const putPremColl = premSlider * 100 * contracts;
  const intrinsicLoss = assigned ? (strikeEst - spyShocked) * 100 * contracts : 0;
  const putPnl = putPremColl - intrinsicLoss;
  const gsRestPnl = (gsShocked - GS_PRICE) * GS_REST;
  const gsUnrestPnl = (gsShocked - GS_PRICE) * GS_UNREST;
  const totalPnl = putPnl + gsRestPnl + gsUnrestPnl;

  // Live VIX regime
  const liveRegime = vixLive < 15 ? VIX_REGIMES[0] : vixLive < 20 ? VIX_REGIMES[1] : vixLive < 27 ? VIX_REGIMES[2] : vixLive < 35 ? VIX_REGIMES[3] : VIX_REGIMES[4];

  const nav = [
    {id:"capital",label:"Capital"},
    {id:"income",label:"Income"},
    {id:"shock",label:"Shock Test"},
    {id:"ladder",label:"Ladder"},
    {id:"vix",label:"VIX Rules"},
    {id:"roll",label:"Roll Rules"},
    {id:"itm",label:"ITM Decisions"},
  ];

  const sev = {critical:"#cc3333",high:"#e87a00",medium:"#c8a84b",low:"#3aaa6a",opportunity:"#4a9fd4"};

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", background: "#050d14", minHeight: "100vh", color: "#d0dde8" }}>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #060f1a 0%, #0d2030 100%)", borderBottom: "1px solid #1a3a50", padding: "16px 24px 0" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.25em", color: "#4a9fd4", marginBottom: 4 }}>
                {P.ticker} WHEEL · {STOCKS.map(s=>s.ticker).filter(Boolean).join(", ")} COVERED CALLS · CASH-SECURED
              </div>
              <div style={{ fontSize: 20, fontWeight: "700", color: "#f0f8ff" }}>Strategy Command Center</div>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#3a6a8a", marginBottom: 2 }}>{P.ticker} PRICE</div>
                <div style={{ fontSize: 18, fontWeight: "700", color: "#c8a84b" }}>${SPY.toLocaleString()}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#3a6a8a", marginBottom: 2 }}>ACCOUNT</div>
                <div style={{ fontSize: 18, fontWeight: "700", color: "#c8a84b" }}>{fmt(ACCOUNT)}</div>
              </div>
              <button onClick={onReset} style={{
                padding: "6px 14px", background: "transparent", color: "#3a6a8a",
                border: "1px solid #1a3a50", borderRadius: 4, cursor: "pointer",
                fontSize: 10, fontFamily: "monospace", letterSpacing: "0.1em",
              }}>⟵ UPDATE INPUTS</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 0, overflowX: "auto" }}>
            {nav.map(n => (
              <button key={n.id} onClick={() => setSection(n.id)} style={{
                padding: "9px 16px", background: "transparent",
                color: section === n.id ? "#c8a84b" : "#3a6a8a",
                border: "none", borderBottom: section === n.id ? "2px solid #c8a84b" : "2px solid transparent",
                cursor: "pointer", fontSize: 10, letterSpacing: "0.1em",
                fontWeight: section === n.id ? "700" : "400", textTransform: "uppercase",
                whiteSpace: "nowrap", fontFamily: "monospace",
              }}>{n.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px" }}>

        {/* ═══ CAPITAL ═══ */}
        {section === "capital" && (
          <div>
            <SH title="Capital Picture" sub={`${P.ticker} @ $${SPY} · ${STOCKS.map(s=>s.ticker).filter(Boolean).join(", ")} · Confirmed balance inputs`} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
              {[
                {label:"Total Cash",value:fmt(CASH),sub:"Brokerage balance",color:"#4a9fd4"},
                {label:"Reserved (Puts)",value:fmt(RESERVED),sub:"Cycles back weekly",color:"#e87a00"},
                {label:"Free Cash",value:fmt(FREE_CASH),sub:"No margin impact",color:"#3aaa6a"},
                {label:"HELOC Backstop",value:fmt(HELOC),sub:"External · unused",color:"#8b6fd4"},
              ].map((c,i) => <SC key={i} {...c} />)}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Pan>
                <Lbl>ACCOUNT BREAKDOWN</Lbl>
                {[
                  {label:"Est. Account Value",value:fmt(ACCOUNT),bold:true,color:"#f0f8ff"},
                  {label:"Total Cash",value:fmt(CASH),color:"#4a9fd4"},
                  {label:"  Reserved for open puts",value:fmt(-RESERVED),color:"#e87a00"},
                  {label:"  Free cash",value:fmt(FREE_CASH),bold:true,color:"#3aaa6a"},
                  {label:`Stock positions (unrestricted: ${TOTAL_UNREST} sh)`,value:fmt(STOCKS.reduce((s,st)=>(Number(st.unrestrictedShares)||0)*(Number(st.price)||0)+s,0)),color:"#4a9fd4"},
                  {label:`Stock positions (restricted: ${TOTAL_REST} sh)`,value:fmt(STOCKS.reduce((s,st)=>(Number(st.restrictedShares)||0)*(Number(st.price)||0)+s,0)),color:"#5a6a7a"},
                  {label:"HELOC backstop (external)",value:fmt(HELOC),color:"#8b6fd4"},
                ].map((r,i) => (
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #1a2a3a",fontWeight:r.bold?"700":"400"}}>
                    <span style={{fontSize:11,color:"#5a7a8a"}}>{r.label}</span>
                    <span style={{fontSize:12,color:r.color||"#d0dde8"}}>{r.value}</span>
                  </div>
                ))}
                <div style={{marginTop:12,padding:"10px 12px",background:"#0a2a18",borderRadius:4,borderLeft:"3px solid #3aaa6a"}}>
                  <div style={{fontSize:10,color:"#3aaa6a",marginBottom:3}}>MARGIN INTEREST</div>
                  <div style={{fontSize:12,color:"#a0e8c0"}}>$0.00 daily · $0.00 MTD · 0.0% rate — fully cash-secured</div>
                </div>
              </Pan>

              <Pan>
                <Lbl>STOCK POSITIONS</Lbl>
                {STOCKS.map((st, si) => {
                  const unrest = Number(st.unrestrictedShares)||0;
                  const rest = Number(st.restrictedShares)||0;
                  const price = Number(st.price)||0;
                  const ccC = Math.floor(unrest/100);
                  const ccIncome = ccC * (Number(st.ccAvgPremium)||0) * 100 * (Number(st.ccCyclesPerYear)||48);
                  return (
                    <div key={si} style={{padding:"10px 14px",borderRadius:6,marginBottom:8,background:"#06101a",border:"1px solid #1a3a5025",borderLeft:"3px solid #4a9fd4"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <span style={{fontSize:13,fontWeight:"700",color:"#4a9fd4"}}>{st.ticker || `Stock ${si+1}`}</span>
                        <span style={{fontSize:12,color:"#c8a84b"}}>{fmt((unrest+rest)*price)}</span>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,fontSize:10,fontFamily:"monospace"}}>
                        <div><div style={{color:"#3a6a8a",marginBottom:2}}>Price</div><div>${price.toLocaleString()}</div></div>
                        <div><div style={{color:"#3a6a8a",marginBottom:2}}>Unrestricted</div><div style={{color:"#4a9fd4"}}>{unrest} sh</div></div>
                        <div><div style={{color:"#3a6a8a",marginBottom:2}}>Restricted</div><div style={{color:"#5a6a7a"}}>{rest} sh</div></div>
                        <div><div style={{color:"#3a6a8a",marginBottom:2}}>CC Income/yr</div><div style={{color:"#3aaa6a"}}>{fmt(ccIncome)}</div></div>
                      </div>
                    </div>
                  );
                })}

                <Lbl style={{marginTop:8}}>KEY STRUCTURAL FACTS</Lbl>
                {[
                  ["Zero margin cost","Every premium dollar is net income. No interest offset."],
                  [fmt(RESERVED)+" cycles weekly","Reserved collateral frees as puts expire — it's revolving."],
                  ["HELOC removes forced-sale risk",`${fmt(CASH)} cash + ${fmt(HELOC)} HELOC = ${fmt(CASH+HELOC)} capacity. Total stock equity: ${fmt(TOTAL_STOCK_VALUE)}.`],
                ].map(([t,b],i) => (
                  <div key={i} style={{marginBottom:8,padding:"8px 10px",background:"#06101a",borderRadius:4,borderLeft:"2px solid #c8a84b"}}>
                    <div style={{fontSize:10,color:"#c8a84b",marginBottom:3}}>{t}</div>
                    <div style={{fontSize:11,color:"#5a7a8a",lineHeight:1.6}}>{b}</div>
                  </div>
                ))}
              </Pan>
            </div>
          </div>
        )}

        {/* ═══ INCOME ═══ */}
        {section === "income" && (
          <div>
            <SH title="Income Projections" sub="Adjust contracts and premium to model different scenarios" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <Pan>
                <Lbl>ADJUST ASSUMPTIONS</Lbl>
                {[
                  {label:`Avg premium / contract (${P.ticker} puts)`,val:premSlider,set:setPremSlider,min:0.20,max:3.00,step:0.05,fmt:v=>`$${v.toFixed(2)}`,note:`Your actual avg: $${P.avgPremium.toFixed(2)}`},
                  {label:"Contracts open",val:contracts,set:setContracts,min:1,max:25,step:1,fmt:v=>`${v}`,note:`Notional: ${fmt(contracts*SPY*100)}`},
                ].map((s,i) => (
                  <div key={i} style={{marginBottom:18}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                      <span style={{fontSize:11,color:"#5a7a8a"}}>{s.label}</span>
                      <span style={{fontSize:16,fontWeight:"700",color:"#c8a84b"}}>{s.fmt(s.val)}</span>
                    </div>
                    <input type="range" min={s.min} max={s.max} step={s.step} value={s.val}
                      onChange={e=>s.set(Number(e.target.value))}
                      style={{width:"100%",accentColor:"#c8a84b"}}
                    />
                    <div style={{fontSize:10,color:"#2a5a6a",marginTop:3}}>{s.note}</div>
                  </div>
                ))}

                <div style={{borderTop:"1px solid #1a2a3a",paddingTop:14,marginTop:4}}>
                  <Lbl>SENSITIVITY ({P.ticker} puts, {contracts} contracts)</Lbl>
                  <div style={{fontSize:10}}>
                    <div style={{display:"grid",gridTemplateColumns:"1.8fr 0.7fr 1fr 0.8fr",padding:"4px 0",color:"#2a5a6a",marginBottom:4}}>
                      {["Environment","$/c","Annual","Yield"].map(h=><span key={h}>{h}</span>)}
                    </div>
                    {[
                      {env:"Low VIX (thin)",p:P.avgPremium*0.75},
                      {env:`Your avg ($${P.avgPremium.toFixed(2)})`,p:P.avgPremium,hl:true},
                      {env:"VIX 22–25",p:P.avgPremium*1.6},
                      {env:"VIX 27–35 (spike)",p:P.avgPremium*2.8},
                    ].map((r,i) => {
                      const ann = r.p * 100 * contracts * CYCLES * 52;
                      return (
                        <div key={i} style={{display:"grid",gridTemplateColumns:"1.8fr 0.7fr 1fr 0.8fr",padding:"6px 0",borderBottom:"1px solid #1a2a3a",color:r.hl?"#c8a84b":"#5a7a8a",fontWeight:r.hl?"700":"400"}}>
                          <span>{r.env}</span>
                          <span>${r.p.toFixed(2)}</span>
                          <span>${Math.round(ann/1000)}k</span>
                          <span>{fmtPct(ann/ACCOUNT*100)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Pan>

              <div>
                <Pan style={{marginBottom:16}}>
                  <Lbl>ANNUAL INCOME — ALL LEGS</Lbl>
                  {[
                    {leg:`${P.ticker} short puts`,detail:`${contracts}c × $${premSlider.toFixed(2)} × ${CYCLES}×/wk × 52`,gross:spyGross,net:spyNet,color:"#4a9fd4"},
                    {leg:`All covered calls (${STOCKS.length} position${STOCKS.length!==1?"s":""})`,detail:STOCKS.map(st=>`${st.ticker||"?"} ${Math.floor((Number(st.unrestrictedShares)||0)/100)}c`).join(" · "),gross:gsCallGross,net:gsCallNet,color:"#8b6fd4"},
                    {leg:"SPAXX on free cash",detail:`${fmt(FREE_CASH)} × 4.2%`,gross:spaxxNet,net:spaxxNet,color:"#3aaa6a"},
                  ].map((r,i) => (
                    <div key={i} style={{padding:"10px 12px",borderRadius:6,marginBottom:8,background:"#06101a",borderLeft:`3px solid ${r.color}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontSize:11,color:r.color,fontWeight:"700"}}>{r.leg}</span>
                        <span style={{fontSize:16,fontWeight:"700",color:r.color}}>{fmt(r.net)}</span>
                      </div>
                      <div style={{fontSize:10,color:"#2a5a6a"}}>{r.detail}</div>
                    </div>
                  ))}
                  <div style={{borderTop:"1px solid #1a2a3a",paddingTop:12,marginTop:6,display:"grid",gridTemplateColumns:"1fr 1fr"}}>
                    <div>
                      <div style={{fontSize:9,color:"#2a5a6a",marginBottom:3}}>NET ANNUAL</div>
                      <div style={{fontSize:26,fontWeight:"700",color:"#c8a84b"}}>{fmt(totalNet)}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:9,color:"#2a5a6a",marginBottom:3}}>YIELD ON {fmt(ACCOUNT)}</div>
                      <div style={{fontSize:26,fontWeight:"700",color:"#c8a84b"}}>{fmtPct(totalNet/ACCOUNT*100)}</div>
                    </div>
                  </div>
                </Pan>

                <Pan>
                  <Lbl>CONTRACT SIZING OPTIONS</Lbl>
                  <div style={{fontSize:10}}>
                    <div style={{display:"grid",gridTemplateColumns:"0.4fr 0.9fr 0.9fr 1.1fr 0.9fr",padding:"4px 0",color:"#2a5a6a",marginBottom:6}}>
                      {["#","Notional","Assignment","Funded by","Ann. Prem"].map(h=><span key={h}>{h}</span>)}
                    </div>
                    {[5,8,10,13,17].map((n,i) => {
                      const not = n*SPY*100;
                      const cost = n*Math.round(SPY*0.985)*100;
                      const ann = n*P.avgPremium*100*CYCLES*52;
                      const funded = cost<=CASH?"Cash only":cost<=CASH+HELOC?`+${fmt(cost-CASH)} HELOC`:"Exceeds resources";
                      const isRec = n===10;
                      return (
                        <div key={i} style={{display:"grid",gridTemplateColumns:"0.4fr 0.9fr 0.9fr 1.1fr 0.9fr",padding:"7px 0",borderBottom:"1px solid #1a2a3a",color:isRec?"#c8a84b":"#5a7a8a",fontWeight:isRec?"700":"400"}}>
                          <span>{n}{isRec?"★":""}</span>
                          <span>${Math.round(not/1000)}k</span>
                          <span>${Math.round(cost/1000)}k</span>
                          <span style={{color:funded.includes("HELOC")?"#8b6fd4":funded.includes("Exceeds")?"#cc3333":"#3aaa6a"}}>{funded}</span>
                          <span>${Math.round(ann/1000)}k</span>
                        </div>
                      );
                    })}
                  </div>
                </Pan>
              </div>
            </div>
          </div>
        )}

        {/* ═══ SHOCK ═══ */}
        {section === "shock" && (
          <div>
            <SH title="Shock Test" sub={`${P.ticker} @ $${SPY} · ${STOCKS.map(s=>s.ticker+` $${Number(s.price)||0}`).join(", ")} · Drag slider`} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Pan>
                <Lbl>SCENARIO CONTROLS</Lbl>
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:"#5a7a8a"}}>{P.ticker} Decline</span>
                    <span style={{fontSize:22,fontWeight:"700",color:shockPct>=20?"#cc3333":shockPct>=10?"#e87a00":"#c8a84b"}}>−{shockPct}%</span>
                  </div>
                  <input type="range" min={2} max={40} value={shockPct}
                    onChange={e=>setShockPct(Number(e.target.value))}
                    style={{width:"100%",accentColor:"#c8a84b"}}
                  />
                  <div style={{fontSize:10,color:"#2a5a6a",marginTop:4}}>
                    {P.ticker}: ${SPY} → ${spyShocked} · Primary stock: ${GS_PRICE} → ${gsShocked} (1.3× beta est.)
                  </div>
                </div>
                <button onClick={()=>setUseHeloc(!useHeloc)} style={{padding:"8px 14px",background:useHeloc?"#8b6fd4":"#0a1a28",color:useHeloc?"#fff":"#3a6a8a",border:`1px solid ${useHeloc?"#8b6fd4":"#1a3a50"}`,borderRadius:4,cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:"700",marginBottom:16}}>
                  HELOC {useHeloc?"✓ ON":"OFF"} — {fmt(HELOC)}
                </button>

                <Lbl>SHOCK P&L</Lbl>
                {[
                  {label:`${P.ticker} puts (${contracts}c)`,value:putPnl,neg:putPnl<0},
                  {label:`Stock equity — restricted (${TOTAL_REST} sh)`,value:gsRestPnl,neg:true},
                  {label:`Stock equity — unrestricted (${TOTAL_UNREST} sh)`,value:gsUnrestPnl,neg:true},
                  {label:"Combined P&L",value:totalPnl,neg:totalPnl<0,bold:true},
                ].map((r,i) => (
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #1a2a3a",fontWeight:r.bold?"700":"400"}}>
                    <span style={{fontSize:11,color:"#5a7a8a"}}>{r.label}</span>
                    <span style={{fontSize:r.bold?16:13,color:r.value>=0?"#3aaa6a":"#e87a7a"}}>{fmt(r.value)}</span>
                  </div>
                ))}
                <div style={{marginTop:10,padding:"10px",background:"#06101a",borderRadius:4}}>
                  <span style={{fontSize:11,color:"#5a7a8a"}}>Account after shock: </span>
                  <span style={{fontSize:14,fontWeight:"700",color:"#c8a84b"}}>{fmt(ACCOUNT+totalPnl)}</span>
                  <div style={{fontSize:10,color:"#2a5a6a",marginTop:2}}>Paper — no forced selling with HELOC in place</div>
                </div>
              </Pan>

              <Pan>
                <Lbl>ASSIGNMENT WATERFALL — {P.ticker} PUTS</Lbl>
                {assigned ? (() => {
                  const step1 = Math.min(RESERVED, assignCost);
                  const r1 = assignCost - step1;
                  const step2 = Math.min(FREE_CASH + Math.max(0, CASH - RESERVED - FREE_CASH), r1);
                  const r2 = r1 - step2;
                  const step3 = useHeloc ? Math.min(HELOC, r2) : 0;
                  const r3 = r2 - step3;
                  const ok = r3 <= 0;
                  return (
                    <div>
                      <div style={{fontSize:11,color:"#e87a00",marginBottom:12}}>{contracts} contracts assigned · {fmt(assignCost)} needed</div>
                      {[
                        {src:"Put collateral converts to shares",amt:step1,color:"#e87a00",note:"Reserved cash IS the payment — changes form"},
                        {src:"Free cash (SPAXX)",amt:step2,color:"#4a9fd4",note:fmt(FREE_CASH)+" available"},
                        ...(r2>0?[{src:useHeloc?"HELOC draw":"⚠ Shortfall (HELOC off)",amt:useHeloc?step3:r2,color:useHeloc?"#8b6fd4":"#cc3333",note:useHeloc?"Repay from covered call income in 60–90 days":"Toggle HELOC on"}]:[]),
                        {src:ok||(useHeloc&&r3<=0)?"✓ Fully funded — no stock sale":`⚠ Gap: ${fmt(r3)}`,amt:null,color:ok||(useHeloc&&r3<=0)?"#3aaa6a":"#cc3333",note:ok||(useHeloc&&r3<=0)?`Own ${contracts*100} ${P.ticker} @ ~$${strikeEst}. Sell covered calls.`:"Reduce contract count"},
                      ].map((r,i) => (
                        <div key={i} style={{padding:"9px 12px",borderRadius:4,marginBottom:6,background:"#06101a",borderLeft:`3px solid ${r.color}`}}>
                          <div style={{display:"flex",justifyContent:"space-between"}}>
                            <span style={{fontSize:11,color:r.color,fontWeight:"600"}}>{r.src}</span>
                            {r.amt!==null&&<span style={{fontSize:13,fontWeight:"700",color:r.color}}>{fmt(r.amt)}</span>}
                          </div>
                          <div style={{fontSize:10,color:"#2a5a6a",marginTop:2}}>{r.note}</div>
                        </div>
                      ))}
                    </div>
                  );
                })() : (
                  <div style={{padding:"20px",background:"#0a2a18",borderRadius:6,border:"1px solid #1a5a3a",textAlign:"center"}}>
                    <div style={{fontSize:14,color:"#3aaa6a",fontWeight:"700",marginBottom:6}}>✓ No Assignment</div>
                    <div style={{fontSize:12,color:"#4a8a6a"}}>{P.ticker} ${spyShocked} stays above ~${strikeEst} strike</div>
                    <div style={{fontSize:11,color:"#3a6a5a",marginTop:6}}>Full premium kept: {fmt(putPremColl)}</div>
                  </div>
                )}

                <div style={{marginTop:16,padding:"10px 12px",background:"#06101a",borderRadius:4,borderLeft:"3px solid #4a9fd4"}}>
                  <div style={{fontSize:9,color:"#4a9fd4",marginBottom:4,letterSpacing:"0.1em"}}>DOMINANT RISK AT THIS LEVEL</div>
                  <div style={{fontSize:11,color:"#5a7a8a",lineHeight:1.7}}>
                    Stock equity loss ({TOTAL_UNREST+TOTAL_REST} shares total): {fmt(gsRestPnl+gsUnrestPnl)} vs. put impact: {fmt(putPnl)}.
                    {Math.abs(gsRestPnl+gsUnrestPnl) > Math.abs(putPnl)
                      ? " Stock concentration is the larger hit at this decline level."
                      : " The puts are the primary concern at this decline level."}
                  </div>
                </div>
              </Pan>
            </div>
          </div>
        )}

        {/* ═══ LADDER ═══ */}
        {section === "ladder" && (
          <div>
            <SH title="3-Rung Staggered Ladder" sub="5 contracts per rung · 15 total · Strikes scale with your underlying price" />
            <div style={{display:"flex",gap:8,marginBottom:18}}>
              {RUNGS.map((r,i) => (
                <button key={i} onClick={()=>setLadderRung(i)} style={{flex:1,padding:"10px 8px",background:ladderRung===i?r.color:"#0a1a28",color:ladderRung===i?"#fff":r.color,border:`2px solid ${r.color}`,borderRadius:6,cursor:"pointer",fontFamily:"monospace",fontSize:10,fontWeight:"700"}}>
                  {r.label}
                </button>
              ))}
            </div>

            {(() => {
              const r = RUNGS[ladderRung];
              const strike = Math.round(SPY * (1 - r.otmPct / 100));
              const annPrem = r.premMid * 100 * 5 * r.cycles;
              return (
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:20}}>
                  {[
                    {label:"Delta Target",value:r.delta},
                    {label:"OTM %",value:`${r.otmPct}%`},
                    {label:`Strike ~ (${P.ticker} $${SPY})`,value:`$${strike}`},
                    {label:"$/Contract",value:ladderRung===0?`$${P.avgPremium.toFixed(2)}`:ladderRung===1?"$2.00–3.50":"$5.50–8.50"},
                    {label:"Annual Premium",value:fmt(annPrem)},
                  ].map((m,i) => (
                    <div key={i} style={{background:"#0a1a28",border:`1px solid ${r.color}25`,borderTop:`2px solid ${r.color}`,borderRadius:6,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#2a5a6a",marginBottom:5}}>{m.label}</div>
                      <div style={{fontSize:15,fontWeight:"700",color:r.color}}>{m.value}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <Pan style={{marginBottom:16}}>
              <Lbl>ALL THREE RUNGS — FULL COMPARISON</Lbl>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead>
                    <tr style={{color:"#2a5a6a"}}>
                      {["Rung","DTE","Delta","Strike ~","OTM %","Collateral","Cycles/yr","Ann. Prem"].map(h=>(
                        <th key={h} style={{padding:"8px 10px",textAlign:"left",borderBottom:"1px solid #1a2a3a",fontWeight:"400"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {RUNGS.map((r,i) => {
                      const strike = Math.round(SPY*(1-r.otmPct/100));
                      const ann = r.premMid*100*5*r.cycles;
                      return (
                        <tr key={i} style={{background:ladderRung===i?"#0d2030":"transparent",cursor:"pointer"}} onClick={()=>setLadderRung(i)}>
                          <td style={{padding:"10px",color:r.color,fontWeight:"700",borderBottom:"1px solid #1a2a3a"}}>Rung {i+1}</td>
                          <td style={{padding:"10px",borderBottom:"1px solid #1a2a3a"}}>{r.dte}</td>
                          <td style={{padding:"10px",color:r.color,fontWeight:"700",borderBottom:"1px solid #1a2a3a"}}>{r.delta}</td>
                          <td style={{padding:"10px",borderBottom:"1px solid #1a2a3a"}}>${strike}</td>
                          <td style={{padding:"10px",borderBottom:"1px solid #1a2a3a"}}>{r.otmPct}%</td>
                          <td style={{padding:"10px",borderBottom:"1px solid #1a2a3a"}}>{fmt(strike*500)}</td>
                          <td style={{padding:"10px",borderBottom:"1px solid #1a2a3a"}}>{r.cycles}</td>
                          <td style={{padding:"10px",color:r.color,fontWeight:"700",borderBottom:"1px solid #1a2a3a"}}>{fmt(ann)}</td>
                        </tr>
                      );
                    })}
                    <tr style={{background:"#0d2030"}}>
                      <td colSpan={6} style={{padding:"10px",color:"#c8a84b",fontWeight:"700"}}>TOTAL · 15 contracts</td>
                      <td style={{padding:"10px"}}></td>
                      <td style={{padding:"10px",color:"#c8a84b",fontWeight:"700"}}>{fmt(RUNGS.reduce((s,r)=>s+r.premMid*100*5*r.cycles,0))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Pan>

            <Pan color="#e87a00">
              <Lbl>SCENARIO RESPONSES</Lbl>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[
                  ["Normal market","R1 expires worthless. R2 decays. R3 collects theta. Re-enter R1 every 2–3 days."],
                  [`${P.ticker} −5%`,"R1 may assign. R2 delta rising but rollable. R3 untouched — acts as income buffer."],
                  [`${P.ticker} −10–15%`,"R1 assigns. Roll R2 down/out on elevated VIX for credit. R3 gives 3–4 weeks to decide."],
                  [`${P.ticker} −20%+`,"All rungs pressured. Roll R3 aggressively. Let R1/R2 assign. HELOC funds it."],
                ].map(([s,a],i) => (
                  <div key={i} style={{padding:"10px 12px",background:"#06101a",borderRadius:4,borderLeft:"2px solid #e87a00"}}>
                    <div style={{fontSize:10,color:"#e87a00",marginBottom:3}}>{s}</div>
                    <div style={{fontSize:11,color:"#5a7a8a",lineHeight:1.6}}>{a}</div>
                  </div>
                ))}
              </div>
            </Pan>
          </div>
        )}

        {/* ═══ VIX ═══ */}
        {section === "vix" && (
          <div>
            <SH title="VIX Regime Rules" sub="Five regimes · Contract sizing · Strike targets · Transition signals" />
            <div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:16}}>
              <div>
                <Pan style={{marginBottom:14}}>
                  <Lbl>LIVE VIX CALCULATOR</Lbl>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:"#5a7a8a"}}>Current VIX</span>
                    <span style={{fontSize:22,fontWeight:"700",color:liveRegime.color}}>{vixLive.toFixed(1)}</span>
                  </div>
                  <input type="range" min={10} max={45} step={0.5} value={vixLive}
                    onChange={e=>setVixLive(Number(e.target.value))}
                    style={{width:"100%",accentColor:liveRegime.color,marginBottom:10}}
                  />
                  <div style={{padding:"8px 10px",background:"#06101a",borderRadius:4,borderLeft:`3px solid ${liveRegime.color}`,marginBottom:12}}>
                    <div style={{fontSize:12,fontWeight:"700",color:liveRegime.color}}>{liveRegime.label} — {liveRegime.range}</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:12}}>
                    {[{l:"R1",v:liveRegime.contracts.r1,c:"#4a9fd4"},{l:"R2",v:liveRegime.contracts.r2,c:"#8b6fd4"},{l:"R3",v:liveRegime.contracts.r3,c:"#3aaa6a"}].map((c,i) => (
                      <div key={i} style={{background:"#06101a",borderRadius:4,padding:"8px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:"#2a5a6a",marginBottom:3}}>{c.l}</div>
                        <div style={{fontSize:22,fontWeight:"700",color:c.v===0?"#cc3333":c.c}}>{c.v===0?"OFF":c.v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{fontSize:10,color:"#2a5a6a",padding:"8px",background:"#06101a",borderRadius:4,lineHeight:1.6}}>
                    <span style={{color:"#c8a84b"}}>Signal:</span> VIX closes above 5-day SMA for 3 sessions → cut R1. Below for 3 sessions after spike → add R1 back.
                  </div>
                </Pan>

                <Pan>
                  <Lbl>TRANSITIONS</Lbl>
                  {[
                    {from:"< 15",to:"15–20",dir:"↑",action:"Add contracts gradually. R1 first, R2/R3 over 2 weeks."},
                    {from:"15–20",to:"20–27",dir:"↑",action:"Hold. Push R3 slightly further OTM."},
                    {from:"20–27",to:"27–35",dir:"↑",action:"Cut R1 to 3 immediately. Roll threatened positions."},
                    {from:"27–35",to:"> 35",dir:"↑",action:"Close R1. Covered call mode on assignments."},
                    {from:"> 35",to:"27–35",dir:"↓",action:"Re-enter R2 wide. R3 earns vega collapse profit."},
                    {from:"27–35",to:"15–20",dir:"↓",action:"Full ladder. R1 at 3 first, then 5 after 2 weeks."},
                  ].map((t,i) => (
                    <div key={i} style={{padding:"7px 10px",borderRadius:3,marginBottom:5,background:"#06101a",borderLeft:`3px solid ${t.dir==="↑"?"#cc3333":"#3aaa6a"}`}}>
                      <div style={{fontSize:9,color:t.dir==="↑"?"#cc3333":"#3aaa6a",marginBottom:2}}>{t.dir} {t.from} → {t.to}</div>
                      <div style={{fontSize:10,color:"#5a7a8a"}}>{t.action}</div>
                    </div>
                  ))}
                </Pan>
              </div>

              <div>
                <div style={{display:"flex",gap:5,marginBottom:12,flexWrap:"wrap"}}>
                  {VIX_REGIMES.map((r,i) => (
                    <button key={i} onClick={()=>setActiveRegime(i)} style={{flex:1,minWidth:80,padding:"7px 5px",background:activeRegime===i?r.color:"#0a1a28",color:activeRegime===i?"#000":r.color,border:`2px solid ${r.color}`,borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace",fontWeight:"700"}}>
                      {r.label}<br/><span style={{fontWeight:"400"}}>{r.range}</span>
                    </button>
                  ))}
                </div>

                {(() => {
                  const r = VIX_REGIMES[activeRegime];
                  return (
                    <Pan>
                      <div style={{borderLeft:`4px solid ${r.color}`,paddingLeft:12,marginBottom:14}}>
                        <div style={{fontSize:10,color:r.color,letterSpacing:"0.12em",marginBottom:4}}>{r.label.toUpperCase()} · VIX {r.range}</div>
                        <div style={{fontSize:12,color:"#8a9ab0",lineHeight:1.7}}>{r.action}</div>
                      </div>
                      <Lbl>STRIKE & PREMIUM TARGETS</Lbl>
                      {[
                        {rung:`Rung 1 · 1–5 DTE`,color:"#4a9fd4",data:r.strikes.r1},
                        {rung:`Rung 2 · 7–14 DTE`,color:"#8b6fd4",data:r.strikes.r2},
                        {rung:`Rung 3 · 21–30 DTE`,color:"#3aaa6a",data:r.strikes.r3},
                      ].map((s,i) => {
                        const otmStr = s.data.otm;
                        const strikeStr = otmStr === "N/A" ? "N/A" : (() => {
                          const m = otmStr.match(/([\d.]+)–([\d.]+)%/);
                          if (!m) return "—";
                          return `$${Math.round(SPY*(1-parseFloat(m[1])/100))}–$${Math.round(SPY*(1-parseFloat(m[2])/100))}`;
                        })();
                        return (
                          <div key={i} style={{display:"grid",gridTemplateColumns:"1.2fr 0.8fr 0.9fr 1fr 1fr",gap:8,padding:"10px 0",borderBottom:"1px solid #1a2a3a",alignItems:"center"}}>
                            <span style={{fontSize:11,color:s.color,fontWeight:"700"}}>{s.rung}</span>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#2a5a6a"}}>DELTA</div>
                              <div style={{fontSize:11,fontWeight:"700",color:s.data.delta==="OFF"?"#cc3333":s.color}}>{s.data.delta}</div>
                            </div>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#2a5a6a"}}>OTM %</div>
                              <div style={{fontSize:11,color:"#d0dde8"}}>{s.data.otm}</div>
                            </div>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:8,color:"#2a5a6a"}}>STRIKE ~</div>
                              <div style={{fontSize:11,color:"#d0dde8"}}>{strikeStr}</div>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:8,color:"#2a5a6a"}}>$/CONTRACT</div>
                              <div style={{fontSize:12,fontWeight:"700",color:s.color}}>{s.data.prem}</div>
                            </div>
                          </div>
                        );
                      })}
                      {r.trap && (
                        <div style={{marginTop:12,padding:"10px 12px",background:"#1a0a04",borderLeft:"3px solid #e87a00",borderRadius:4}}>
                          <div style={{fontSize:9,color:"#e87a00",marginBottom:3}}>⚠ TRAP</div>
                          <div style={{fontSize:11,color:"#b08060",lineHeight:1.7}}>{r.trap}</div>
                        </div>
                      )}
                    </Pan>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ═══ ROLL RULES ═══ */}
        {section === "roll" && (
          <div>
            <SH title="Roll Rules by Rung" sub="Trigger thresholds · When to act · What to do" />
            <div style={{display:"flex",gap:8,marginBottom:18}}>
              {ROLL_RULES.map((r,i) => (
                <button key={i} onClick={()=>setActiveRoll(i)} style={{flex:1,padding:"10px",background:activeRoll===i?r.color:"#0a1a28",color:activeRoll===i?"#fff":r.color,border:`2px solid ${r.color}`,borderRadius:6,cursor:"pointer",fontFamily:"monospace",fontSize:10,fontWeight:"700"}}>
                  {r.rung}
                  <div style={{fontSize:9,fontWeight:"400",marginTop:2,opacity:0.8}}>{r.canRoll?"Rollable":"Close & Re-enter"}</div>
                </button>
              ))}
            </div>
            {(() => {
              const r = ROLL_RULES[activeRoll];
              return (
                <div>
                  {r.noRollNote && (
                    <div style={{padding:"12px 16px",background:"#06101a",borderLeft:`3px solid ${r.color}`,borderRadius:4,marginBottom:14,fontSize:12,color:"#8a9ab0",lineHeight:1.7}}>{r.noRollNote}</div>
                  )}
                  <div style={{display:"grid",gap:10,marginBottom:16}}>
                    {r.triggers.map((t,i) => (
                      <div key={i} style={{padding:"13px 16px",background:"#06101a",borderLeft:`4px solid ${sev[t.severity]||"#c8a84b"}`,borderRadius:6}}>
                        <div style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:7}}>
                          <span style={{fontSize:8,padding:"2px 7px",borderRadius:3,flexShrink:0,marginTop:2,background:`${sev[t.severity]}15`,color:sev[t.severity],border:`1px solid ${sev[t.severity]}25`,letterSpacing:"0.1em"}}>{t.severity.toUpperCase()}</span>
                          <div style={{fontSize:12,color:sev[t.severity],fontWeight:"700"}}>{t.trigger}</div>
                        </div>
                        <div style={{fontSize:12,color:"#7a9ab0",lineHeight:1.7,paddingLeft:50}}>{t.action}</div>
                      </div>
                    ))}
                  </div>
                  <Pan color={r.color}>
                    <Lbl>INTRADAY OVERRIDE SIGNALS</Lbl>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                      {[
                        [`${P.ticker} down 1%+ in first 30 min`,"Check nearest put. If within $10 and 1–2 DTE, buy back immediately."],
                        ["VIX spikes 15%+ intraday","Act before VIX moves further — buyback cost rises with IV."],
                        [`${P.ticker} breaks below round number`,"Round number breaks often accelerate. Close puts at or above broken level."],
                        ["Macro surprise during hours","Close nearest-strike puts immediately. Re-enter 1–2% lower after dust settles."],
                      ].map(([sig,res],i) => (
                        <div key={i} style={{padding:"10px 12px",background:"#04090e",borderRadius:4}}>
                          <div style={{fontSize:10,color:"#c8a84b",marginBottom:4}}>{sig}</div>
                          <div style={{fontSize:11,color:"#5a7a8a",lineHeight:1.6}}>{res}</div>
                        </div>
                      ))}
                    </div>
                  </Pan>
                </div>
              );
            })()}
          </div>
        )}

        {/* ═══ ITM DECISIONS ═══ */}
        {section === "itm" && (
          <div>
            <SH title="ITM Roll Decision Framework" sub="What to do when a put goes in-the-money before expiration" />
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
              <div>
                <Pan style={{marginBottom:14}}>
                  <Lbl>CORE PRINCIPLES</Lbl>
                  {[
                    {t:"Can you roll for net credit ≥ $0.05?",b:"This is the only question that matters. If yes — roll. You improve your strike, extend your runway, collect cash. If no — take assignment."},
                    {t:"Never pay >$1.00 debit to roll",b:"A debit roll compounds if the underlying keeps dropping. Only justified debit: SPY at clear technical support + strong bounce conviction within 2 weeks."},
                    {t:"Assignment is not failure",b:`Your strategy is designed to accept assignment. You have the HELOC, the cash, and the covered call playbook. Taking ${P.ticker} shares at a discount and selling calls is a valid outcome — don't over-optimize.`},
                  ].map((p,i) => (
                    <div key={i} style={{padding:"11px 14px",background:"#06101a",borderRadius:6,marginBottom:8,borderLeft:"3px solid #c8a84b"}}>
                      <div style={{fontSize:11,color:"#c8a84b",fontWeight:"700",marginBottom:5}}>{p.t}</div>
                      <div style={{fontSize:11,color:"#5a7a8a",lineHeight:1.7}}>{p.b}</div>
                    </div>
                  ))}
                </Pan>

                <Pan>
                  <Lbl>ROLL CREDIT FORMULA</Lbl>
                  {[
                    {title:"Same expiry, lower strike",credit:"$0.10–1.00",when:"IV rising intraday",best:"R1 & R2 on a down day"},
                    {title:"Same strike, longer expiry",credit:"$0.50–3.00",when:"Need time, not strike",best:"R2 when recovery expected"},
                    {title:"Lower strike + longer expiry",credit:"$1.00–10.00+",when:"Best of both worlds",best:"R3 in any elevated VIX — primary tool"},
                  ].map((r,i) => (
                    <div key={i} style={{padding:"10px 12px",background:"#06101a",borderRadius:5,marginBottom:8,borderLeft:"2px solid #8b6fd4"}}>
                      <div style={{fontSize:11,color:"#b090f0",fontWeight:"700",marginBottom:6}}>{r.title}</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                        {[["Typical credit",r.credit],["When",r.when],["Best for",r.best]].map(([l,v]) => (
                          <div key={l}>
                            <div style={{fontSize:8,color:"#2a4a6a",marginBottom:1}}>{l}</div>
                            <div style={{fontSize:10,color:"#7a9ab0"}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </Pan>
              </div>

              <div>
                <Pan style={{marginBottom:14}}>
                  <Lbl>DECISION TREE — PUT GOES ITM</Lbl>
                  {ITM_TREE.map((d,i) => (
                    <div key={i} style={{display:"flex",gap:10,padding:"9px 0",borderBottom:i<ITM_TREE.length-1?"1px solid #1a2a3a":"none"}}>
                      <div style={{width:20,height:20,borderRadius:"50%",background:"#c8a84b",color:"#000",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:"700",flexShrink:0,marginTop:1}}>{d.step}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:11,color:"#d0dde8",fontWeight:"700",marginBottom:3}}>{d.q}</div>
                        {d.yes&&<div style={{fontSize:10,color:"#3aaa6a",marginBottom:1}}>→ YES: {d.yes}</div>}
                        {d.no&&<div style={{fontSize:10,color:"#e87a7a"}}>→ NO: {d.no}</div>}
                      </div>
                    </div>
                  ))}
                </Pan>

                <Pan style={{marginBottom:14}}>
                  <Lbl>BY SCENARIO — SELECT BELOW</Lbl>
                  <div style={{display:"flex",gap:5,marginBottom:12,flexWrap:"wrap"}}>
                    {[
                      {label:`${P.ticker} −2–3%`,color:"#c8a84b",delta:"0.55–0.65",action:`Roll down 2–3%, same expiry or +1 week, for a credit. Routine in normal vol — collect $0.50–2.00. Rung 3 has most flexibility.`,outcome:"New strike 2–3% lower, net credit in account. Continue theta decay at improved position."},
                      {label:`${P.ticker} −5–7%`,color:"#e87a00",delta:"0.70–0.80",action:`Roll R3 down 4–6%, out 3–4 weeks. Elevated VIX (which comes with this drop) funds a $3–8/contract credit. R2: +2 weeks, 3–4% lower. R1: buy back, re-enter next week 4–5% lower.`,outcome:`Exit deep ITM, re-establish with cushion. VIX premium pays for the improvement.`},
                      {label:`${P.ticker} −10–15%`,color:"#cc3333",delta:"0.85–0.95",action:`Push R3 strikes to clear support levels. May only collect $3–5 credit after buying back ITM positions, but reset with 30 DTE at much lower strikes. R1/R2: take assignment if <7 DTE. Begin covered call cycle.`,outcome:`Assignment on R1/R2. R3 rolled to low strikes. Covered call income starts immediately.`},
                      {label:`${P.ticker} −20%+`,color:"#8b0000",delta:"~1.0",action:`Stop rolling R1/R2 — take assignment, HELOC funds it. One aggressive R3 roll attempt for any credit. If unavailable: take R3 assignment at expiry. Do not pay large debits to extend.`,outcome:`Own 1,500 ${P.ticker} shares at discounted cost. VIX high = exceptional covered call income. Recover rapidly.`},
                    ].map((s,i) => (
                      <button key={i} onClick={()=>setItmScenario(i)} style={{flex:1,minWidth:90,padding:"6px 6px",background:itmScenario===i?s.color:"#0a1a28",color:itmScenario===i?"#fff":s.color,border:`1px solid ${s.color}`,borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:"monospace",fontWeight:"700"}}>{s.label}</button>
                    ))}
                  </div>
                  {(() => {
                    const scenarios = [
                      {label:`${P.ticker} −2–3%`,color:"#c8a84b",delta:"0.55–0.65",action:`Roll down 2–3%, same expiry or +1 week, for a credit. Routine in normal vol — collect $0.50–2.00. Rung 3 has most flexibility.`,outcome:"New strike 2–3% lower, net credit in account. Continue theta decay at improved position."},
                      {label:`${P.ticker} −5–7%`,color:"#e87a00",delta:"0.70–0.80",action:`Roll R3 down 4–6%, out 3–4 weeks. Elevated VIX funds $3–8/contract credit. R2: +2 weeks, 3–4% lower. R1: buy back, re-enter 4–5% lower.`,outcome:`Exit deep ITM, re-establish with cushion. VIX premium pays for the improvement.`},
                      {label:`${P.ticker} −10–15%`,color:"#cc3333",delta:"0.85–0.95",action:`Push R3 to clear support levels. R1/R2: take assignment if <7 DTE. Begin covered call cycle immediately.`,outcome:`Assignment on R1/R2. R3 rolled to low strikes. Covered call income starts.`},
                      {label:`${P.ticker} −20%+`,color:"#8b0000",delta:"~1.0",action:`Take assignment on R1/R2. HELOC funds it. One aggressive R3 roll attempt, then take assignment. Do not pay large debits.`,outcome:`Own 1,500 ${P.ticker} shares at discount. Exceptional covered call income during high VIX.`},
                    ];
                    const s = scenarios[itmScenario];
                    return (
                      <div>
                        <div style={{borderLeft:`4px solid ${s.color}`,paddingLeft:12,marginBottom:10}}>
                          <div style={{fontSize:10,color:s.color,marginBottom:3}}>Delta: {s.delta}</div>
                        </div>
                        <div style={{padding:"12px",background:"#06101a",borderRadius:4,marginBottom:8}}>
                          <div style={{fontSize:9,color:"#2a5a6a",marginBottom:5,letterSpacing:"0.1em"}}>RECOMMENDED ACTION</div>
                          <div style={{fontSize:12,color:"#d0dde8",lineHeight:1.8}}>{s.action}</div>
                        </div>
                        <div style={{padding:"10px 12px",background:"#0a2a18",borderRadius:4,borderLeft:`3px solid ${s.color}`}}>
                          <div style={{fontSize:9,color:"#3aaa6a",marginBottom:3,letterSpacing:"0.1em"}}>EXPECTED OUTCOME</div>
                          <div style={{fontSize:11,color:"#5a9a7a",lineHeight:1.7}}>{s.outcome}</div>
                        </div>
                      </div>
                    );
                  })()}
                </Pan>

                <Pan>
                  <Lbl>COVERED CALL RECOVERY AFTER ASSIGNMENT</Lbl>
                  {[
                    {week:"Week 1",action:`Sell covered calls on all assigned ${P.ticker} shares at 0.5–1% OTM. Collect at elevated VIX.`,income:"$4–8k"},
                    {week:"Wks 2–4",action:"Continue cycle. If called away above cost basis, book profit and redeploy.",income:"$4–8k/wk"},
                    {week:"Month 2",action:"HELOC balance down 40–60% from call income. Resume R3 puts on recovery.",income:"Ongoing"},
                    {week:"Month 3",action:"HELOC repaid. Resume full 3-rung ladder as VIX normalizes.",income:"Full capacity"},
                  ].map((r,i) => (
                    <div key={i} style={{display:"grid",gridTemplateColumns:"0.6fr 2fr 0.7fr",gap:8,padding:"7px 0",borderBottom:"1px solid #1a2a3a",alignItems:"start"}}>
                      <span style={{fontSize:10,color:"#c8a84b",fontWeight:"700"}}>{r.week}</span>
                      <span style={{fontSize:11,color:"#5a7a8a",lineHeight:1.5}}>{r.action}</span>
                      <span style={{fontSize:11,color:"#3aaa6a",textAlign:"right"}}>{r.income}</span>
                    </div>
                  ))}
                </Pan>
              </div>
            </div>
          </div>
        )}

      </div>

      <div style={{borderTop:"1px solid #1a2a3a",padding:"10px 24px",textAlign:"center",fontSize:9,color:"#1a3a4a",letterSpacing:"0.1em"}}>
        FOR EDUCATIONAL PURPOSES ONLY · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}

// ─── SHARED MINI COMPONENTS ───────────────────────────────────────
function Pan({ children, color, style }) {
  return <div style={{ background: "#0d1e2e", border: `1px solid ${color ? color + "25" : "#1a3a50"}`, borderRadius: 8, padding: "16px 18px", ...style }}>{children}</div>;
}
function Lbl({ children, style }) {
  return <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#2a5a6a", marginBottom: 10, textTransform: "uppercase", borderBottom: "1px solid #1a2a3a", paddingBottom: 7, ...style }}>{children}</div>;
}
function SC({ label, value, sub, color }) {
  return (
    <div style={{ background: "#0d1e2e", border: `1px solid ${color}20`, borderTop: `3px solid ${color}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontSize: 9, color: "#2a5a6a", letterSpacing: "0.15em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: "700", color, fontFamily: "monospace", marginBottom: 3 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#2a4a5a" }}>{sub}</div>
    </div>
  );
}
function SH({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: "700", color: "#f0f8ff", margin: "0 0 3px", letterSpacing: "-0.3px" }}>{title}</h2>
      <div style={{ fontSize: 11, color: "#2a5a6a" }}>{sub}</div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────
export default function App() {
  const [params, setParams] = useState(null);       // submitted params → show dashboard
  const [savedValues, setSavedValues] = useState(undefined); // undefined = loading, null = none, obj = found
  const [ready, setReady] = useState(false);

  // On mount: try to load saved personal params from private storage
  useEffect(() => {
    loadSavedParams().then(saved => {
      setSavedValues(saved || null);
      setReady(true);
    });
  }, []);

  const handleSubmit = (formParams) => {
    setSavedValues(formParams);
    setParams(formParams);
  };

  const handleReset = () => {
    // Update savedValues with the last submitted params so EntryPage re-initializes correctly
    if (params) setSavedValues(params);
    setParams(null);
  };

  const handleClearData = async () => {
    await clearSavedParams();
    setSavedValues(null);
    setParams(null);
  };

  if (!ready) {
    return (
      <div style={{ fontFamily: "monospace", background: "#050d14", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#3a6a8a" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, letterSpacing: "0.2em", marginBottom: 8 }}>LOADING</div>
          <div style={{ fontSize: 10, color: "#1a3a4a" }}>Checking for saved configuration…</div>
        </div>
      </div>
    );
  }

  if (!params) {
    return (
      <EntryPage
        onSubmit={handleSubmit}
        savedValues={savedValues}
        onClearData={handleClearData}
      />
    );
  }

  return <Dashboard params={params} onReset={handleReset} />;
}
