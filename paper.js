"use strict";
// ================= 模擬倉（日K波段）=================
// 規則：只做多；下單後，第一根「開盤時間在下單之後」的日K用開盤價成交；
// 停損先於目標檢查；跳空跌破停損用開盤價出場；只用已收完的日K；缺資料就停在那天，不會跳過。
const PKEY = 'stockLedger.paper.v1';
const P_REASONS = [
  '日線方向向上 (B1)',
  '關鍵區：區間低點／等低點／明顯擺動低點 (L1/L3/L4)',
  '明顯掃低後收回 (E1/C2)',
  '訊號K：收在上半部／吞噬 (E2)',
  '訊號K左邊有結構 (E3)',
  '強於大盤（自訂，非規則書）',
];
const PAPER = { st: loadPaper(), cur: 'TWD', idx: null, us: null, snaps: {}, halts: {}, busy: false };
function loadPaper(){ try{ const v=JSON.parse(localStorage.getItem(PKEY)); if(v && v.TWD && v.USD) return v; }catch(e){} return null; }
function savePaper(){ try{ localStorage.setItem(PKEY, JSON.stringify(PAPER.st)); }catch(e){ toast('無法儲存模擬倉'); } }
const newAcct = init => ({init, cash:init, pos:{}, orders:[], hist:[], skips:[]});

// ---------- 市場與時間 ----------
function mktOf(cur, code){
  if(cur==='USD') return 'us';
  const m=PR?.prices?.[code]?.m; return m==='上櫃'? 'tpex' : m==='上市'? 'twse' : null;
}
function nyOffset(date){
  try{
    const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(new Date(date+'T12:00:00Z'));
    const z=p.find(x=>x.type==='timeZoneName').value.match(/GMT([+-]\d+)/);
    if(z){ const h=+z[1]; return (h<0?'-':'+')+String(Math.abs(h)).padStart(2,'0')+':00'; }
  }catch(e){}
  const m=+date.slice(5,7); return (m>=4&&m<=10)? '-04:00' : '-05:00';   // 舊瀏覽器的近似值
}
// 那一天開盤的時間（毫秒）
function sessionStart(mkt, date){ return mkt==='us'? Date.parse(`${date}T09:30:00${nyOffset(date)}`) : Date.parse(`${date}T09:00:00+08:00`); }
const isETFcode = c => /^00/.test(c);
function feeIn(cur, notional){ return cur==='TWD'? Math.max(1, Math.floor(notional*0.001425)) : notional*(PAPER.st.usFee??0.001); }
function feeOut(cur, code, notional){
  if(cur==='TWD') return Math.max(1, Math.floor(notional*0.001425)) + Math.floor(notional*(isETFcode(code)?0.001:0.003));
  return notional*(PAPER.st.usFee??0.001);
}
function lastPrice(cur, code){
  if(cur==='TWD') return PR?.prices?.[code]?.c ?? null;
  const r=PAPER.us?.rows?.[code]; return r? r[r.length-1][4] : null;
}
function lastDateOf(cur, code){
  if(cur==='TWD'){ const m=mktOf(cur,code); return m? PR?.dates?.[m] || PR?.date : null; }
  const r=PAPER.us?.rows?.[code]; return r? r[r.length-1][0] : null;
}

