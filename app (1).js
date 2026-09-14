/* =====================================================================
   ARCLANE DISTRIBUTION — DASHBOARD ENGINE (Stage 7 implementation)
   Recomputes KPIs client-side from row-level Clean_* data so that Date /
   Warehouse / Carrier filters are REAL, not decorative. Every formula
   below matches its Stage 5 KPI card exactly — see comments per block.
   ===================================================================== */
function __ARCLANE_RUN_DASHBOARD__(){
(function(){
"use strict";

/* ---------------- DATA LOAD ----------------
   Live data comes from data-loader.js, which fetches the 9 Clean_* Google
   Sheets tabs, maps them into these exact shapes, and only then injects
   this script. window.__ARCLANE_LIVE_DATA__ is guaranteed present here. */
const LIVE = window.__ARCLANE_LIVE_DATA__;
const LEGEND   = LIVE.LEGEND;
const ORDERS   = LIVE.ORDERS;
const SHIPMENTS= LIVE.SHIPMENTS;
const FREIGHT  = LIVE.FREIGHT;
const INVENTORY= LIVE.INVENTORY;
const WH_OPS   = LIVE.WH_OPS;
const CUST_NAMES = LIVE.CUST_NAMES;
const META     = LIVE.META;

/* Field index maps (match extraction order exactly) */
const O = {ID:0, MONTH:1, STATUS:2, VALUE:3, UNITS:4, WH:5, CUST:6, PRIORITY:7};
const SH= {ID:0, ORDER_ID:1, MONTH:2, CARRIER:3, WH:4, STATUS:5, ACTUAL:6, EXPECTED:7, SHIP_DATE:8, UNITS:9, DAMAGE:10, DATE_SEQ_ERR:11, PRIORITY:12};
const FR= {SHIP_ID:0, CARRIER:1, TOTAL:2, UNRECON:3, DUP:4};
const IV= {SKU:0, NAME:1, CATEGORY:2, WH:3, CLOSING:4, REORDER:5, VALUE:6, UNRECON:7};

const ORDER_STATUSES = LEGEND.order_statuses;   // Open,Processing,Backordered,Shipped,Delivered,Cancelled
const SHIP_STATUSES  = LEGEND.ship_statuses;    // Delivered,In Transit,Delayed,Exception,Cancelled
const WAREHOUSES     = LEGEND.warehouses;
const CARRIERS       = LEGEND.carriers;
const PRIORITIES     = LEGEND.priorities;

const CANCELLED_ORDER = ORDER_STATUSES.indexOf('Cancelled');
const SHIPPED_ORDER   = ORDER_STATUSES.indexOf('Shipped');
const DELIVERED_ORDER = ORDER_STATUSES.indexOf('Delivered');
const DELIVERED_SHIP  = SHIP_STATUSES.indexOf('Delivered');
const DELAYED_SHIP    = SHIP_STATUSES.indexOf('Delayed');
const EXCEPTION_SHIP  = SHIP_STATUSES.indexOf('Exception');

/* Build a Shipment ID -> {month,wh,carrier,priority} lookup, needed to join Freight
   (which has no Warehouse/Month/Priority of its own) to the Date/Warehouse filters. */
const SHIP_BY_ID = new Map();
for (const s of SHIPMENTS) SHIP_BY_ID.set(s[SH.ID], s);

/* Static, NEVER-filtered exception figures (Tier 4 / S-07). Per Stage 6 architecture,
   the Data Quality panel is deliberately NOT filterable so exception counts always
   reflect the true full-population figures established in Stage 3/4 validation. */
const EXCEPTIONS = {
  k22_count: SHIPMENTS.filter(s=>s[SH.DATE_SEQ_ERR]===1).length,
  k23_count: FREIGHT.filter(f=>f[FR.UNRECON]===1).length,
  k24_count: new Set(FREIGHT.filter(f=>f[FR.DUP]===1).map(f=>f[FR.SHIP_ID])).size,
  k25_count: INVENTORY.filter(i=>i[IV.UNRECON]===1).length,
  k26_count: ORDERS.filter(o=>o[O.CUST]===null).length,
};
EXCEPTIONS.k22_rate = EXCEPTIONS.k22_count / SHIPMENTS.length;
EXCEPTIONS.k23_rate = EXCEPTIONS.k23_count / FREIGHT.length;
EXCEPTIONS.k25_rate = EXCEPTIONS.k25_count / INVENTORY.length;
EXCEPTIONS.k26_rate = EXCEPTIONS.k26_count / ORDERS.length;
/* K-27 (Unit-Cost-Backfilled Coverage) isn't independently derivable from the embedded
   inventory rows (that flag wasn't carried into the compact array — Stockout/Value are
   the fields needed for S-05; the backfill flag only matters for this one exception
   tile). Sourced from the Stage 5-validated static figure instead of recomputing. */
EXCEPTIONS.k27_count = 25;
EXCEPTIONS.k27_rate = 25/1190;

/* ---------------- STATE ---------------- */
const state = {
  dateStart: null, dateEnd: null,           // null,null = full year (no filter)
  datePreset: 'full',
  warehouses: new Set(WAREHOUSES.map((_,i)=>i)),
  carriers: new Set(CARRIERS.map((_,i)=>i)),
  priorityFilter: null,                      // null = all
  isolatedCarrier: null,                     // single-select-on-click override (index)
  isolatedWarehouse: null,
  customerSearch: '',
  diagShown: false,
  dqExpanded: false,
  sort: { carrier: {col:'on_time', dir:-1}, warehouse: {col:'productivity', dir:-1},
          category: {col:'value', dir:-1}, stockout: {col:'gap', dir:-1}, customer: {col:'value', dir:-1} },
};

function monthInRange(m){
  if (!state.dateStart) return true;
  return m >= state.dateStart && m <= state.dateEnd;
}
function anyFilterActive(){
  return !!state.dateStart || state.warehouses.size < WAREHOUSES.length ||
         state.carriers.size < CARRIERS.length || state.priorityFilter !== null ||
         state.isolatedCarrier !== null || state.isolatedWarehouse !== null;
}

/* ---------------- FILTERED VIEWS ---------------- */
function filteredOrders(){
  return ORDERS.filter(o=>{
    if (!monthInRange(o[O.MONTH])) return false;
    const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
    if (wh!==null && o[O.WH]!==wh) return false;
    if (wh===null && !state.warehouses.has(o[O.WH])) return false;
    return true;
  });
}
function filteredShipments(opts){
  opts = opts || {};
  return SHIPMENTS.filter(s=>{
    if (!monthInRange(s[SH.MONTH])) return false;
    const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
    if (wh!==null && s[SH.WH]!==wh) return false;
    if (wh===null && !state.warehouses.has(s[SH.WH])) return false;
    if (!opts.ignoreCarrier){
      const car = state.isolatedCarrier!==null ? state.isolatedCarrier : null;
      if (car!==null && s[SH.CARRIER]!==car) return false;
      if (car===null && !state.carriers.has(s[SH.CARRIER])) return false;
    }
    /* Priority is a LOCAL filter scoped to CH-03 only (Stage 6 Filter_Architecture) — it must
       NOT leak into computeAll()/S-01/S-04 or any other shipment-based metric. Opt-in only. */
    if (opts.includePriority && state.priorityFilter!==null && s[SH.PRIORITY]!==state.priorityFilter) return false;
    return true;
  });
}
function filteredFreight(shipIdSet){
  return FREIGHT.filter(f=>shipIdSet.has(f[FR.SHIP_ID]));
}
function filteredInventory(){
  const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
  return INVENTORY.filter(i=>{
    if (wh!==null) return i[IV.WH]===wh;
    return state.warehouses.has(i[IV.WH]);
  });
}

/* ---------------- KPI COMPUTATION (mirrors Stage 5 formulas exactly) ---------------- */
function computeAll(opts){
  opts = opts || {};
  const ords = filteredOrders();
  const ships = filteredShipments(opts);
  const shipIds = new Set(ships.map(s=>s[SH.ID]));
  const freight = filteredFreight(shipIds);

  const k01 = ords.length;
  const k02 = ords.filter(o=>o[O.STATUS]!==CANCELLED_ORDER).reduce((a,o)=>a+o[O.VALUE],0);
  const k03 = ords.length ? ords.filter(o=>o[O.STATUS]===SHIPPED_ORDER||o[O.STATUS]===DELIVERED_ORDER).length/ords.length : null;

  const validShip = ships.filter(s=>s[SH.DATE_SEQ_ERR]===0);
  const deliveredValid = validShip.filter(s=>s[SH.STATUS]===DELIVERED_SHIP);
  const k04 = deliveredValid.length ? deliveredValid.filter(s=>s[SH.ACTUAL]<=s[SH.EXPECTED]).length/deliveredValid.length : null;
  const transitDays = deliveredValid.map(s=>Math.round((new Date(s[SH.ACTUAL])-new Date(s[SH.SHIP_DATE]))/86400000));
  const k05 = transitDays.length ? transitDays.reduce((a,b)=>a+b,0)/transitDays.length : null;
  const k21 = median(transitDays);

  const k06 = freight.reduce((a,f)=>a+f[FR.TOTAL],0);
  const k07 = freight.length ? k06/freight.length : null;
  const k08 = ships.length;
  const k09 = ships.length ? ships.filter(s=>s[SH.STATUS]===DELAYED_SHIP||s[SH.STATUS]===EXCEPTION_SHIP).length/ships.length : null;

  const k18 = ORDERS_units(ords) ? ships.reduce((a,s)=>a+(s[SH.UNITS]||0),0)/ORDERS_units(ords) : null;
  const orderIdsWithShip = new Set(ships.map(s=>s[SH.ORDER_ID]));
  const k19 = ords.length ? ords.filter(o=>orderIdsWithShip.has(o[O.ID])).length/ords.length : null;
  const k20 = ships.length ? ships.filter(s=>s[SH.DAMAGE]===1).length/ships.length : null;
  const k20byStatus = SHIP_STATUSES.map((st,i)=>{
    const sub = ships.filter(s=>s[SH.STATUS]===i);
    return sub.length ? sub.filter(s=>s[SH.DAMAGE]===1).length/sub.length : 0;
  });

  return {ords, ships, freight, k01,k02,k03,k04,k05,k21,k06,k07,k08,k09,k18,k19,k20,k20byStatus};
}
function ORDERS_units(ords){ return ords.reduce((a,o)=>a+o[O.UNITS],0); }
function median(arr){
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

/* Monthly trend (K-02, K-04, K-09) — respects Warehouse/Carrier/Priority filters, ignores Date (it IS the x-axis) */
function monthlyTrend(){
  const ords = ORDERS.filter(o=>{
    const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
    if (wh!==null) return o[O.WH]===wh;
    return state.warehouses.has(o[O.WH]);
  });
  const ships = SHIPMENTS.filter(s=>{
    const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
    if (wh!==null && s[SH.WH]!==wh) return false;
    if (wh===null && !state.warehouses.has(s[SH.WH])) return false;
    const car = state.isolatedCarrier!==null ? state.isolatedCarrier : null;
    if (car!==null && s[SH.CARRIER]!==car) return false;
    if (car===null && !state.carriers.has(s[SH.CARRIER])) return false;
    return true;
  });
  const months = [...new Set([...ords.map(o=>o[O.MONTH]), ...ships.map(s=>s[SH.MONTH])])].sort();
  return months.map(m=>{
    const mOrds = ords.filter(o=>o[O.MONTH]===m && o[O.STATUS]!==CANCELLED_ORDER);
    const mShipsValid = ships.filter(s=>s[SH.MONTH]===m && s[SH.DATE_SEQ_ERR]===0 && s[SH.STATUS]===DELIVERED_SHIP);
    const mShipsAll = ships.filter(s=>s[SH.MONTH]===m);
    const orderValue = mOrds.reduce((a,o)=>a+o[O.VALUE],0);
    const onTime = mShipsValid.length ? mShipsValid.filter(s=>s[SH.ACTUAL]<=s[SH.EXPECTED]).length/mShipsValid.length : null;
    const delExc = mShipsAll.length ? mShipsAll.filter(s=>s[SH.STATUS]===DELAYED_SHIP||s[SH.STATUS]===EXCEPTION_SHIP).length/mShipsAll.length : 0;
    return {month:m, order_value:orderValue, on_time_rate:onTime, delayed_exception_rate:delExc};
  });
}
function statusMixMonthly(){
  const ships = filteredShipments({includePriority:true});  /* only CH-03 honors Priority */
  const months = [...new Set(ships.map(s=>s[SH.MONTH]))].sort();
  return months.map(m=>{
    const row = {month:m};
    SHIP_STATUSES.forEach((st,i)=>{ row[st]=ships.filter(s=>s[SH.MONTH]===m && s[SH.STATUS]===i).length; });
    return row;
  });
}

/* Carrier scorecard — recomputed from filtered shipments/freight (Date+Warehouse aware).
   IMPORTANT: uses ignoreCarrier:true — the scorecard/quadrant must compute every carrier's
   OWN genuine stats from the full (Date+Warehouse-filtered) shipment population, never
   restricted to just the isolated carrier's own shipments (that would zero out every other
   carrier's numbers, which is a data bug, not a display concern). Multi-select checkbox
   deselection REMOVES a carrier from the table (real filter). Single-click isolation only
   highlights/dims for comparison — it must NOT remove or null-out other rows. */
function carrierScorecard(){
  const ships = filteredShipments({ignoreCarrier:true});
  const shipIds = new Set(ships.map(s=>s[SH.ID]));
  const freight = filteredFreight(shipIds);
  const validShip = ships.filter(s=>s[SH.DATE_SEQ_ERR]===0 && s[SH.STATUS]===DELIVERED_SHIP);
  return CARRIERS.map((name,i)=>{
    const cShips = ships.filter(s=>s[SH.CARRIER]===i);
    const cValid = validShip.filter(s=>s[SH.CARRIER]===i);
    const cFreight = freight.filter(f=>f[FR.CARRIER]===i);
    return {
      carrier:name, idx:i,
      shipment_count:cShips.length,
      on_time_rate: cValid.length ? cValid.filter(s=>s[SH.ACTUAL]<=s[SH.EXPECTED]).length/cValid.length : null,
      avg_freight_cost: cFreight.length ? cFreight.reduce((a,f)=>a+f[FR.TOTAL],0)/cFreight.length : null,
    };
  }).filter(c=> state.carriers.has(c.idx));  /* multi-select only — isolation handled by dimming in the renderer */
}
function warehouseScorecard(){
  /* Full-year pre-aggregated (Clean_Warehouse_Ops has no per-shipment join available client-side
     at this grain) — Date Range does not re-slice these three metrics; Warehouse selection does. */
  return WH_OPS.map((row,i)=>({warehouse:row[0], orders_shipped:row[1], units_shipped:row[2], productivity:row[3], error_rate:row[4], idx:i}))
    .filter(w=> state.warehouses.has(w.idx));  /* multi-select only — isolation handled by dimming in the renderer */
}

/* ---------------- FORMATTERS ---------------- */
const fmtUSD = n => n==null ? '—' : '$'+Math.round(n).toLocaleString('en-US');
const fmtUSD2 = n => n==null ? '—' : '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct = n => n==null ? '—' : (n*100).toFixed(1)+'%';
const fmtNum = n => n==null ? '—' : Math.round(n).toLocaleString('en-US');
const fmtDays = n => n==null ? '—' : n.toFixed(1);
const monthLabel = m => { const [y,mo]=m.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mo-1]+" '"+y.slice(2); };

window.__ARCLANE__ = { LEGEND, ORDERS, SHIPMENTS, FREIGHT, INVENTORY, WH_OPS, CUST_NAMES, META,
  O, SH, FR, IV, state, computeAll, monthlyTrend, statusMixMonthly, carrierScorecard, warehouseScorecard,
  EXCEPTIONS, fmtUSD, fmtUSD2, fmtPct, fmtNum, fmtDays, monthLabel, anyFilterActive, median };
})();

/* =====================================================================
   RENDER ENGINE
   ===================================================================== */
(function(){
"use strict";
const A = window.__ARCLANE__;
const {state, LEGEND, META} = A;
const WAREHOUSES = A.LEGEND.warehouses, CARRIERS = A.LEGEND.carriers, PRIORITIES = A.LEGEND.priorities;
const {fmtUSD, fmtUSD2, fmtPct, fmtNum, fmtDays, monthLabel} = A;

const tooltip = document.getElementById('tooltip');
function showTip(x,y,html){
  tooltip.innerHTML = html;
  tooltip.style.left = Math.min(x+14, window.innerWidth-260)+'px';
  tooltip.style.top = Math.max(y-10,10)+'px';
  tooltip.classList.add('visible');
}
function hideTip(){ tooltip.classList.remove('visible'); }

/* ---------------- SVG HELPERS ---------------- */
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs){
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/* ================= CH-01: Business Pulse Trend (combo bar + line) =================
   Per Stage 6 Responsive spec: below 600px, dual-axis bar+line overlay becomes illegible —
   show ONE series at a time with a small toggle instead of forcing both onto a cramped axis. */
let trendMobileSeries = 'value'; // 'value' | 'ontime'
function renderTrendChart(){
  const el = document.getElementById('trendChart');
  const data = A.monthlyTrend();
  if (!data.length){ el.innerHTML = emptyState('No orders in the selected range.'); return; }
  const isMobile = window.innerWidth < 600;
  const W = el.clientWidth || 760, H = 300, padL=56, padR=isMobile?16:44, padT=isMobile?36:16, padB=32;
  const plotW = W-padL-padR, plotH = H-padT-padB;
  const maxVal = Math.max(...data.map(d=>d.order_value), 1);
  const barW = plotW/data.length*0.55;
  const svg = svgEl('svg',{viewBox:`0 0 ${W} ${H}`, style:'overflow:visible;'});
  const showBars = !isMobile || trendMobileSeries==='value';
  const showLine = !isMobile || trendMobileSeries==='ontime';

  // gridlines + y-axis (value) — only when bars are the active series
  if (showBars) for (let i=0;i<=4;i++){
    const y = padT + plotH - (i/4)*plotH;
    svg.appendChild(svgEl('line',{x1:padL,x2:W-padR,y1:y,y2:y,class:'grid-line'}));
    const t = svgEl('text',{x:padL-8,y:y+4,'text-anchor':'end',class:'axis-label'});
    t.textContent = '$'+Math.round(maxVal*i/4/1000)+'K'; svg.appendChild(t);
  }
  if (showBars) data.forEach((d,i)=>{
    const x = padL + (i+0.5)*(plotW/data.length) - barW/2;
    const h = (d.order_value/maxVal)*plotH;
    const y = padT+plotH-h;
    const bar = svgEl('rect',{x, y, width:barW, height:Math.max(h,1), rx:2, class:'bar', 'data-i':i});
    bar.addEventListener('mousemove', e=>showTip(e.clientX,e.clientY,
      `<div class="tt-title">${monthLabel(d.month)}</div>
       <div class="tt-row"><span>Order Value</span><b>${fmtUSD(d.order_value)}</b></div>
       <div class="tt-row"><span>On-Time Rate</span><b>${d.on_time_rate==null?'—':fmtPct(d.on_time_rate)}</b></div>`));
    bar.addEventListener('mouseleave', hideTip);
    bar.addEventListener('click', ()=>{ setDateRange(d.month, d.month); });
    svg.appendChild(bar);
    if (i%2===0 || data.length<=8){
      const t = svgEl('text',{x:x+barW/2,y:H-8,'text-anchor':'middle',class:'axis-label'});
      t.textContent = monthLabel(d.month); svg.appendChild(t);
    }
  });
  // on-time line (secondary axis 0-100%)
  const pathPts = [];
  if (showLine) data.forEach((d,i)=>{
    if (d.on_time_rate==null) return;
    const x = padL + (i+0.5)*(plotW/data.length);
    const y = padT + plotH - d.on_time_rate*plotH;
    pathPts.push([x,y]);
  });
  if (pathPts.length>1){
    const dstr = pathPts.map((p,i)=> (i===0?'M':'L')+p[0]+','+p[1]).join(' ');
    svg.appendChild(svgEl('path',{d:dstr, class:'line-path'}));
  }
  if (showLine) pathPts.forEach((p,i)=>{
    const dot = svgEl('circle',{cx:p[0],cy:p[1],r:4,class:'line-dot'});
    const d = data[i];
    dot.addEventListener('mousemove', e=>showTip(e.clientX,e.clientY,
      `<div class="tt-title">${monthLabel(d.month)}</div><div class="tt-row"><span>On-Time Rate</span><b>${fmtPct(d.on_time_rate)}</b></div>`));
    dot.addEventListener('mouseleave', hideTip);
    svg.appendChild(dot);
  });
  // right axis (percent) — only when line is the active series, or on desktop (both)
  if (showLine) for (let i=0;i<=4;i++){
    const y = padT + plotH - (i/4)*plotH;
    const t = svgEl('text',{x:W-padR+8,y:y+4,class:'axis-label'});
    t.textContent = (i*25)+'%'; svg.appendChild(t);
  }
  // mobile x-axis labels still needed when only the line is showing (bars loop skipped them)
  if (isMobile && !showBars) data.forEach((d,i)=>{
    if (i%2===0 || data.length<=8){
      const x = padL + (i+0.5)*(plotW/data.length);
      const t = svgEl('text',{x,y:H-8,'text-anchor':'middle',class:'axis-label'});
      t.textContent = monthLabel(d.month); svg.appendChild(t);
    }
  });
  el.innerHTML='';
  if (isMobile){
    const toggle = document.createElement('div');
    toggle.style.cssText='display:flex;gap:8px;margin-bottom:10px;';
    toggle.innerHTML = `<button class="priority-chip ${trendMobileSeries==='value'?'active':''}" data-s="value">Order Value</button>
                         <button class="priority-chip ${trendMobileSeries==='ontime'?'active':''}" data-s="ontime">On-Time Rate</button>`;
    toggle.querySelectorAll('button').forEach(b=>b.addEventListener('click', ()=>{ trendMobileSeries=b.dataset.s; renderTrendChart(); }));
    el.appendChild(toggle);
  }
  el.appendChild(svg);
}

function emptyState(msg, showReset){
  return `<div class="chart-empty"><span>${msg}</span>${showReset!==false && A.anyFilterActive() ? '<button onclick="window.__resetFilters()">Clear filters</button>':''}</div>`;
}

/* ================= Performance Insight Panel ================= */
function renderInsightPanel(){
  const el = document.getElementById('insightPanel');
  const trend = A.monthlyTrend();
  // For the order-value delta specifically, only compare months that actually HAVE order
  // bookings — the trend's month axis can include a trailing month with $0 in orders (real
  // shipments still in transit from December, but no NEW orders placed that month), and
  // treating that as "the last month" would produce a misleading ~-100% delta.
  const withOrders = trend.filter(d=>d.order_value>0);
  if (withOrders.length<2){ el.innerHTML = '<div class="insight-item"><div class="insight-label">Insufficient range</div><div class="insight-value">Need 2+ months with bookings to summarize</div></div>'; return; }
  const withOnTime = trend.filter(d=>d.on_time_rate!=null);
  if (!withOnTime.length){ el.innerHTML = '<div class="insight-item"><div class="insight-label">No delivered shipments in range</div></div>'; return; }
  const best = withOnTime.reduce((a,b)=> b.on_time_rate>a.on_time_rate?b:a, withOnTime[0]);
  const worst = withOnTime.reduce((a,b)=> b.on_time_rate<a.on_time_rate?b:a, withOnTime[0]);
  const first = withOrders[0], last = withOrders[withOrders.length-1];
  const valueDelta = first.order_value ? ((last.order_value-first.order_value)/first.order_value*100) : 0;
  el.innerHTML = `
    <div class="insight-item ${valueDelta>=0?'good':'warn'}">
      <div class="insight-label">ORDER VALUE, ${monthLabel(first.month)} → ${monthLabel(last.month)}</div>
      <div class="insight-value">${valueDelta>=0?'▲':'▼'} ${Math.abs(valueDelta).toFixed(1)}%</div>
    </div>
    <div class="insight-item good">
      <div class="insight-label">BEST ON-TIME MONTH</div>
      <div class="insight-value">${monthLabel(best.month)} — ${fmtPct(best.on_time_rate)}</div>
    </div>
    <div class="insight-item warn">
      <div class="insight-label">WEAKEST ON-TIME MONTH</div>
      <div class="insight-value">${monthLabel(worst.month)} — ${fmtPct(worst.on_time_rate)}</div>
    </div>
    <div class="insight-item">
      <div class="insight-label">TOTAL FREIGHT COST (RANGE)</div>
      <div class="insight-value">${fmtUSD(A.computeAll().k06)}</div>
    </div>`;
}

/* ================= CH-03: Shipment Status Mix (stacked bar) ================= */
const STATUS_COLORS = {'Delivered':'#34D399','In Transit':'#22D3EE','Delayed':'#F59E0B','Exception':'#F87171','Cancelled':'#64748B'};
function renderStatusChart(){
  const el = document.getElementById('statusChart');
  const data = A.statusMixMonthly();
  if (!data.length){ el.innerHTML = emptyState('No shipments in the selected range.'); return; }
  const W = el.clientWidth || 640, H = 300, padL=40, padR=12, padT=16, padB=32;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const totals = data.map(d=>A.LEGEND.ship_statuses.reduce((a,s)=>a+d[s],0));
  const maxTotal = Math.max(...totals,1);
  const barW = plotW/data.length*0.6;
  const svg = svgEl('svg',{viewBox:`0 0 ${W} ${H}`});
  for (let i=0;i<=4;i++){
    const y = padT+plotH-(i/4)*plotH;
    svg.appendChild(svgEl('line',{x1:padL,x2:W-padR,y1:y,y2:y,class:'grid-line'}));
    const t=svgEl('text',{x:padL-6,y:y+4,'text-anchor':'end',class:'axis-label'}); t.textContent=Math.round(maxTotal*i/4); svg.appendChild(t);
  }
  data.forEach((d,i)=>{
    const x = padL+(i+0.5)*(plotW/data.length)-barW/2;
    let yCursor = padT+plotH;
    A.LEGEND.ship_statuses.forEach(st=>{
      const v = d[st]; if(!v) return;
      const h = (v/maxTotal)*plotH;
      yCursor -= h;
      const rect = svgEl('rect',{x,y:yCursor,width:barW,height:h,fill:STATUS_COLORS[st],style:'cursor:pointer;'});
      rect.addEventListener('mousemove', e=>showTip(e.clientX,e.clientY,
        `<div class="tt-title">${monthLabel(d.month)} — ${st}</div><div class="tt-row"><span>Count</span><b>${v}</b></div><div class="tt-row"><span>% of month</span><b>${(v/totals[i]*100).toFixed(1)}%</b></div>`));
      rect.addEventListener('mouseleave', hideTip);
      svg.appendChild(rect);
    });
    if (i%2===0 || data.length<=8){
      const t=svgEl('text',{x:x+barW/2,y:H-8,'text-anchor':'middle',class:'axis-label'}); t.textContent=monthLabel(d.month); svg.appendChild(t);
    }
  });
  el.innerHTML=''; el.appendChild(svg);
  // legend
  const leg = document.createElement('div');
  leg.style.cssText='display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;';
  A.LEGEND.ship_statuses.forEach(st=>{
    leg.innerHTML += `<span style="font-size:11px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:2px;background:${STATUS_COLORS[st]};display:inline-block;"></span>${st}</span>`;
  });
  el.appendChild(leg);
}

/* ================= CH-06: Carrier Cost vs Reliability quadrant ================= */
/* ================= CH-06: Carrier Cost vs Reliability quadrant =================
   Per Stage 6 Responsive spec: a 14-bubble scatter is not usable below tablet width —
   it must convert entirely to the CH-07 ranked table rather than render illegibly small. */
function renderQuadrant(){
  const el = document.getElementById('quadrantChart');
  const rows = A.carrierScorecard().filter(c=>c.on_time_rate!=null && c.avg_freight_cost!=null);
  if (!rows.length){ el.innerHTML = emptyState('No carrier data in range.'); return; }
  if (window.innerWidth < 760){
    el.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:8px;">Scatter view needs more width — showing the ranked table instead (same data as below).</div><div id="quadrantFallbackTable"></div>';
    const sorted = [...rows].sort((a,b)=>b.on_time_rate-a.on_time_rate);
    buildTable('quadrantFallbackTable', [
      {key:'carrier', label:'Carrier'},
      {key:'on_time_rate', label:'On-Time', render:r=>fmtPct(r.on_time_rate)},
      {key:'avg_freight_cost', label:'Avg Freight', render:r=>fmtUSD2(r.avg_freight_cost)},
    ], sorted, 'carrier', r=>{ state.isolatedCarrier = state.isolatedCarrier===r.idx?null:r.idx; renderAll(); });
    return;
  }
  const W = el.clientWidth || 1180, H = 380, padL=64, padR=40, padT=20, padB=40;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const maxCost = Math.max(...rows.map(r=>r.avg_freight_cost))*1.1;
  const minCost = Math.min(...rows.map(r=>r.avg_freight_cost))*0.9;
  const maxVol = Math.max(...rows.map(r=>r.shipment_count));
  const svg = svgEl('svg',{viewBox:`0 0 ${W} ${H}`});
  // axes
  for (let i=0;i<=4;i++){
    const y = padT+plotH-(i/4)*plotH;
    svg.appendChild(svgEl('line',{x1:padL,x2:W-padR,y1:y,y2:y,class:'grid-line'}));
    const t=svgEl('text',{x:padL-8,y:y+4,'text-anchor':'end',class:'axis-label'}); t.textContent=(i*25)+'%'; svg.appendChild(t);
  }
  for (let i=0;i<=4;i++){
    const x = padL+(i/4)*plotW;
    const t=svgEl('text',{x,y:H-10,'text-anchor':'middle',class:'axis-label'}); t.textContent='$'+Math.round(minCost+(maxCost-minCost)*i/4); svg.appendChild(t);
  }
  svg.appendChild(svgEl('text',{x:padL,y:14,class:'axis-label',style:'font-weight:600;'})).textContent='On-Time Rate ↑ / Avg Freight Cost →';

  // Quadrant guide lines (median cost, median on-time) — per Stage 6 QuadrantScatter spec
  const medianCost = A.median(rows.map(r=>r.avg_freight_cost));
  const medianOnTime = A.median(rows.map(r=>r.on_time_rate));
  const gx = padL + ((medianCost-minCost)/(maxCost-minCost||1))*plotW;
  const gy = padT + plotH - medianOnTime*plotH;
  svg.appendChild(svgEl('line',{x1:gx,x2:gx,y1:padT,y2:padT+plotH,stroke:'rgba(148,163,184,0.35)','stroke-dasharray':'4,4'}));
  svg.appendChild(svgEl('line',{x1:padL,x2:W-padR,y1:gy,y2:gy,stroke:'rgba(148,163,184,0.35)','stroke-dasharray':'4,4'}));
  const qLabel = svgEl('text',{x:padL+8,y:padT+14,'text-anchor':'start',class:'axis-label',style:'fill:var(--teal);font-weight:600;'}); qLabel.textContent='↖ Fast & cheap'; svg.appendChild(qLabel);

  // Only label clear outliers (best/worst on-time, cheapest/priciest) — labeling all 14
  // bubbles collides illegibly in the dense mid-cluster; hover tooltip covers the rest.
  const byOnTime = [...rows].sort((a,b)=>b.on_time_rate-a.on_time_rate);
  const byCost = [...rows].sort((a,b)=>a.avg_freight_cost-b.avg_freight_cost);
  const labelSet = new Set([byOnTime[0].carrier, byOnTime[byOnTime.length-1].carrier, byCost[0].carrier, byCost[byCost.length-1].carrier]);

  rows.forEach(r=>{
    const x = padL + ((r.avg_freight_cost-minCost)/(maxCost-minCost||1))*plotW;
    const y = padT + plotH - r.on_time_rate*plotH;
    const rad = 6 + (r.shipment_count/maxVol)*22;
    const isIsolated = state.isolatedCarrier===r.idx;
    const dimmed = state.isolatedCarrier!==null && !isIsolated;
    const g = svgEl('g',{class:'bubble', opacity: dimmed?0.25:1});
    const circle = svgEl('circle',{cx:x,cy:y,r:rad,fill:'#22D3EE',stroke:isIsolated?'#fff':'none','stroke-width':2,'fill-opacity':0.55});
    g.appendChild(circle);
    if (labelSet.has(r.carrier)){
      const label = svgEl('text',{x, y:y-rad-6,'text-anchor':'middle',class:'bubble-label'});
      label.textContent = r.carrier.length>18 ? r.carrier.split(' ')[0] : r.carrier;
      g.appendChild(label);
    }
    g.addEventListener('mousemove', e=>showTip(e.clientX,e.clientY,
      `<div class="tt-title">${r.carrier}${A.LEGEND.carrier_active && A.LEGEND.carrier_active[r.idx]==='Inactive' ? ' <span style="color:var(--text-tertiary);font-weight:400;">(Inactive-marked, shown in full)</span>':''}</div>
       <div class="tt-row"><span>On-Time</span><b>${fmtPct(r.on_time_rate)}</b></div>
       <div class="tt-row"><span>Avg Freight</span><b>${fmtUSD2(r.avg_freight_cost)}</b></div>
       <div class="tt-row"><span>Shipments</span><b>${r.shipment_count}</b></div>
       <div class="tt-row" style="color:var(--text-tertiary);margin-top:4px;">Click to isolate this carrier</div>`));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', ()=>{ state.isolatedCarrier = isIsolated ? null : r.idx; renderAll(); });
    svg.appendChild(g);
  });
  el.innerHTML=''; el.appendChild(svg);
}

/* ================= Generic sortable table builder ================= */
function buildTable(containerId, columns, rows, sortKey, onRowClick, extraClass){
  const el = document.getElementById(containerId);
  const sortState = state.sort[sortKey];
  const sorted = [...rows].sort((a,b)=>{
    const va=a[sortState.col], vb=b[sortState.col];
    if (va==null) return 1; if (vb==null) return -1;
    if (typeof va==='string') return va.localeCompare(vb)*sortState.dir;
    return (va-vb)*sortState.dir;
  });
  let html = '<table><thead><tr>';
  columns.forEach(c=>{
    const active = c.key===sortState.col;
    html += `<th data-col="${c.key}" data-table="${sortKey}" class="${active?'sorted':''}">${c.label}<span class="sort-arrow">${active?(sortState.dir===1?'▲':'▼'):'⇅'}</span></th>`;
  });
  html += '</tr></thead><tbody>';
  sorted.forEach((r,i)=>{
    html += `<tr data-idx="${i}" data-row-key="${r.idx!==undefined?r.idx:i}">`;
    columns.forEach(c=>{ html += `<td>${c.render?c.render(r):r[c.key]}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
  el.querySelectorAll('thead th').forEach(th=>{
    th.addEventListener('click', ()=>{
      const col = th.dataset.col;
      if (sortState.col===col) sortState.dir*=-1; else { sortState.col=col; sortState.dir=-1; }
      buildTable(containerId, columns, rows, sortKey, onRowClick, extraClass);
    });
  });
  if (onRowClick){
    el.querySelectorAll('tbody tr').forEach(tr=>{
      tr.addEventListener('click', ()=> onRowClick(sorted[+tr.dataset.idx]));
    });
  }
}

/* ================= CH-07 Carrier table / CH-08 Warehouse table ================= */
function renderCarrierTable(){
  const rows = A.carrierScorecard();
  buildTable('carrierTable', [
    {key:'carrier', label:'Carrier', render:r=>{
      const active = A.LEGEND.carrier_active ? A.LEGEND.carrier_active[r.idx] : 'Active';
      return r.carrier + (active==='Inactive' ? ' <span class="badge badge-inactive">INACTIVE</span>' : '');
    }},
    {key:'on_time_rate', label:'On-Time', render:r=>fmtPct(r.on_time_rate)},
    {key:'avg_freight_cost', label:'Avg Freight', render:r=>fmtUSD2(r.avg_freight_cost)},
    {key:'shipment_count', label:'Shipments', render:r=>fmtNum(r.shipment_count)},
  ], rows, 'carrier', r=>{ state.isolatedCarrier = state.isolatedCarrier===r.idx?null:r.idx; renderAll(); });
  // mark isolated row using the reliable data-row-key attribute (not textContent,
  // which can include the INACTIVE badge markup and never match cleanly)
  if (state.isolatedCarrier!==null){
    document.querySelectorAll('#carrierTable tbody tr').forEach(tr=>{
      if (+tr.dataset.rowKey === state.isolatedCarrier) tr.classList.add('row-selected'); else tr.classList.add('row-dimmed');
    });
  }
}
function renderWarehouseTable(){
  const rows = A.warehouseScorecard();
  buildTable('warehouseTable', [
    {key:'warehouse', label:'Warehouse'},
    {key:'productivity', label:'Units/Labor Hr', render:r=>r.productivity?r.productivity.toFixed(1):'—'},
    {key:'error_rate', label:'Error Rate', render:r=>fmtPct(r.error_rate)},
    {key:'units_shipped', label:'Units Shipped', render:r=>fmtNum(r.units_shipped)},
  ], rows, 'warehouse', r=>{ state.isolatedWarehouse = state.isolatedWarehouse===r.idx?null:r.idx; renderAll(); });
  if (state.isolatedWarehouse!==null){
    document.querySelectorAll('#warehouseTable tbody tr').forEach(tr=>{
      if (+tr.dataset.rowKey === state.isolatedWarehouse) tr.classList.add('row-selected'); else tr.classList.add('row-dimmed');
    });
  }
}

/* ================= S-05 Inventory ================= */
function renderInventory(){
  const inv = A.filteredInventory ? A.filteredInventory() : null;
  const rows = A.INVENTORY.filter(i=> state.isolatedWarehouse!==null ? i[A.IV.WH]===state.isolatedWarehouse : state.warehouses.has(i[A.IV.WH]));
  // By warehouse bar
  const byWh = {};
  rows.forEach(r=>{ const w=WAREHOUSES[r[A.IV.WH]]; byWh[w]=(byWh[w]||0)+r[A.IV.VALUE]; });
  const whEntries = Object.entries(byWh).sort((a,b)=>b[1]-a[1]);
  const el = document.getElementById('invWarehouseChart');
  if (!whEntries.length){ el.innerHTML = emptyState('No inventory snapshot for this selection.'); }
  else {
    const max = Math.max(...whEntries.map(e=>e[1]));
    let html = '<div style="display:flex;flex-direction:column;gap:10px;">';
    whEntries.forEach(([w,v])=>{
      html += `<div class="mini-bar-row"><div class="mini-bar-label" style="width:80px;">${w.replace(' DC','')}</div>
        <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${(v/max*100).toFixed(1)}%;background:var(--cyan);"></div></div>
        <div class="mini-bar-val" style="width:70px;">${fmtUSD(v)}</div></div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  }
  // By category table
  const byCat = {};
  rows.forEach(r=>{ const c=r[A.IV.CATEGORY]; byCat[c]=(byCat[c]||0)+r[A.IV.VALUE]; });
  const catRows = Object.entries(byCat).map(([category,value])=>({category,value}));
  buildTable('invCategoryTable', [
    {key:'category', label:'Category'},
    {key:'value', label:'Value', render:r=>fmtUSD(r.value)},
  ], catRows, 'category');
  // Stockout list
  const atRisk = rows.filter(r=>r[A.IV.REORDER]!=null && r[A.IV.CLOSING]<=r[A.IV.REORDER])
    .map(r=>({sku:r[A.IV.SKU], product:r[A.IV.NAME], warehouse:WAREHOUSES[r[A.IV.WH]], closing:r[A.IV.CLOSING], reorder:r[A.IV.REORDER], gap:r[A.IV.REORDER]-r[A.IV.CLOSING]}));
  const withReorder = rows.filter(r=>r[A.IV.REORDER]!=null);
  document.getElementById('stockoutRate').textContent = withReorder.length ? fmtPct(atRisk.length/withReorder.length)+' at risk' : '—';
  if (!atRisk.length){
    document.getElementById('stockoutTable').innerHTML = '<div class="chart-empty" style="height:120px;">No SKUs at or below reorder level in this selection.</div>';
  } else {
    buildTable('stockoutTable', [
      {key:'product', label:'Product'},
      {key:'warehouse', label:'Warehouse'},
      {key:'gap', label:'Gap', render:r=>fmtNum(r.gap)+' units'},
    ], atRisk, 'stockout');
  }
}

/* ================= S-06 Customers ================= */
function renderCustomers(){
  const ords = A.filteredOrders ? A.filteredOrders() : A.ORDERS;
  const ordersFiltered = A.ORDERS.filter(o=>{
    const wh = state.isolatedWarehouse!==null ? state.isolatedWarehouse : null;
    if (wh!==null) return o[A.O.WH]===wh;
    return state.warehouses.has(o[A.O.WH]);
  });
  const linked = ordersFiltered.filter(o=>o[A.O.STATUS]!==5 && o[A.O.CUST]!=null);
  const unattributed = ordersFiltered.filter(o=>o[A.O.STATUS]!==5 && o[A.O.CUST]==null);
  const totals = {};
  linked.forEach(o=>{ totals[o[A.O.CUST]] = (totals[o[A.O.CUST]]||0)+o[A.O.VALUE]; });
  let rows = Object.entries(totals).map(([id,value])=>({customer_id:id, customer_name:A.CUST_NAMES[id]||id, value}));
  const search = state.customerSearch.toLowerCase();
  if (search) rows = rows.filter(r=>r.customer_name.toLowerCase().includes(search) || r.customer_id.toLowerCase().includes(search));
  rows.sort((a,b)=>b.value-a.value);
  rows = rows.slice(0,10);
  const unattrVal = unattributed.reduce((a,o)=>a+o[A.O.VALUE],0);
  let html = '<table><thead><tr><th>Customer</th><th>Customer ID</th><th>Order Value</th></tr></thead><tbody>';
  rows.forEach(r=>{ html += `<tr><td>${r.customer_name}</td><td>${r.customer_id}</td><td>${fmtUSD(r.value)}</td></tr>`; });
  if (!search) html += `<tr class="unattributed-row"><td>Unattributed (no Customer ID on file)</td><td>—</td><td>${fmtUSD(unattrVal)}</td></tr>`;
  html += '</tbody></table>';
  if (!rows.length && search) html = `<div class="chart-empty" style="height:100px;">No customers match "${state.customerSearch}".</div>`;
  document.getElementById('customerTable').innerHTML = html;
}

/* ================= S-07 Exceptions ================= */
function renderExceptions(){
  const E = A.EXCEPTIONS;
  document.getElementById('dqSummaryText').innerHTML = `<b>6</b> known data-quality items on file (portfolio-wide, all time) — <b>${E.k22_count+E.k26_count}</b> shipments/orders and <b>${E.k23_count+E.k25_count}</b> freight/inventory rows flagged for transparency, not hidden.`;
  document.getElementById('dqTiles').innerHTML = `
    <div class="dq-tile"><div class="dq-tile-name">Invalid Delivery Chronology <span class="severity-tag">DATA</span></div><div class="dq-tile-value">${E.k22_count}</div><div class="dq-tile-sub">${fmtPct(E.k22_rate)} of all shipments — Actual Delivery before Ship Date</div></div>
    <div class="dq-tile"><div class="dq-tile-name">Freight Reconciliation <span class="severity-tag">DATA</span></div><div class="dq-tile-value">${E.k23_count}</div><div class="dq-tile-sub">${fmtPct(E.k23_rate)} of freight records don't reconcile to components</div></div>
    <div class="dq-tile"><div class="dq-tile-name">Freight Duplicates <span class="severity-tag">DATA</span></div><div class="dq-tile-value">${E.k24_count}</div><div class="dq-tile-sub">shipments with 2 conflicting freight amounts on file</div></div>
    <div class="dq-tile"><div class="dq-tile-name">Inventory Reconciliation <span class="severity-tag">DATA</span></div><div class="dq-tile-value">${E.k25_count}</div><div class="dq-tile-sub">${fmtPct(E.k25_rate)} of inventory snapshot rows don't reconcile to movement</div></div>
    <div class="dq-tile"><div class="dq-tile-name">Unattributed Orders <span class="severity-tag">DATA</span></div><div class="dq-tile-value">${E.k26_count}</div><div class="dq-tile-sub">${fmtPct(E.k26_rate)} of orders have no Customer ID on file</div></div>
    <div class="dq-tile"><div class="dq-tile-name">Unit-Cost Backfilled <span class="severity-tag">ASSUMPTION</span></div><div class="dq-tile-value">${E.k27_count}</div><div class="dq-tile-sub">${fmtPct(E.k27_rate)} of inventory rows use a backfilled cost (F-045)</div></div>`;
}

/* ================= S-03 metrics column ================= */
function renderS03(){
  const c = A.computeAll();
  document.getElementById('transitAvg').textContent = fmtDays(c.k05);
  document.getElementById('transitMedian').textContent = fmtDays(c.k21);
  document.getElementById('crossFulfillment').textContent = fmtPct(c.k03);
  document.getElementById('crossLinked').textContent = fmtPct(c.k19);
  document.getElementById('diagValue').textContent = 'K-18 Unit Throughput Ratio (portfolio diagnostic only): '+ (c.k18!=null? c.k18.toFixed(3):'—');
  const bars = document.getElementById('damageBars');
  const colors = {'Delivered':'#34D399','In Transit':'#22D3EE','Delayed':'#F59E0B','Exception':'#F87171','Cancelled':'#64748B'};
  bars.innerHTML = A.LEGEND.ship_statuses.map((st,i)=>{
    const v = c.k20byStatus[i]||0;
    return `<div class="mini-bar-row"><div class="mini-bar-label">${st}</div><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.min(v*400,100)}%;background:${colors[st]};"></div></div><div class="mini-bar-val">${(v*100).toFixed(1)}%</div></div>`;
  }).join('');
}

/* ================= S-01 Executive Pulse =================
   Per Stage 6 Filter_Architecture, the Carrier filter affects S-02/S-03/S-04 only — NOT S-01.
   (Warehouse and Date DO apply to S-01.) computeAll({ignoreCarrier:true}) enforces that scope. */
function renderS01(){
  const c = A.computeAll({ignoreCarrier:true});
  document.getElementById('heroNumber').textContent = fmtUSD(c.k02);
  document.getElementById('kpiOrders').textContent = fmtNum(c.k01);
  document.getElementById('kpiFulfillment').textContent = fmtPct(c.k03);
  document.getElementById('kpiOnTime').textContent = fmtPct(c.k04);
  document.getElementById('statTransit').textContent = c.k05!=null ? fmtDays(c.k05)+'d' : '—';
  document.getElementById('statFreight').textContent = fmtUSD(c.k06);
}

/* ================= Master render ================= */
function renderAll(){
  renderS01();
  renderTrendChart();
  renderInsightPanel();
  renderStatusChart();
  renderS03();
  renderQuadrant();
  renderCarrierTable();
  renderWarehouseTable();
  renderInventory();
  renderCustomers();
  renderExceptions();
  updateFilterChips();
}

/* ================= Filter UI wiring ================= */
function setDateRange(start,end){ state.dateStart=start; state.dateEnd=end; renderAll(); updateDateLabel(); }
function updateDateLabel(){
  const label = document.getElementById('dateChipLabel');
  const chip = document.getElementById('dateChipBtn');
  if (!state.dateStart){ label.textContent='Full Year 2025'; chip.classList.remove('active'); }
  else { label.textContent = state.dateStart===state.dateEnd ? monthLabel(state.dateStart) : monthLabel(state.dateStart)+'–'+monthLabel(state.dateEnd); chip.classList.add('active'); }
}
function updateFilterChips(){
  const whCount = document.getElementById('warehouseCount');
  const carCount = document.getElementById('carrierCount');
  const whBtn = document.getElementById('warehouseChipBtn');
  const carBtn = document.getElementById('carrierChipBtn');
  if (state.warehouses.size<WAREHOUSES.length || state.isolatedWarehouse!==null){
    whCount.style.display='inline'; whCount.textContent = state.isolatedWarehouse!==null?1:state.warehouses.size; whBtn.classList.add('active');
  } else { whCount.style.display='none'; whBtn.classList.remove('active'); }
  if (state.carriers.size<CARRIERS.length || state.isolatedCarrier!==null){
    carCount.style.display='inline'; carCount.textContent = state.isolatedCarrier!==null?1:state.carriers.size; carBtn.classList.add('active');
  } else { carCount.style.display='none'; carBtn.classList.remove('active'); }
  document.getElementById('resetBtn').classList.toggle('visible', A.anyFilterActive());
}

function buildCheckDropdown(panelId, items, selectedSet, onChange){
  const panel = document.getElementById(panelId);
  panel.innerHTML = items.map((name,i)=>
    `<label class="dropdown-option"><input type="checkbox" data-i="${i}" ${selectedSet.has(i)?'checked':''}> ${name}</label>`
  ).join('') + `<div class="dropdown-footer"><button data-act="all">Select all</button><button data-act="none">Clear</button></div>`;
  panel.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const i = +cb.dataset.i;
      if (cb.checked) selectedSet.add(i); else selectedSet.delete(i);
      onChange();
    });
  });
  panel.querySelector('[data-act=all]').addEventListener('click', ()=>{ items.forEach((_,i)=>selectedSet.add(i)); buildCheckDropdown(panelId, items, selectedSet, onChange); onChange(); });
  panel.querySelector('[data-act=none]').addEventListener('click', ()=>{ selectedSet.clear(); buildCheckDropdown(panelId, items, selectedSet, onChange); onChange(); });
}

function initDropdowns(){
  // Date presets
  const datePanel = document.getElementById('datePanel');
  const months = [...new Set(A.ORDERS.map(o=>o[A.O.MONTH]))].sort();
  const presets = [
    {label:'Full Year 2025', fn:()=>setDateRange(null,null)},
    {label:'Q4 2025 (Oct–Dec)', fn:()=>setDateRange('2025-10','2025-12')},
    {label:'Q3 2025 (Jul–Sep)', fn:()=>setDateRange('2025-07','2025-09')},
    {label:'Last Month on File', fn:()=>setDateRange(months[months.length-1],months[months.length-1])},
  ];
  datePanel.innerHTML = presets.map((p,i)=>`<div class="dropdown-option" data-i="${i}">${p.label}</div>`).join('');
  datePanel.querySelectorAll('.dropdown-option').forEach((opt,i)=>{
    opt.addEventListener('click', ()=>{ presets[i].fn(); closeAllDropdowns(); });
  });

  buildCheckDropdown('warehousePanel', WAREHOUSES, state.warehouses, ()=>{ state.isolatedWarehouse=null; renderAll(); });
  buildCheckDropdown('carrierPanel', CARRIERS, state.carriers, ()=>{ state.isolatedCarrier=null; renderAll(); });

  const toggles = [['dateChipBtn','datePanel'],['warehouseChipBtn','warehousePanel'],['carrierChipBtn','carrierPanel']];
  toggles.forEach(([btnId,panelId])=>{
    document.getElementById(btnId).addEventListener('click', (e)=>{
      e.stopPropagation();
      const isOpen = document.getElementById(panelId).classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) document.getElementById(panelId).classList.add('open');
    });
  });
  document.addEventListener('click', closeAllDropdowns);
}
function closeAllDropdowns(){ document.querySelectorAll('.dropdown-panel').forEach(p=>p.classList.remove('open')); }

function initPriorityFilter(){
  const el = document.getElementById('priorityFilter');
  const items = ['All Priorities', ...PRIORITIES];
  el.innerHTML = items.map((name,i)=>`<button class="priority-chip ${i===0?'active':''}" data-i="${i-1}">${name}</button>`).join('');
  el.querySelectorAll('.priority-chip').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = +btn.dataset.i;
      state.priorityFilter = val===-1 ? null : val;
      el.querySelectorAll('.priority-chip').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderStatusChart();
    });
  });
}

