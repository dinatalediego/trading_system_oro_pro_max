"use client";

import { useEffect, useMemo, useState } from "react";

type Bar = { ts: string; close: number; rsi: number; wt1: number; wt2: number; squeeze: number; signal?: "BUY" | "SELL" | null };
type Snapshot = { mode: "live" | "demo"; symbol: string; price: number; changePct: number; modelProbability: number; action: "BUY" | "SELL" | "NO_TRADE"; riskState: string; modelVersion: string; bars: Bar[] };

const fallback = (): Snapshot => {
  const bars: Bar[] = Array.from({ length: 96 }, (_, i) => {
    const close = 4280 + i * 0.18 + Math.sin(i / 5) * 4 + Math.sin(i / 13) * 7;
    const wt1 = Math.sin(i / 6) * 38 + Math.sin(i / 17) * 15;
    const wt2 = Math.sin((i - 2) / 6) * 34 + Math.sin(i / 18) * 14;
    return { ts: new Date(Date.now() - (95 - i) * 60000).toISOString(), close, rsi: 50 + Math.sin(i / 9) * 24, wt1, wt2, squeeze: Math.cos(i / 7) * 18, signal: i === 77 ? "BUY" : i === 51 ? "SELL" : null };
  });
  return { mode: "demo", symbol: "XAU/USD", price: bars.at(-1)!.close, changePct: 0.31, modelProbability: 0.64, action: "NO_TRADE", riskState: "WAIT_FOR_EDGE", modelVersion: "baseline-demo", bars };
};