// ---------- 資料 ----------
async function paperLoadData(){
  const get=u=>fetch(u,{cache:'no-cache'}).then(r=>r.ok? r.json() : null).catch(()=>null);
  const [idx, us]=await Promise.all([get('data/daily/index.json'), get('data/daily/us.json')]);
  if(idx) PAPER.idx=idx; if(us) PAPER.us=us;
}
async function snapshot(mkt, date){
  const k=mkt+'/'+date;
  if(!(k in PAPER.snaps)){
    PAPER.snaps[k]=await fetch(`data/daily/${k}.json`).then(r=>r.ok? r.json() : null).catch(()=>null);
  }
  return PAPER.snaps[k];
}
// 取得某檔在 after 之後的日K。台股會檢查交易日曆（0050 的交易日），缺快照就在那天停下。
async function barsAfter(cur, code, after, skips){
  if(cur==='USD'){
    const rows=PAPER.us?.rows?.[code]||[];
    return {bars: rows.filter(r=>r[0]>after).map(r=>({date:r[0], o:r[1], h:r[2], l:r[3], c:r[4]})), missing:null};
  }
  const mkt=mktOf(cur,code); if(!mkt || !PAPER.idx) return {bars:[], missing:null};
  const have=new Set(PAPER.idx[mkt]||[]), lastIdx=(PAPER.idx[mkt]||[]).slice(-1)[0];
  if(!lastIdx) return {bars:[], missing:null};
  const cal=new Set((BM?.bench?.['0050']?.rows||[]).map(r=>r[0]).filter(d=>d>after && d<=lastIdx));
  for(const d of have) if(d>after) cal.add(d);
  const days=[...cal].sort(), bars=[];
  for(const d of days){
    if(!have.has(d)){ if((skips||[]).includes(mkt+'/'+d)) continue; return {bars, missing:{mkt, date:d}}; }
    const s=await snapshot(mkt,d);
    if(!s) return {bars, missing:{mkt, date:d}};
    const b=s[code];
    bars.push(b? {date:d, o:b[0], h:b[1], l:b[2], c:b[3]} : {date:d, none:true});   // none：那天沒成交
  }
  return {bars, missing:null};
}
// 前一個交易日的含息價（大盤比較用：從進場前一天收盤到出場當天收盤，約略比較）
function benchRet(code, d1, d2){
  const rows=BM?.bench?.[code]?.rows; if(!rows) return null;
  let i=rows.findIndex(r=>r[0]>=d1); if(i<=0) return null; const a=rows[i-1];
  let j=-1; for(let k=rows.length-1;k>=0;k--) if(rows[k][0]<=d2){ j=k; break; }
  if(j<i-1) return null;
  return rows[j][2]/a[2]-1;
}

