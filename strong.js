"use strict";
// ================= 今日強勢股看盤（大盤＋左右滑動的強勢股K線）=================
const STRONG = { data:null, charts:[], key:null };
const MA_SET = [[30,'#e0a526'],[45,'#3b82c4'],[60,'#9b5fc0']];
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function sma(vals, n){ const out=[]; let s=0; for(let i=0;i<vals.length;i++){ s+=vals[i]; if(i>=n) s-=vals[i-n]; out.push(i>=n-1? s/n : null); } return out; }
async function strongLoad(){
  try{ const r=await fetch('data/strong.json',{cache:'no-cache'}); if(r.ok) STRONG.data=await r.json(); }catch(e){}
  renderStrong(true);
}
function makeChart(el, bars, height){
  if(!window.LightweightCharts){ el.innerHTML='<div class="empty">圖表載入失敗，請檢查網路</div>'; return null; }
  const up=cssVar('--up'), down=cssVar('--down');
  const ch=LightweightCharts.createChart(el,{height, autoSize:true,
    layout:{background:{color:'transparent'}, textColor:cssVar('--mut'), fontSize:11},
    grid:{vertLines:{visible:false}, horzLines:{color:cssVar('--line')}},
    rightPriceScale:{borderVisible:false}, timeScale:{borderVisible:false, rightOffset:3},
    crosshair:{mode:0}, handleScroll:{horzTouchDrag:false, vertTouchDrag:false}, handleScale:{pinch:true, mouseWheel:true}});
  const c=ch.addCandlestickSeries({upColor:up, downColor:down, wickUpColor:up, wickDownColor:down, borderVisible:false, priceLineVisible:false});
  c.setData(bars.map(b=>({time:b[0], open:b[1], high:b[2], low:b[3], close:b[4]})));
  const v=ch.addHistogramSeries({priceScaleId:'vol', priceFormat:{type:'volume'}, lastValueVisible:false, priceLineVisible:false});
  ch.priceScale('vol').applyOptions({scaleMargins:{top:0.8, bottom:0}});
  v.setData(bars.map(b=>({time:b[0], value:b[5], color:(b[4]>=b[1]? up : down)+'66'})));
  const closes=bars.map(b=>b[4]);
  for(const [n,col] of MA_SET){
    const m=sma(closes,n), s=ch.addLineSeries({color:col, lineWidth:1.5, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false});
    s.setData(bars.map((b,i)=>m[i]==null? null : {time:b[0], value:m[i]}).filter(Boolean));
  }
  const n=bars.length; ch.timeScale().setVisibleLogicalRange({from:n-120, to:n+2});
  return ch;
}
function renderStrong(force){
  const box=$('strongBox'); if(!box) return;
  const mk = PAPER.cur==='USD'? 'us' : 'tw', D=STRONG.data?.[mk];
  const key=mk+'|'+(STRONG.data?.updated||0);
  if(!force && key===STRONG.key) return;
  STRONG.key=key; STRONG.charts.forEach(c=>c.remove()); STRONG.charts=[];
  if(!D){ box.innerHTML=`<section class="card"><h2>今日強勢股</h2><div class="empty">${STRONG.data? '今天沒有資料':'讀取中…'}</div></section>`; return; }
  const L=D.list, upd=new Date(STRONG.data.updated*1000).toLocaleString('zh-TW',{hour12:false});
  const legend=MA_SET.map(([n,c])=>`<span style="color:${c}">MA${n}</span>`).join(' ');
  box.innerHTML=`
    <section class="card" style="padding-bottom:6px">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(D.index.name)}</h2><span class="small mut num">${legend}｜強勢分數 ${D.index.score==null?'—':D.index.score.toFixed(1)}</span></div>
      <div id="ixChart" style="height:190px;margin-top:6px"></div>
    </section>
    <section class="card" style="padding-bottom:8px">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">今日強勢股</h2>
        <div class="row" style="gap:4px"><button class="mini" id="stPrev" aria-label="上一檔">‹</button><span class="small mut num" id="stPos">1 / ${L.length}</span><button class="mini" id="stNext" aria-label="下一檔">›</button></div></div>
      <div class="hint">從 ${D.pool} 檔${mk==='tw'?'成交金額最大的股票':'清單個股'}中，強勢分數 > 0 的有 ${D.positive} 檔，列出前 ${L.length} 名。左右滑動切換。</div>
      <div class="scroller" id="stScroll">${L.map((x,i)=>`
        <div class="slide">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <div><span class="tag">#${x.rank}</span> <b>${esc(x.code)}</b> ${esc(mk==='tw'? x.name : '')}</div>
            <div class="small num">分數 <b>${x.score.toFixed(1)}</b></div></div>
          <div class="small mut num">收盤 ${fmt(x.close,2)}（${x.date}）｜${legend}</div>
          <div class="stc" id="stc${i}" style="height:260px;margin-top:4px"></div>
          <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="pri" data-stbuy="${esc(x.code)}">模擬買進 ${esc(x.code)}</button></div>
        </div>`).join('')}</div>
      <div class="dots" id="stDots">${L.map((_,i)=>`<i class="${i?'':'on'}"></i>`).join('')}</div>
      <p class="hint" style="margin:6px 0 0">資料更新：${upd}。強勢分數只是挑「最近比較強」的股票，不代表會繼續漲；你的回測顯示它扣成本後不一定贏大盤，請當成篩選工具。</p>
    </section>`;
  const ix=makeChart($('ixChart'), D.index.bars, 190); if(ix) STRONG.charts.push(ix);
  // 只先畫前兩張，其他滑到時再畫
  const drawn=new Set();
  const draw=i=>{ if(i<0||i>=L.length||drawn.has(i)) return; drawn.add(i); const c=makeChart($('stc'+i), L[i].bars, 260); if(c) STRONG.charts.push(c); };
  draw(0); draw(1);
  const sc=$('stScroll'), dots=[...$('stDots').children];
  const cur=()=>Math.round(sc.scrollLeft/sc.clientWidth);
  sc.addEventListener('scroll',()=>{ const i=cur(); draw(i); draw(i+1); dots.forEach((d,k)=>d.classList.toggle('on',k===i)); $('stPos').textContent=`${i+1} / ${L.length}`; },{passive:true});
  $('stPrev').onclick=()=>sc.scrollTo({left:(cur()-1)*sc.clientWidth, behavior:'smooth'});
  $('stNext').onclick=()=>sc.scrollTo({left:(cur()+1)*sc.clientWidth, behavior:'smooth'});
}
document.addEventListener('click',e=>{ const b=e.target.closest('[data-stbuy]'); if(b) orderSheet(b.dataset.stbuy); });