function initInteractions(){
  document.getElementById('resetBtn').addEventListener('click', window.__resetFilters = function(){
    state.dateStart=null; state.dateEnd=null;
    state.warehouses = new Set(WAREHOUSES.map((_,i)=>i));
    state.carriers = new Set(CARRIERS.map((_,i)=>i));
    state.priorityFilter=null; state.isolatedCarrier=null; state.isolatedWarehouse=null; state.customerSearch='';
    document.getElementById('customerSearch').value='';
    document.querySelectorAll('.priority-chip').forEach((b,i)=>b.classList.toggle('active', i===0));
    buildCheckDropdown('warehousePanel', WAREHOUSES, state.warehouses, ()=>{ state.isolatedWarehouse=null; renderAll(); });
    buildCheckDropdown('carrierPanel', CARRIERS, state.carriers, ()=>{ state.isolatedCarrier=null; renderAll(); });
    updateDateLabel();
    renderAll();
  });

  document.getElementById('diagToggle').addEventListener('click', ()=>{
    state.diagShown = !state.diagShown;
    document.getElementById('diagValue').classList.toggle('shown', state.diagShown);
    document.getElementById('diagToggle').textContent = state.diagShown ? 'Hide diagnostic ratio (K-18)' : 'Show diagnostic ratio (K-18)';
  });

  const dqSummary = document.getElementById('dqSummary');
  function toggleDQ(){
    state.dqExpanded = !state.dqExpanded;
    document.getElementById('dqTiles').classList.toggle('expanded', state.dqExpanded);
    document.getElementById('dqExpandBtn').textContent = state.dqExpanded ? 'Collapse' : 'Expand';
    dqSummary.setAttribute('aria-expanded', state.dqExpanded);
  }
  dqSummary.addEventListener('click', toggleDQ);
  dqSummary.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleDQ(); }});

  document.getElementById('customerSearch').addEventListener('input', e=>{
    state.customerSearch = e.target.value; renderCustomers();
  });

  document.getElementById('refreshBtn').addEventListener('click', function(){
    // Re-running the whole page load re-triggers data-loader.js, which
    // always fetches with cache:'no-store' + a cache-busting timestamp,
    // so this always pulls the current Google Sheets values — never a
    // stale in-memory copy of ORDERS/SHIPMENTS/etc.
    const btn = this;
    btn.classList.add('spinning');
    document.getElementById('refreshLabel').textContent='Refreshing…';
    window.location.reload();
  });

  document.getElementById('mobileFiltersBtn').addEventListener('click', ()=>{
    // Build fresh copies of the three filter controls inside the mobile sheet
    document.getElementById('mobileDatePanel').innerHTML = document.getElementById('datePanel').innerHTML;
    document.getElementById('mobileDatePanel').querySelectorAll('.dropdown-option').forEach((opt,i)=>{
      opt.addEventListener('click', ()=>{ document.getElementById('datePanel').children[i].click(); updateDateLabel(); });
    });
    buildCheckDropdown('mobileWarehousePanel', WAREHOUSES, state.warehouses, ()=>{ state.isolatedWarehouse=null; renderAll(); });
    buildCheckDropdown('mobileCarrierPanel', CARRIERS, state.carriers, ()=>{ state.isolatedCarrier=null; renderAll(); });
    document.getElementById('mobileSheet').classList.add('open');
  });
  document.getElementById('mobileSheetClose').addEventListener('click', ()=>{
    document.getElementById('mobileSheet').classList.remove('open');
  });
  document.getElementById('mobileSheet').addEventListener('click', (e)=>{
    if (e.target.id==='mobileSheet') document.getElementById('mobileSheet').classList.remove('open');
  });
  document.getElementById('mobileResetBtn').addEventListener('click', ()=>{
    window.__resetFilters();
    document.getElementById('mobileSheet').classList.remove('open');
  });

  window.addEventListener('resize', debounce(renderAll, 200));
}
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