// ---------- 撮合 ----------
function acctEquity(cur){
  const A=PAPER.st[cur]; let e=A.cash;
  for(const [code,p] of Object.entries(A.pos)) e+=p.qty*(p.lastC ?? lastPrice(cur,code) ?? p.entry);
  return e;
}
function pOpen(cur, code, o, bar){
  const A=PAPER.st[cur], m=o.meta, px=bar.o;
  if(px<=m.stop) return `${code} 掛單取消：開盤價 ${fmt(px,2)} 已經低於停損`;
  if(m.target!=null && px>=m.target) return `${code} 掛單取消：開盤價 ${fmt(px,2)} 已經超過目標`;
  const eq=acctEquity(cur), risk=eq*(PAPER.st.risk??1)/100, dist=px-m.stop;
  let qty=Math.floor(Math.min(risk/dist, A.cash/(px*1.002)));
  while(qty>0 && qty*px+feeIn(cur,qty*px)>A.cash) qty--;
  if(qty<1) return `${code} 掛單取消：資金不夠買 1 股`;
  const fee=feeIn(cur,qty*px);
  A.cash -= qty*px+fee;
  A.pos[code]={qty, entry:px, entryDate:bar.date, feeIn:fee, stop0:m.stop, sl:m.stop, tp:m.target??null, hi:bar.h, lo:bar.l, lastDate:bar.date, lastC:bar.c, meta:m};
  return `${code} 買進成交 ${fmt(qty)} 股 @ ${fmt(px,2)}`;
}
function pClose(cur, code, px, date, reason){
  const A=PAPER.st[cur], p=A.pos[code], notional=p.qty*px, fo=feeOut(cur,code,notional);
  A.cash += notional-fo;
  const net=notional-fo-(p.qty*p.entry+p.feeIn), r1=p.qty*(p.entry-p.stop0);
  const bc = cur==='TWD'? '0050' : 'VOO', br=benchRet(bc, p.entryDate, date);
  const tr={code, cur, entryDate:p.entryDate, exitDate:date, qty:p.qty, entry:p.entry, exit:px, stop0:p.stop0, target:p.tp, reason,
    pnl:net, ret:net/(p.qty*p.entry+p.feeIn), rNet:net/r1, rGross:(px-p.entry)/(p.entry-p.stop0),
    mfeR:(p.hi-p.entry)/(p.entry-p.stop0), maeR:(p.lo-p.entry)/(p.entry-p.stop0),
    bench:bc, benchRet:br, check:p.meta.check||{}, note:p.meta.note||''};
  A.hist.push(tr); delete A.pos[code];
  return `${code} ${reason}出場 @ ${fmt(px,2)}（${tr.rNet>=0?'+':''}${tr.rNet.toFixed(2)}R）`;
}
async function settle(cur){
  const A=PAPER.st[cur], events=[];
  const codes=[...new Set([...Object.keys(A.pos), ...A.orders.map(o=>o.code)])];
  // 先把每一檔需要的K棒抓齊，再「依日期」一起結算，部位大小才不會用到之後才發生的損益
  const series={}, stopAt={};
  for(const code of codes){
    const mkt=mktOf(cur,code); if(!mkt) continue;
    const start = A.pos[code]? A.pos[code].lastDate : prevDay(A.orders.filter(o=>o.code===code).map(o=>o.placedDate).sort()[0]);
    const {bars, missing}=await barsAfter(cur, code, start, A.skips);
    series[code]={mkt, bars:new Map(bars.map(b=>[b.date,b]))};
    delete PAPER.halts[cur+code];
    if(missing){ stopAt[code]=missing.date; PAPER.halts[cur+code]={cur, code, ...missing}; }
  }
  const dates=[...new Set(Object.values(series).flatMap(x=>[...x.bars.keys()]))].sort();
  for(const date of dates){
    for(const [code,{mkt,bars}] of Object.entries(series)){
      const b=bars.get(date); if(!b) continue;
      if(stopAt[code] && date>stopAt[code]) continue;
      if(b.none){ if(A.pos[code]) A.pos[code].lastDate=date; continue; }   // 那天沒有成交
      for(const o of A.orders.filter(o=>o.code===code)){
        if(sessionStart(mkt,date) <= o.placedAt) continue;                  // 只能在下單之後開盤的K棒成交
        A.orders=A.orders.filter(x=>x!==o);
        if(o.act==='buy' && !A.pos[code]) events.push(pOpen(cur,code,o,b));
        else if(o.act==='close' && A.pos[code]) events.push(pClose(cur,code,b.o,date,'手動'));
      }
      const p=A.pos[code];
      if(p){   // 剛成交的那根也要檢查停損；停損先於目標
        if(b.h>p.hi) p.hi=b.h; if(b.l<p.lo) p.lo=b.l;
        if(p.sl!=null && b.l<=p.sl) events.push(pClose(cur,code,Math.min(b.o,p.sl),date,'停損'));
        else if(p.tp!=null && b.h>=p.tp) events.push(pClose(cur,code,Math.max(b.o,p.tp),date,'停利'));
        else { p.lastDate=date; p.lastC=b.c; }
      }
    }
  }
  for(const code of Object.keys(PAPER.halts)) if(PAPER.halts[code].cur===cur && !A.pos[PAPER.halts[code].code] && !A.orders.some(o=>o.code===PAPER.halts[code].code)) delete PAPER.halts[code];
  return events;
}
function prevDay(d){ const t=new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()-1); return t.toISOString().slice(0,10); }
function marketToday(mkt){
  const tz = mkt==='us'? 'America/New_York' : 'Asia/Taipei';
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return p;   // YYYY-MM-DD
}
async function paperRefresh(silent){
  if(!PAPER.st || PAPER.busy) return;
  PAPER.busy=true;
  try{
    await paperLoadData();
    const ev=[...await settle('TWD'), ...await settle('USD')];
    PAPER.st.lastSettle=Date.now(); savePaper();
    if(ev.length) openSheet(`<h2 id="sheetTitle" style="margin:0">模擬倉更新</h2><ul style="margin:0;padding-left:20px">${ev.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><div class="row" style="justify-content:flex-end"><button class="pri" onclick="closeSheet()">知道了</button></div>`);
    else if(!silent) toast('已是最新');
  }catch(e){ toast('模擬倉更新失敗：'+e.message); }
  PAPER.busy=false; renderPaper();
}