function linePath(values: number[], width: number, height: number, min?: number, max?: number) {
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values), span = Math.max(hi - lo, 1e-9);
  return values.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(values.length - 1, 1)) * width},${height - ((v - lo) / span) * height}`).join(" ");
}

export default function GoldTerminal() {
  const [data, setData] = useState<Snapshot>(fallback());
  useEffect(() => { fetch("/api/snapshot").then(r => r.ok ? r.json() : Promise.reject()).then(setData).catch(() => undefined); }, []);
  const prices = data.bars.map(b => b.close);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const pricePath = useMemo(() => linePath(prices, 1000, 260, minP, maxP), [prices, minP, maxP]);
  const wt1 = linePath(data.bars.map(b => b.wt1), 1000, 120, -80, 80);
  const wt2 = linePath(data.bars.map(b => b.wt2), 1000, 120, -80, 80);
  const rsi = linePath(data.bars.map(b => (b.rsi - 50) * 1.6), 1000, 120, -80, 80);
  const actionClass = data.action === "BUY" ? "positive" : data.action === "SELL" ? "negative" : "";

  return <main className="shell">
    <header className="topbar"><div className="brand"><div className="brandMark"/><div><h1>Gold Decision Lab</h1><p>Research → signal → risk gate → paper execution → learning</p></div></div><div className="status"><span className={`pill ${data.mode === "live" ? "live" : ""}`}>{data.mode.toUpperCase()}</span><span className="pill">{data.modelVersion}</span></div></header>
    <section className="gridKpi">
      <div className="card kpi"><label>XAU/USD</label><strong>{data.price.toFixed(2)}</strong><small className={data.changePct >= 0 ? "positive" : "negative"}>{data.changePct >= 0 ? "+" : ""}{data.changePct.toFixed(2)}%</small></div>
      <div className="card kpi"><label>Decision</label><strong className={actionClass}>{data.action}</strong><small>Abstention is a valid output</small></div>
      <div className="card kpi"><label>Model confidence</label><strong>{(data.modelProbability * 100).toFixed(1)}%</strong><small>Calibrated probability target</small></div>
      <div className="card kpi"><label>Risk state</label><strong style={{fontSize:17}}>{data.riskState}</strong><small>Risk gate can veto model</small></div>
      <div className="card kpi"><label>Execution</label><strong style={{fontSize:17}}>PAPER</strong><small>Live broker disabled by default</small></div>
    </section>
    <section className="layout">
      <div className="card chartCard">
        <div className="chartHeader"><div><div className="symbol">{data.symbol} · 1m</div><div className="price">{data.price.toFixed(2)}</div></div><div className="legend"><span><i className="dot" style={{background:"var(--lime)"}}/>BUY</span><span><i className="dot" style={{background:"var(--red)"}}/>SELL</span></div></div>
        <svg className="chartSvg" viewBox="0 0 1000 300" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8ff45" stopOpacity=".22"/><stop offset="100%" stopColor="#b8ff45" stopOpacity="0"/></linearGradient></defs><path d={`${pricePath} L1000,300 L0,300 Z`} fill="url(#fill)"/><path d={pricePath} fill="none" stroke="#b8ff45" strokeWidth="2" vectorEffect="non-scaling-stroke"/>{data.bars.map((b,i)=>b.signal?<g key={i}><circle cx={(i/95)*1000} cy={300-((b.close-minP)/Math.max(maxP-minP,1e-9))*260-20} r="7" fill={b.signal==="BUY"?"#b8ff45":"#ff5c66"}/><text x={(i/95)*1000} y={300-((b.close-minP)/Math.max(maxP-minP,1e-9))*260-34} textAnchor="middle" fill={b.signal==="BUY"?"#b8ff45":"#ff5c66"} fontSize="18" fontWeight="800">{b.signal}</text></g>:null)}</svg>
        <div style={{marginTop:14}} className="legend"><span><i className="dot" style={{background:"var(--blue)"}}/>WaveTrend fast</span><span><i className="dot" style={{background:"#cf625d"}}/>WaveTrend slow</span><span><i className="dot" style={{background:"#bb79ff"}}/>RSI transformed</span><span>Squeeze bars</span></div>
        <svg className="oscSvg" viewBox="0 0 1000 150" preserveAspectRatio="none"><line x1="0" y1="75" x2="1000" y2="75" stroke="#262b27"/>{data.bars.map((b,i)=>{const x=(i/96)*1000,w=1000/96-2,h=Math.min(Math.abs(b.squeeze)*2.2,60);return <rect key={i} x={x} y={b.squeeze>=0?75-h:75} width={w} height={h} fill={b.squeeze>=0?"#39d98a":"#ff5c66"} opacity=".58"/>})}<path d={wt1} transform="translate(0 15)" fill="none" stroke="#4fb2ff" strokeWidth="2" vectorEffect="non-scaling-stroke"/><path d={wt2} transform="translate(0 15)" fill="none" stroke="#cf625d" strokeWidth="2" vectorEffect="non-scaling-stroke"/><path d={rsi} transform="translate(0 15)" fill="none" stroke="#bb79ff" strokeWidth="1.5" opacity=".8" vectorEffect="non-scaling-stroke"/></svg>
      </div>
      <aside className="side">
        <div className="card signalTicket"><div style={{color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:'.1em'}}>Next action ticket</div><div className={`signalSide ${actionClass}`}>{data.action}</div><div className="signalMeta"><div className="metric"><span>Probability</span><b>{(data.modelProbability*100).toFixed(1)}%</b></div><div className="metric"><span>Risk gate</span><b>{data.riskState}</b></div></div><div className="warn">No signal means no trade. The product is optimized for risk-adjusted out-of-sample performance, not for forcing one profitable trade every day.</div></div>
        <div className="card"><b>Decision stack</b><div className="timeline" style={{marginTop:14}}><div className="row"><span>1. UT / trend candidate</span><b>gate</b></div><div className="row"><span>2. WaveTrend + RSI + Squeeze</span><b>features</b></div><div className="row"><span>3. ML meta-label</span><b>probability</b></div><div className="row"><span>4. Spread/news/regime</span><b>risk veto</b></div><div className="row"><span>5. Paper execution</span><b>outcome</b></div></div></div>
        <div className="card risk"><b style={{color:"var(--text)"}}>Promotion ladder</b><p>Backtest → walk-forward → paper → shadow → small-live → live. Each stage requires explicit evidence; model complexity cannot skip a stage.</p></div>
      </aside>
    </section>
  </main>;
}