/* ================= INIT =================
   Runs immediately, not on DOMContentLoaded: data-loader.js only injects
   this script AFTER the live fetch resolves and the DOM is already fully
   parsed and ready by then. */
(function initArcLane(){
  document.getElementById('lastUpdated').textContent = 'Updated as of ' + new Date(META.last_updated).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  initDropdowns();
  initPriorityFilter();
  initInteractions();
  updateDateLabel();
  renderAll();
})();
})();

}


/* ---- Google Sheets live data loader ---- */
/* =====================================================================
   ARCLANE DISTRIBUTION — LIVE GOOGLE SHEETS DATA LOADER
   =====================================================================
   Fetches the 9 Clean_* tabs from the Google Sheet via the gviz JSON
   endpoint, validates them, and maps them into EXACTLY the same
   in-memory shapes dashboard.js has always consumed (LEGEND, ORDERS,
   SHIPMENTS, FREIGHT, INVENTORY, WH_OPS, CUST_NAMES, META). This file
   never touches KPI math, filters, charts, or layout — dashboard.js is
   unmodified except for where it now gets its data from.

   ONLY these 9 tabs are ever requested. Raw_* and Superseded_Product_
   Records are never referenced anywhere in this file.

   IMPORTANT — HEADER ASSUMPTIONS:
   This loader matches Google Sheet columns by HEADER NAME (case/space
   insensitive, with alias lists), not by position, so column reordering
   in the sheet won't break it. However, the exact header text for 8 of
   the 9 tabs could not be inspected while writing this file (only
   Clean_Warehouses' headers were visible: Warehouse ID, Warehouse Name,
   City, State, Region, Capacity, Manager, Active Status). The alias
   lists below are best-guess based on the field semantics the static
   dashboard already relies on. If a required column can't be found,
   this loader throws a clear, named error (sheet + field) rather than
   silently guessing wrong — check the browser console and widen the
   relevant alias array below if that happens.
   ===================================================================== */