// ---------- 畫面 ----------
function renderPaper(){
  const box=$('paperBody'); if(!box) return;
  const st=PAPER.st;
  if(!st){
    box.innerHTML=`<section class="card"><h2>建立模擬倉</h2>
      <p class="hint" style="margin-top:0">用真實的每日行情、假的錢練習波段。台股和美股分成兩個帳戶，各自計算。</p>
      <div class="grid2"><label class="f">台幣帳戶初始資金<input type="number" id="pvTWD" value="1000000" inputmode="numeric"></label>
      <label class="f">美元帳戶初始資金<input type="number" id="pvUSD" value="30000" inputmode="numeric"></label></div>
      <label class="f" style="margin-top:10px">每筆風險（帳戶的 %）<input type="number" id="pvRisk" value="1" step="0.5" inputmode="decimal"></label>
      <p class="hint">部位大小 = 帳戶 × 風險% ÷（進場價 − 停損價），買整數股。規則書 P1：一般 1–2%。</p>
      <div class="row" style="justify-content:flex-end"><button class="pri" id="pvCreate">建立</button></div></section>`;
    $('pvCreate').onclick=()=>{ const t=+$('pvTWD').value, u=+$('pvUSD').value, r=+$('pvRisk').value;
      if(!(t>0)||!(u>0)) return toast('請輸入初始資金'); if(!(r>0&&r<=10)) return toast('風險請填 0～10 之間');
      PAPER.st={TWD:newAcct(t), USD:newAcct(u), risk:r, usFee:0.001, created:Date.now()}; savePaper(); renderPaper(); toast('模擬倉已建立'); };
    return;
  }
  const cur=PAPER.cur, A=st[cur], eq=acctEquity(cur), unit=cur==='TWD'?'':'US$';
  const halts=Object.values(PAPER.halts).filter(h=>h.cur===cur);
  const H=A.hist, rs=H.map(t=>t.rNet), sumR=rs.reduce((a,b)=>a+b,0), wins=rs.filter(x=>x>0).length;
  const hb=H.filter(t=>t.benchRet!=null), ex=hb.length? hb.reduce((s,t)=>s+(t.ret-t.benchRet),0)/hb.length : null;
  const posRows=Object.entries(A.pos);
  box.innerHTML=`
    <div class="seg" style="grid-template-columns:1fr 1fr" id="pvCurSeg"><button data-c="TWD" class="${cur==='TWD'?'on':''}">台股（台幣）</button><button data-c="USD" class="${cur==='USD'?'on':''}">美股（美元）</button></div>
    <section class="card hero">
      <div class="mut small">總權益</div><div class="big num">${unit}${fmt(eq, cur==='TWD'?0:2)}</div>
      <div class="kv">
        <div><span>初始資金</span><b>${unit}${fmt(A.init)}</b></div>
        <div><span>報酬</span><b class="${cls(eq-A.init)}">${pct(eq/A.init-1)}</b></div>
        <div><span>現金</span><b>${unit}${fmt(A.cash, cur==='TWD'?0:2)}</b></div>
        <div><span>已平倉</span><b>${H.length} 筆｜<span class="${cls(sumR)}">${sumR>=0?'+':''}${sumR.toFixed(1)}R</span></b></div>
      </div>
      <div class="row" style="margin-top:10px;justify-content:space-between"><span class="hint">${st.lastSettle? '上次結算 '+new Date(st.lastSettle).toLocaleString('zh-TW',{hour12:false}) : ''}</span><button id="pvRefresh">更新並結算</button></div>
      ${halts.map(h=>`<p class="hint warn">${esc(h.code)}：缺 ${h.date} 的${h.mkt==='tpex'?'上櫃':'上市'}資料，結算停在前一天。GitHub 一天會補抓三次；如果過了一兩天還是缺，代表那天的資料已經拿不到了，可以按 <button data-skip="${h.mkt}/${h.date}">跳過這天</button>（這天的停損、成交都不算）。</p>`).join('')}
    </section>
    <section class="card"><h2>持倉</h2><div class="list">${posRows.length? posRows.map(([code,p])=>{
        const px=lastPrice(cur,code) ?? p.lastC, r=(px-p.entry)/(p.entry-p.stop0);
        return `<div class="item" data-ppos="${esc(code)}"><div><b>${esc(code)}</b> ${esc(cur==='TWD'?nameOf(code):'')}<div class="small mut num">${fmt(p.qty)} 股 @ ${fmt(p.entry,2)}｜${p.entryDate} 進場</div><div class="small mut num">停損 ${fmt(p.sl,2)}${p.tp!=null?'｜目標 '+fmt(p.tp,2):''}</div></div>
          <div class="r"><div class="num">${fmt(px,2)}</div><div class="small num ${cls(r)}">${r>=0?'+':''}${r.toFixed(2)}R</div></div></div>`; }).join('') : '<div class="empty">沒有持倉。按右下角「＋」下單。</div>'}</div></section>
    <section class="card"><h2>掛單（下一個開盤成交）</h2><div class="list">${A.orders.length? A.orders.map(o=>`<div class="item"><div><b>${esc(o.code)}</b> ${o.act==='buy'?'買進':'平倉'}<div class="small mut">${new Date(o.placedAt).toLocaleString('zh-TW',{hour12:false})} 下單${o.meta? '｜停損 '+fmt(o.meta.stop,2):''}</div></div><div class="r"><button data-pcancel="${o.id}">取消</button></div></div>`).join('') : '<div class="empty">沒有掛單</div>'}</div></section>
    <section class="card"><h2>成績</h2>
      ${H.length? `<div class="kv" style="margin-top:0">
        <div><span>交易筆數</span><b>${H.length}${H.length<30?' <span class="warn small">（少於30筆，先別下結論）</span>':''}</b></div>
        <div><span>勝率</span><b>${(wins/H.length*100).toFixed(0)}%</b></div>
        <div><span>平均每筆（扣成本）</span><b class="${cls(sumR)}">${(sumR/H.length>=0?'+':'')+(sumR/H.length).toFixed(2)}R</b></div>
        <div><span>平均贏過${cur==='TWD'?'0050':'VOO'}</span><b class="${cls(ex)}">${ex==null?'—':pct(ex)}</b></div></div>
        <div class="list" style="margin-top:8px">${H.slice(-15).reverse().map(t=>`<div class="item"><div><b>${esc(t.code)}</b> <span class="small mut">${t.entryDate} → ${t.exitDate}｜${t.reason}</span>${t.note?`<div class="small mut">${esc(t.note)}</div>`:''}</div>
          <div class="r"><div class="num ${cls(t.rNet)}">${t.rNet>=0?'+':''}${t.rNet.toFixed(2)}R</div><div class="small mut num">${pct(t.ret)}｜${t.bench} ${t.benchRet==null?'—':pct(t.benchRet)}</div></div></div>`).join('')}</div>`
        : '<div class="empty">平倉後會在這裡累積成績：R、勝率，以及跟同期間大盤比。</div>'}
    </section>
    <section class="card"><details><summary>規則說明</summary><p class="hint">只做多，用日K結算。按「買進」後，用<b>下一個開盤</b>的價格成交（盤前下單＝當天開盤，盤中或收盤後下單＝下一個交易日開盤）。停損和目標用每天的最高、最低價檢查，同一天都碰到時先算停損；開盤就跳空跌破停損，用開盤價出場。股價沒有還原除權息，除權息那天價格會往下跳，可能碰到停損。美股能交易的代號在 GitHub 專案的 data/us_symbols.txt，要加新代號就加在那裡。和大盤的比較是從進場前一天收盤到出場當天收盤，屬於約略比較。</p>
      <div class="row"><button class="danger" id="pvReset">重設模擬倉</button></div></details></section>`;
  $('pvCurSeg').onclick=e=>{ const b=e.target.closest('button'); if(b){ PAPER.cur=b.dataset.c; renderPaper(); if(window.renderStrong) renderStrong(); } };
  $('pvRefresh').onclick=()=>paperRefresh(false);
  $('pvReset').onclick=()=>{ if(!confirm('重設會清掉兩個模擬帳戶的持倉、掛單和成績，確定嗎？')) return; PAPER.st=null; savePaper(); try{localStorage.removeItem(PKEY);}catch(e){} renderPaper(); };
}
function orderSheet(prefill){
  if(!PAPER.st) return toast('請先建立模擬倉');
  const cur=PAPER.cur, A=PAPER.st[cur];
  openSheet(`<h2 id="sheetTitle" style="margin:0">${cur==='TWD'?'台股':'美股'}模擬下單（買進）</h2>
    <label class="f">代號<input id="oCode" autocomplete="off" placeholder="${cur==='TWD'?'例 2330':'例 AAPL'}"></label>
    <div class="hint" id="oName">&nbsp;</div>
    <div class="grid2">
      <label class="f">停損價（必填）<input type="number" id="oStop" step="any" inputmode="decimal"></label>
      <label class="f">目標價（可不填）<input type="number" id="oTgt" step="any" inputmode="decimal"></label>
    </div>
    <div class="hint" id="oInfo"></div>
    <div id="oChk" style="display:flex;flex-direction:column;gap:4px">${P_REASONS.map(r=>`<label style="display:flex;gap:8px;align-items:flex-start;font-size:14px"><input type="checkbox" data-r="${esc(r)}" style="margin-top:3px"> ${esc(r)}</label>`).join('')}</div>
    <label class="f">為什麼進場？預期去哪裡？<input id="oNote"></label>
    <div class="row" style="justify-content:flex-end"><button id="oCancel">取消</button><button class="pri" id="oSubmit">送出（下一個開盤成交）</button></div>`);
  const info=()=>{
    const code=$('oCode').value.trim().toUpperCase(), px=lastPrice(cur,code), st=+$('oStop').value, tg=+$('oTgt').value;
    $('oName').innerHTML = !code? '&nbsp;' : px==null? `<span class="warn">${cur==='TWD'?'找不到這個台股代號':'美股清單裡沒有這個代號（可請人加到 data/us_symbols.txt）'}</span>`
      : `${esc(cur==='TWD'?nameOf(code):code)}｜最近收盤 ${fmt(px,2)}（${lastDateOf(cur,code)}）`;
    if(px!=null && st>0 && st<px){
      const eq=acctEquity(cur), dist=px-st, q=Math.floor(Math.min(eq*(PAPER.st.risk??1)/100/dist, A.cash/(px*1.002)));
      const cost=(feeIn(cur,q*px)+feeOut(cur,code,q*px))/(q*dist||1);
      $('oInfo').textContent=`以收盤價估：約 ${fmt(q)} 股，停損距離 ${(dist/px*100).toFixed(1)}%，最多虧 ${fmt(q*dist)}（${PAPER.st.risk}%），來回成本約 ${cost.toFixed(2)}R${tg>px?`，盈虧比 ${((tg-px)/dist).toFixed(2)}`:''}。實際用下一個開盤價成交。`;
    } else $('oInfo').textContent='';
  };
  ['oCode','oStop','oTgt'].forEach(id=>$(id).oninput=info);
  if(prefill){ $('oCode').value=prefill; info(); $('oStop').focus(); }
  $('oCancel').onclick=closeSheet;
  $('oSubmit').onclick=()=>{
    const code=$('oCode').value.trim().toUpperCase(), px=lastPrice(cur,code), stop=+$('oStop').value, tgt=$('oTgt').value===''? null : +$('oTgt').value;
    if(!code) return toast('請輸入代號'); if(px==null) return toast('沒有這個代號的行情');
    if(!(stop>0)) return toast('一定要設停損'); if(stop>=px) return toast(`停損要低於最近收盤 ${fmt(px,2)}`);
    if(tgt!=null && !(tgt>px)) return toast(`目標要高於最近收盤 ${fmt(px,2)}`);
    if(A.pos[code] || A.orders.some(o=>o.code===code)) return toast('這檔已經有持倉或掛單');
    const check={}; document.querySelectorAll('#oChk input').forEach(i=>check[i.dataset.r]=i.checked);
    const mkt=mktOf(cur,code);
    A.orders.push({id:'o'+Date.now().toString(36), code, act:'buy', placedAt:Date.now(), placedDate:marketToday(mkt),
      meta:{stop, target:tgt, check, note:$('oNote').value.trim(), refPx:px, rrPlan: tgt!=null? (tgt-px)/(px-stop) : null}});
    savePaper(); closeSheet(); renderPaper(); toast('已掛單，下一個開盤成交');
  };
}
function posSheet(code){
  const cur=PAPER.cur, A=PAPER.st[cur], p=A.pos[code]; if(!p) return;
  const px=lastPrice(cur,code) ?? p.lastC;
  openSheet(`<h2 id="sheetTitle" style="margin:0">${esc(code)} ${esc(cur==='TWD'?nameOf(code):'')}</h2>
    <div class="hint">${fmt(p.qty)} 股 @ ${fmt(p.entry,2)}，最近收盤 ${fmt(px,2)}，原始停損 ${fmt(p.stop0,2)}（R 以原始停損計算）</div>
    <div class="grid2"><label class="f">停損價<input type="number" id="psStop" step="any" value="${p.sl}"></label>
    <label class="f">目標價<input type="number" id="psTgt" step="any" value="${p.tp??''}"></label></div>
    <div class="row" style="justify-content:space-between"><button class="danger" id="psClose">平倉（下一個開盤）</button>
    <div class="row"><button id="psCancel">取消</button><button class="pri" id="psSave">更新停損/目標</button></div></div>`);
  $('psCancel').onclick=closeSheet;
  $('psSave').onclick=()=>{ const s=+$('psStop').value, t=$('psTgt').value===''? null : +$('psTgt').value;
    if(!(s>0) || s>=px) return toast(`停損要低於最近收盤 ${fmt(px,2)}`); if(t!=null && !(t>px)) return toast('目標要高於最近收盤');
    p.sl=s; p.tp=t; savePaper(); closeSheet(); renderPaper(); toast('已更新'); };
  $('psClose').onclick=()=>{ if(A.orders.some(o=>o.code===code&&o.act==='close')) return toast('已經有平倉掛單');
    A.orders.push({id:'o'+Date.now().toString(36), code, act:'close', placedAt:Date.now(), placedDate:marketToday(mktOf(cur,code))});
    savePaper(); closeSheet(); renderPaper(); toast('已掛平倉單，下一個開盤成交'); };
}
document.addEventListener('click',e=>{
  const c=e.target.closest('[data-pcancel]'); if(c){ const A=PAPER.st[PAPER.cur]; A.orders=A.orders.filter(o=>o.id!==c.dataset.pcancel); savePaper(); renderPaper(); return; }
  const s=e.target.closest('[data-skip]'); if(s){ if(!confirm(`確定跳過 ${s.dataset.skip}？這天的停損、目標和成交都不會算。`)) return;
    const A=PAPER.st[PAPER.cur]; A.skips=[...(A.skips||[]), s.dataset.skip]; savePaper(); paperRefresh(true); return; }
  const p=e.target.closest('[data-ppos]'); if(p) return posSheet(p.dataset.ppos);
});