(function () {
  "use strict";

  var SHEET_ID = "1YxuMvsxjuWBksy4yyZgeI_PpA1t_RQUhZJ1BAhNtZP0";

  var TABS = [
    "Clean_Orders", "Clean_Shipments", "Clean_Freight", "Clean_Customers",
    "Clean_Products", "Clean_Warehouses", "Clean_Carriers", "Clean_Inventory",
    "Clean_Warehouse_Ops"
  ];

  var EXPECTED_ROWS = {
    Clean_Orders: 5200, Clean_Shipments: 4654, Clean_Freight: 4632,
    Clean_Customers: 575, Clean_Products: 220, Clean_Warehouses: 6,
    Clean_Carriers: 14, Clean_Inventory: 1190, Clean_Warehouse_Ops: 1912
  };

  // Fixed workflow enumerations. These define the meaning of every KPI
  // formula in dashboard.js (e.g. CANCELLED_ORDER, DELIVERED_SHIP) and
  // are not alphabetical, so they can't be derived from the sheet — they
  // come from the dashboard's original Stage-5 KPI spec.
  var ORDER_STATUSES = ["Open", "Processing", "Backordered", "Shipped", "Delivered", "Cancelled"];
  var SHIP_STATUSES  = ["Delivered", "In Transit", "Delayed", "Exception", "Cancelled"];
  var PRIORITIES     = ["Standard", "High", "Rush"];

  var DIAG = { rowCountWarnings: [], fieldWarnings: [], columnMap: {} };
  window.__ARCLANE_DIAGNOSTICS__ = DIAG;

  /* ---------------- gviz fetch ---------------- */
  function gvizUrl(sheetName) {
    // cache:"no-store" defeats the browser HTTP cache; the timestamp query
    // param also defeats any proxy/CDN cache keyed purely on URL — same
    // fix used on the Northstar dashboard.
    // headers=1 forces gviz to treat row 1 as the header row explicitly,
    // instead of relying on its own (sometimes wrong) type-based guess —
    // this was the root cause of the earlier "Missing required column"
    // failure: without it, gviz can mis-detect the header row on a sheet
    // with mixed-looking first-row data and return blank/generic column
    // labels, so every named-alias lookup below fails.
    return "https://docs.google.com/spreadsheets/d/" + SHEET_ID +
      "/gviz/tq?tqx=out:json&headers=1&sheet=" + encodeURIComponent(sheetName) +
      "&_ts=" + Date.now();
  }

  function fetchTab(sheetName) {
    return fetch(gvizUrl(sheetName), { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(sheetName + ": HTTP " + res.status + " — check the sheet is still shared as \"Anyone with the link\".");
      return res.text();
    }).then(function (text) {
      var m = text.match(/setResponse\(([\s\S]*)\);?\s*$/);
      if (!m) throw new Error(sheetName + ": unrecognized response — is \"" + sheetName + "\" the exact tab name?");
      var json;
      try { json = JSON.parse(m[1]); }
      catch (e) { throw new Error(sheetName + ": could not parse response JSON — " + e.message); }
      if (json.status === "error") {
        var msg = (json.errors || []).map(function (e) { return e.detailed_message || e.message; }).join("; ");
        throw new Error(sheetName + ": " + (msg || "sheet returned an error — confirm the tab exists and is not empty."));
      }
      var cols = (json.table.cols || []).map(function (c) { return String(c.label || c.id || "").trim(); });
      var rows = (json.table.rows || []).map(function (r) {
        return (r.c || []).map(function (cell) { return cell && cell.v !== undefined ? cell.v : null; });
      });
      return { sheetName: sheetName, cols: cols, rows: rows };
    });
  }

  /* ---------------- header + value helpers ---------------- */
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // Trimmed/lowercased join key for matching the same real-world entity
  // (a warehouse, carrier, order, SKU) across two different sheets, where
  // stray whitespace or case differences between tabs would otherwise
  // break an exact-match lookup and halt the whole load. Only used as a
  // map key — the original raw string is always what gets stored/shown.
  function joinKey(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

  function colIndex(cols, aliases) {
    var normed = cols.map(norm);
    for (var i = 0; i < aliases.length; i++) {
      var a = norm(aliases[i]);
      var idx = normed.indexOf(a);
      if (idx === -1) idx = normed.findIndex(function (c) { return c.length && (c.indexOf(a) !== -1 || a.indexOf(c) !== -1); });
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function requireCol(cols, aliases, sheetName, fieldName, sampleRow) {
    var i = colIndex(cols, aliases);
    if (i === -1) {
      var sample = sampleRow ? " First data row: [" + sampleRow.join(" | ") + "]." : "";
      throw new Error(sheetName + ": could not find a \"" + fieldName + "\" column. Actual headers gviz returned: [" +
        cols.join(", ") + "]." + sample + " Add the real header text to the alias list for this field in data-loader.js.");
    }
    DIAG.columnMap[sheetName + "." + fieldName] = cols[i];
    return i;
  }

  // Looks for any column whose sampled values parse as dates, when none of
  // the named aliases match. Used only where exactly one date column is
  // expected (Clean_Orders) — with more than one date column in a sheet
  // (Clean_Shipments) guessing which is which risks silently corrupting a
  // KPI, so those stay on named aliases + a loud error instead.
  function findDateColumnByContent(cols, rows) {
    for (var c = 0; c < cols.length; c++) {
      var seen = 0, hits = 0;
      for (var r = 0; r < rows.length && seen < 25; r++) {
        var v = rows[r][c];
        if (v == null || v === "") continue;
        seen++;
        if (toISODate(v)) hits++;
      }
      if (seen > 0 && hits / seen > 0.8) return c;
    }
    return -1;
  }

  function optionalCol(cols, aliases, sheetName, fieldName) {
    var i = colIndex(cols, aliases);
    if (i === -1) {
      DIAG.fieldWarnings.push(sheetName + ": no \"" + fieldName + "\" column found — defaulting to 0/false for this flag. " +
        "This will under-report the related Data Quality tile until the real column name is added to data-loader.js.");
    } else {
      DIAG.columnMap[sheetName + "." + fieldName] = cols[i];
    }
    return i;
  }

  // Some QA flags are stored "positively" in the sheet (e.g. a
  // "Reconciled" column that's true when everything is FINE) rather than
  // "negatively" (e.g. "Unreconciled", true when there's a PROBLEM) — the
  // dashboard's internal flags are always the negative/problem framing.
  // This tries the negative aliases first, then the positive ones (and
  // inverts if a positive one matches), so either naming style resolves
  // to the same correct value instead of silently defaulting to 0.
  function resolveProblemFlag(cols, negativeAliases, positiveAliases, sheetName, fieldName) {
    var negI = colIndex(cols, negativeAliases);
    if (negI !== -1) { DIAG.columnMap[sheetName + "." + fieldName] = cols[negI]; return { idx: negI, invert: false }; }
    var posI = colIndex(cols, positiveAliases);
    if (posI !== -1) { DIAG.columnMap[sheetName + "." + fieldName] = cols[posI] + " (inverted)"; return { idx: posI, invert: true }; }
    DIAG.fieldWarnings.push(sheetName + ": no \"" + fieldName + "\" column found (checked both problem-framed and " +
      "reconciled/ok-framed names) — defaulting to 0/false for this flag.");
    return { idx: -1, invert: false };
  }
  function readProblemFlag(row, flagInfo) {
    if (flagInfo.idx === -1) return 0;
    var t = truthy01(row[flagInfo.idx]);
    return flagInfo.invert ? (t ? 0 : 1) : t;
  }

  function toISODate(v) {
    if (v == null) return null;
    if (typeof v === "string") {
      var m = v.match(/^Date\((\d+),(\d+),(\d+)/); // gviz date literal: Date(yyyy,m0,d)
      if (m) {
        var y = +m[1], mo = +m[2] + 1, d = +m[3];
        return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      }
      var parsed = new Date(v);
      if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
      return null;
    }
    return null;
  }
  function toMonth(v) {
    var iso = toISODate(v);
    if (iso) return iso.slice(0, 7);
    if (typeof v === "string" && /^\d{4}-\d{2}$/.test(v)) return v;
    return null;
  }
  function num(v) { return v == null || v === "" ? 0 : Number(v); }
  function truthy01(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v ? 1 : 0;
    var s = String(v).trim().toLowerCase();
    return (s === "1" || s === "true" || s === "yes" || s === "y") ? 1 : 0;
  }

  function enumIndex(enumArr, value, sheetName, fieldName, rowNum) {
    if (value == null || value === "") return null;
    var v = String(value).trim();
    var i = enumArr.findIndex(function (e) { return e.toLowerCase() === v.toLowerCase(); });
    if (i === -1) i = enumArr.findIndex(function (e) { return norm(e) === norm(v); });
    if (i === -1) {
      throw new Error(sheetName + " row " + rowNum + ": unrecognized " + fieldName + " value \"" + value +
        "\" (expected one of: " + enumArr.join(", ") + ")");
    }
    return i;
  }

  /* ---------------- main build ---------------- */
  async function loadLiveData() {
    var settled = await Promise.allSettled(TABS.map(fetchTab));
    var tab = {}, fetchErrors = [];
    settled.forEach(function (r, i) {
      if (r.status === "fulfilled") tab[TABS[i]] = r.value;
      else fetchErrors.push(r.reason.message);
    });
    if (fetchErrors.length) throw new Error("Google Sheets connectivity failed:\n" + fetchErrors.join("\n"));

    DIAG.rowCountWarnings = [];
    TABS.forEach(function (name) {
      var got = tab[name].rows.length, expected = EXPECTED_ROWS[name];
      if (got !== expected) DIAG.rowCountWarnings.push(name + ": expected " + expected + " rows, found " + got);
    });

    /* ---- Clean_Warehouses -> WAREHOUSES (alphabetical, matches original legend order) ---- */
    var whTab = tab.Clean_Warehouses;
    var whNameCol = requireCol(whTab.cols, ["Warehouse Name", "Warehouse"], "Clean_Warehouses", "Warehouse Name", whTab.rows[0]);
    var WAREHOUSES = whTab.rows.map(function (r) { return String(r[whNameCol]); }).sort(function (a, b) { return a.localeCompare(b); });
    var whIndexOf = new Map(WAREHOUSES.map(function (n, i) { return [joinKey(n), i]; }));

    /* ---- Clean_Carriers -> CARRIERS + carrier_active (alphabetical) ---- */
    var carTab = tab.Clean_Carriers;
    var carNameCol = requireCol(carTab.cols, ["Carrier Name", "Carrier"], "Clean_Carriers", "Carrier Name", carTab.rows[0]);
    var carActiveColI = optionalCol(carTab.cols, ["Active Status", "Status"], "Clean_Carriers", "Active Status");
    var carRowsSorted = carTab.rows.slice().sort(function (a, b) { return String(a[carNameCol]).localeCompare(String(b[carNameCol])); });
    var CARRIERS = carRowsSorted.map(function (r) { return String(r[carNameCol]); });
    var carrier_active = carRowsSorted.map(function (r) { return carActiveColI !== -1 ? String(r[carActiveColI]) : "Active"; });
    var carIndexOf = new Map(CARRIERS.map(function (n, i) { return [joinKey(n), i]; }));

    /* ---- Clean_Customers -> CUST_NAMES ---- */
    var custTab = tab.Clean_Customers;
    var custIdCol = requireCol(custTab.cols, ["Customer ID", "CustomerID"], "Clean_Customers", "Customer ID", custTab.rows[0]);
    var custNameCol = requireCol(custTab.cols, ["Customer Name", "Name"], "Clean_Customers", "Customer Name", custTab.rows[0]);
    var CUST_NAMES = {};
    custTab.rows.forEach(function (r) { CUST_NAMES[String(r[custIdCol])] = String(r[custNameCol]); });

    var LEGEND = {
      warehouses: WAREHOUSES, carriers: CARRIERS,
      order_statuses: ORDER_STATUSES, ship_statuses: SHIP_STATUSES, priorities: PRIORITIES,
      carrier_active: carrier_active
    };

    function whIdx(name, sheetName, rowNum) {
      var key = joinKey(name);
      if (!whIndexOf.has(key)) throw new Error(sheetName + " row " + rowNum + ": unrecognized warehouse \"" + name + "\" (not found in Clean_Warehouses)");
      return whIndexOf.get(key);
    }
    function carIdx(name, sheetName, rowNum) {
      var key = joinKey(name);
      if (!carIndexOf.has(key)) throw new Error(sheetName + " row " + rowNum + ": unrecognized carrier \"" + name + "\" (not found in Clean_Carriers)");
      return carIndexOf.get(key);
    }

    /* ---- Clean_Orders -> ORDERS: [ID, MONTH, STATUS_idx, VALUE, UNITS, WH_idx, CUST_ID|null, PRIORITY_idx] ---- */
    var oTab = tab.Clean_Orders;
    var oDateAliases = ["Order Date", "Order Month", "Date", "OrderDate", "Order_Date", "Date Placed",
      "Order Placed Date", "Created Date", "Order Created", "Month", "Order_Month"];
    var oDateColI = colIndex(oTab.cols, oDateAliases);
    if (oDateColI === -1) oDateColI = findDateColumnByContent(oTab.cols, oTab.rows); // last resort: sniff by content
    if (oDateColI === -1) {
      throw new Error("Clean_Orders: could not find an order-date column. Actual headers gviz returned: [" +
        oTab.cols.join(", ") + "]. First data row: [" + (oTab.rows[0] || []).join(" | ") + "]. " +
        "Add the real header text to oDateAliases in data-loader.js.");
    } else {
      DIAG.columnMap["Clean_Orders.Order Date"] = oTab.cols[oDateColI];
    }
    var oCol = {
      id: requireCol(oTab.cols, ["Order ID"], "Clean_Orders", "Order ID", oTab.rows[0]),
      date: oDateColI,
      status: requireCol(oTab.cols, ["Order Status", "Status"], "Clean_Orders", "Order Status", oTab.rows[0]),
      value: requireCol(oTab.cols, ["Order Value", "Value", "Order Total", "Total Value"], "Clean_Orders", "Order Value", oTab.rows[0]),
      units: requireCol(oTab.cols, ["Units", "Order Units"], "Clean_Orders", "Units", oTab.rows[0]),
      wh: requireCol(oTab.cols, ["Warehouse", "Warehouse Name"], "Clean_Orders", "Warehouse", oTab.rows[0]),
      cust: optionalCol(oTab.cols, ["Customer ID", "CustomerID"], "Clean_Orders", "Customer ID"),
      priority: requireCol(oTab.cols, ["Priority"], "Clean_Orders", "Priority", oTab.rows[0])
    };
    var ORDERS = oTab.rows.map(function (r, i) {
      var rn = i + 2;
      var custVal = oCol.cust !== -1 ? r[oCol.cust] : null;
      return [
        String(r[oCol.id]),
        toMonth(r[oCol.date]),
        enumIndex(ORDER_STATUSES, r[oCol.status], "Clean_Orders", "Order Status", rn),
        num(r[oCol.value]),
        num(r[oCol.units]),
        whIdx(r[oCol.wh], "Clean_Orders", rn),
        (custVal == null || custVal === "") ? null : String(custVal),
        enumIndex(PRIORITIES, r[oCol.priority], "Clean_Orders", "Priority", rn)
      ];
    });

    /* Order ID -> Priority lookup, used below to resolve shipment priority
       (Clean_Shipments has no Priority column of its own; Clean_Orders is
       the source of truth for it). ORDERS[i][O.PRIORITY] is already the
       enum index built above. Keyed by a trimmed/lowercased Order ID so a
       stray space or case difference between the two sheets doesn't break
       the join. */
    var orderPriorityByOrderId = new Map();
    ORDERS.forEach(function (row) { orderPriorityByOrderId.set(joinKey(row[0]), row[7]); });

    /* ---- Clean_Shipments -> SHIPMENTS: [ID, ORDER_ID, MONTH, CARRIER_idx, WH_idx, STATUS_idx,
            ACTUAL, EXPECTED, SHIP_DATE, UNITS, DAMAGE, DATE_SEQ_ERR, PRIORITY_idx] ----
       PRIORITY_idx is resolved via Order ID from Clean_Orders (see lookup above) —
       Clean_Shipments itself has no Priority column. */
    var sTab = tab.Clean_Shipments;
    var sCol = {
      id: requireCol(sTab.cols, ["Shipment ID"], "Clean_Shipments", "Shipment ID", sTab.rows[0]),
      orderId: requireCol(sTab.cols, ["Order ID"], "Clean_Shipments", "Order ID", sTab.rows[0]),
      carrier: requireCol(sTab.cols, ["Carrier"], "Clean_Shipments", "Carrier", sTab.rows[0]),
      wh: requireCol(sTab.cols, ["Warehouse"], "Clean_Shipments", "Warehouse", sTab.rows[0]),
      status: requireCol(sTab.cols, ["Shipment Status", "Status"], "Clean_Shipments", "Shipment Status", sTab.rows[0]),
      actual: requireCol(sTab.cols, ["Actual Delivery Date", "Actual Delivery", "Delivery Date", "Actual Delivery_Date",
        "Delivered Date", "Actual Arrival", "Actual Arrival Date"], "Clean_Shipments", "Actual Delivery Date", sTab.rows[0]),
      expected: requireCol(sTab.cols, ["Expected Delivery Date", "Expected Delivery", "Expected Delivery_Date",
        "Promised Delivery Date", "ETA", "Scheduled Delivery Date"], "Clean_Shipments", "Expected Delivery Date", sTab.rows[0]),
      shipDate: requireCol(sTab.cols, ["Ship Date", "Shipped Date", "Date Shipped", "Ship_Date"], "Clean_Shipments", "Ship Date", sTab.rows[0]),
      units: requireCol(sTab.cols, ["Units", "Shipment Units"], "Clean_Shipments", "Units", sTab.rows[0]),
      damage: optionalCol(sTab.cols, ["Damage Flag", "Damaged"], "Clean_Shipments", "Damage Flag"),
      // Some sheets already carry the chronology-error flag as raw QA data
      // (e.g. "Date_Sequence_Error_Flag"). If present, use it directly —
      // it's more faithful to the sheet's own cleaning logic than recomputing.
      dateSeqErr: optionalCol(sTab.cols, ["Date Sequence Error Flag", "Date_Sequence_Error_Flag", "Date Sequence Error"], "Clean_Shipments", "Date Sequence Error Flag")
    };
    var SHIPMENTS = sTab.rows.map(function (r, i) {
      var rn = i + 2;
      var actualISO = toISODate(r[sCol.actual]);
      var expectedISO = toISODate(r[sCol.expected]);
      var shipISO = toISODate(r[sCol.shipDate]);
      // Invalid-chronology flag (K-22): actual delivery logged before the ship date.
      // Use the sheet's own flag when it exists; otherwise compute the same rule.
      var dateSeqErr = sCol.dateSeqErr !== -1
        ? truthy01(r[sCol.dateSeqErr])
        : ((actualISO && shipISO && new Date(actualISO) < new Date(shipISO)) ? 1 : 0);
      var shipId = String(r[sCol.id]);
      var orderId = String(r[sCol.orderId]);
      var priorityKey = joinKey(orderId);
      if (!orderPriorityByOrderId.has(priorityKey)) {
        throw new Error("Clean_Shipments row " + rn + ": shipment \"" + shipId + "\" references Order ID \"" +
          orderId + "\", which was not found in Clean_Orders — cannot resolve its Priority. " +
          "This is a data issue between the two sheets, not a mapping guess.");
      }
      return [
        shipId,
        orderId,
        toMonth(shipISO),
        carIdx(r[sCol.carrier], "Clean_Shipments", rn),
        whIdx(r[sCol.wh], "Clean_Shipments", rn),
        enumIndex(SHIP_STATUSES, r[sCol.status], "Clean_Shipments", "Shipment Status", rn),
        actualISO,
        expectedISO,
        shipISO,
        num(r[sCol.units]),
        sCol.damage !== -1 ? truthy01(r[sCol.damage]) : 0,
        dateSeqErr,
        orderPriorityByOrderId.get(priorityKey)
      ];
    });

    /* ---- Clean_Freight -> FREIGHT: [SHIP_ID, CARRIER_idx, TOTAL, UNRECON, DUP] ---- */
    var fTab = tab.Clean_Freight;
    var fCol = {
      shipId: requireCol(fTab.cols, ["Shipment ID"], "Clean_Freight", "Shipment ID", fTab.rows[0]),
      carrier: requireCol(fTab.cols, ["Carrier"], "Clean_Freight", "Carrier", fTab.rows[0]),
      total: requireCol(fTab.cols, ["Total Freight Cost", "Freight Cost", "Total Cost", "Amount", "Freight Total", "Total Freight"], "Clean_Freight", "Total Freight Cost", fTab.rows[0])
    };
    // Reconciliation/duplicate QA flags can be named either "problem-framed"
    // (Unreconciled/Duplicate Flag, true = issue) or "ok-framed" (Reconciled
    // Flag, true = fine) — resolveProblemFlag checks both and normalizes to
    // the problem-framed meaning the dashboard expects.
    var fUnreconFlag = resolveProblemFlag(fTab.cols,
      ["Unreconciled", "Unreconciled Flag", "Reconciliation Flag", "Freight Unreconciled Flag"],
      ["Reconciled", "Reconciled Flag", "Freight Reconciled Flag", "Is Reconciled"],
      "Clean_Freight", "Unreconciled Flag");
    var fDupFlag = resolveProblemFlag(fTab.cols,
      ["Duplicate Flag", "Is Duplicate", "Duplicate", "Duplicate Charge Flag"],
      ["Unique Flag", "Is Unique"],
      "Clean_Freight", "Duplicate Flag");
    // Duplicate detection fallback: if the sheet has no explicit duplicate column,
    // flag every row that shares a Shipment ID with a different Total Freight Cost
    // (mirrors the "2 conflicting freight amounts" definition in the DQ panel).
    var byShipId = new Map();
    fTab.rows.forEach(function (r) {
      var id = joinKey(r[fCol.shipId]);
      if (!byShipId.has(id)) byShipId.set(id, []);
      byShipId.get(id).push(num(r[fCol.total]));
    });
    function computedDup(id) {
      var vals = byShipId.get(joinKey(id)) || [];
      return (vals.length > 1 && new Set(vals).size > 1) ? 1 : 0;
    }
    var FREIGHT = fTab.rows.map(function (r) {
      return [
        String(r[fCol.shipId]),
        carIdx(r[fCol.carrier], "Clean_Freight", "?"),
        num(r[fCol.total]),
        fUnreconFlag.idx !== -1 ? readProblemFlag(r, fUnreconFlag) : 0,
        fDupFlag.idx !== -1 ? readProblemFlag(r, fDupFlag) : computedDup(r[fCol.shipId])
      ];
    });

    /* SKU -> Category lookup: Clean_Inventory has no Category column of its
       own; Clean_Products is the source of truth for it. Keyed by a
       trimmed/lowercased SKU so a formatting difference between the two
       sheets doesn't break the join. */
    var prodTab = tab.Clean_Products;
    var prodSkuCol = requireCol(prodTab.cols, ["SKU", "Product SKU", "SKU Code", "Item SKU"], "Clean_Products", "SKU", prodTab.rows[0]);
    var prodCategoryCol = requireCol(prodTab.cols, ["Category", "Product Category", "Item Category"], "Clean_Products", "Category", prodTab.rows[0]);
    var categoryBySku = new Map();
    prodTab.rows.forEach(function (r) { categoryBySku.set(joinKey(r[prodSkuCol]), String(r[prodCategoryCol])); });

    /* ---- Clean_Inventory -> INVENTORY: [SKU, NAME, CATEGORY, WH_idx, CLOSING, REORDER, VALUE, UNRECON] ----
       CATEGORY is resolved via SKU from Clean_Products (see lookup above) —
       Clean_Inventory itself has no Category column. */
    var ivTab = tab.Clean_Inventory;
    var ivCol = {
      sku: requireCol(ivTab.cols, ["SKU"], "Clean_Inventory", "SKU", ivTab.rows[0]),
      name: requireCol(ivTab.cols, ["Product Name", "Name"], "Clean_Inventory", "Product Name", ivTab.rows[0]),
      wh: requireCol(ivTab.cols, ["Warehouse"], "Clean_Inventory", "Warehouse", ivTab.rows[0]),
      closing: requireCol(ivTab.cols, ["Closing Stock", "Closing Inventory", "Closing Quantity"], "Clean_Inventory", "Closing Stock"),
      reorder: requireCol(ivTab.cols, ["Reorder Point", "Reorder Level"], "Clean_Inventory", "Reorder Point"),
      value: requireCol(ivTab.cols, ["Inventory Value", "Value"], "Clean_Inventory", "Inventory Value")
    };
    var ivUnreconFlag = resolveProblemFlag(ivTab.cols,
      ["Unreconciled", "Unreconciled Flag", "Reconciliation Flag", "Stock Unreconciled Flag"],
      ["Reconciled", "Reconciled Flag", "Stock Reconciled Flag", "Is Reconciled"],
      "Clean_Inventory", "Unreconciled Flag");
    var INVENTORY = ivTab.rows.map(function (r, i) {
      var rn = i + 2;
      var sku = String(r[ivCol.sku]);
      var skuKey = joinKey(sku);
      if (!categoryBySku.has(skuKey)) {
        throw new Error("Clean_Inventory row " + rn + ": SKU \"" + sku +
          "\" was not found in Clean_Products — cannot resolve its Category. This is a data issue between the two sheets, not a mapping guess.");
      }
      return [
        sku,
        String(r[ivCol.name]),
        categoryBySku.get(skuKey),
        whIdx(r[ivCol.wh], "Clean_Inventory", rn),
        num(r[ivCol.closing]),
        r[ivCol.reorder] == null || r[ivCol.reorder] === "" ? null : num(r[ivCol.reorder]),
        num(r[ivCol.value]),
        readProblemFlag(r, ivUnreconFlag)
      ];
    });

    /* ---- Clean_Warehouse_Ops -> WH_OPS: aggregate raw daily ops rows up to one row per
            warehouse, index-aligned to WAREHOUSES (dashboard.js relies on positional index
            === WAREHOUSES index).
            The sheet has no "Productivity" or "Error Rate" columns — those are derived here
            from the raw counts, since dashboard.js labels them "Units/Labor Hr" (line ~1234)
            and a percentage "Error Rate" (fmtPct) respectively:
              Productivity = total Units Shipped / total Labor Hours  (ratio of sums, not an
                             average of daily ratios, so low-volume days don't skew it)
              Error Rate   = total Picking Errors / total Orders Picked
            This is a judgment call in the absence of a named source column — flag if the
            intended definition differs (e.g. Damaged Units / Units Shipped instead). ---- */
    var opsTab = tab.Clean_Warehouse_Ops;
    var opsCol = {
      wh: requireCol(opsTab.cols, ["Warehouse"], "Clean_Warehouse_Ops", "Warehouse"),
      orders: requireCol(opsTab.cols, ["Orders Shipped"], "Clean_Warehouse_Ops", "Orders Shipped"),
      units: requireCol(opsTab.cols, ["Units Shipped"], "Clean_Warehouse_Ops", "Units Shipped"),
      ordersPicked: requireCol(opsTab.cols, ["Orders Picked"], "Clean_Warehouse_Ops", "Orders Picked"),
      laborHours: requireCol(opsTab.cols, ["Labor Hours"], "Clean_Warehouse_Ops", "Labor Hours"),
      pickingErrors: requireCol(opsTab.cols, ["Picking Errors"], "Clean_Warehouse_Ops", "Picking Errors")
    };
    var opsAgg = WAREHOUSES.map(function () { return { orders: 0, units: 0, ordersPicked: 0, laborHours: 0, pickingErrors: 0 }; });
    opsTab.rows.forEach(function (r, i) {
      var idx = whIdx(r[opsCol.wh], "Clean_Warehouse_Ops", i + 2);
      var a = opsAgg[idx];
      a.orders += num(r[opsCol.orders]);
      a.units += num(r[opsCol.units]);
      a.ordersPicked += num(r[opsCol.ordersPicked]);
      a.laborHours += num(r[opsCol.laborHours]);
      a.pickingErrors += num(r[opsCol.pickingErrors]);
    });
    var WH_OPS = WAREHOUSES.map(function (name, i) {
      var a = opsAgg[i];
      var productivity = a.laborHours > 0 ? a.units / a.laborHours : 0;
      var errorRate = a.ordersPicked > 0 ? a.pickingErrors / a.ordersPicked : 0;
      return [name, a.orders, a.units, productivity, errorRate];
    });

    var META = {
      last_updated: new Date().toISOString(),
      inventory_month: null,
      source: "Google Sheets (live) — " + SHEET_ID
    };

    if (DIAG.rowCountWarnings.length) console.warn("[ArcLane live data] row count mismatches:\n" + DIAG.rowCountWarnings.join("\n"));
    if (DIAG.fieldWarnings.length) console.warn("[ArcLane live data] missing optional columns:\n" + DIAG.fieldWarnings.join("\n"));
    console.info("[ArcLane live data] column mapping used:", DIAG.columnMap);

    return { LEGEND: LEGEND, ORDERS: ORDERS, SHIPMENTS: SHIPMENTS, FREIGHT: FREIGHT, INVENTORY: INVENTORY, WH_OPS: WH_OPS, CUST_NAMES: CUST_NAMES, META: META };
  }

  /* ---------------- boot sequence: fetch, then hand off to dashboard.js ---------------- */
  function showState(kind, detail) {
    var overlay = document.getElementById("liveDataOverlay");
    if (!overlay) return;
    if (kind === "loading") {
      overlay.style.display = "flex";
      overlay.innerHTML = '<div class="live-data-box"><div class="skeleton" style="width:220px;height:14px;margin:0 auto 12px;"></div>' +
        '<div style="color:var(--text-secondary,#94a3b8);font-size:13px;">Loading live data from Google Sheets…</div></div>';
    } else if (kind === "error") {
      overlay.style.display = "flex";
      overlay.innerHTML = '<div class="live-data-box" style="max-width:520px;text-align:left;">' +
        '<div style="color:#F87171;font-weight:700;margin-bottom:8px;">Couldn\u2019t load live data</div>' +
        '<div style="color:var(--text-secondary,#94a3b8);font-size:12px;white-space:pre-wrap;margin-bottom:14px;">' + detail + '</div>' +
        '<button id="liveDataRetry" style="background:#22D3EE;color:#0a0f1a;border:none;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;">Retry</button>' +
        '</div>';
      var btn = document.getElementById("liveDataRetry");
      if (btn) btn.addEventListener("click", boot);
    } else {
      overlay.style.display = "none";
    }
  }

  async function boot() {
    showState("loading");
    try {
      window.__ARCLANE_LIVE_DATA__ = await loadLiveData();
      showState("done");
      // Single-file build: the dashboard engine is defined further down this
      // same HTML file as the global function __ARCLANE_RUN_DASHBOARD__ (no
      // dashboard.js/data-loader.js files involved — everything is inline).
      if (typeof window.__ARCLANE_RUN_DASHBOARD__ !== "function") {
        throw new Error("Internal error: dashboard engine script did not load. Check the page for a JS syntax error above this message in the console.");
      }
      window.__ARCLANE_RUN_DASHBOARD__();
    } catch (err) {
      console.error("[ArcLane live data] load failed:", err);
      showState("error", err.message || String(err));
    }
  }

  window.__ARCLANE_BOOT__ = boot;
  document.addEventListener("DOMContentLoaded", boot);
})();

