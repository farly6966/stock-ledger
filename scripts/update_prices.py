# -*- coding: utf-8 -*-
"""
每天由 GitHub Actions 執行：抓台股收盤價與比較用 ETF 的含息歷史，寫進 data/
- data/prices.json : 上市（證交所）＋上櫃（櫃買中心）全部股票/ETF 的最新收盤價
- data/bench.json  : 0050 / 0056 / 00646 每日收盤價與含息調整價（Yahoo Finance）
任一來源失敗時保留舊檔，不會把資料清空。
本機測試：python scripts/update_prices.py
"""
import json
import os
import re
import sys
import time
import ssl
import urllib.request
import warnings

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data")
BENCH = {"0050": "0050.TW", "0056": "0056.TW", "00646": "00646.TW", "VOO": "VOO"}
CODE_RE = re.compile(r"^(\d{4}|00\d{2,4}[A-Z]?)$")  # 一般股票 4 碼、ETF 00 開頭


# 證交所憑證缺少某個欄位，Python 3.13 的嚴格模式會拒絕；仍然驗證憑證鏈，只關掉嚴格模式
SSL_CTX = ssl.create_default_context()
SSL_CTX.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (stock-ledger)"})
    with urllib.request.urlopen(req, timeout=40, context=SSL_CTX) as r:
        return json.loads(r.read().decode("utf-8"))


def roc_date(s):
    """民國 1151113 -> 2026-11-13"""
    s = s.strip()
    return f"{int(s[:-4]) + 1911}-{s[-4:-2]}-{s[-2:]}"


def num(x):
    try:
        v = float(str(x).replace(",", ""))
        return v if v > 0 else None
    except ValueError:
        return None


def ohlc(r, keys):
    v = [num(r.get(k)) for k in keys]
    return [round(x, 4) for x in v] if all(v) else None


LIQ = {}  # 今天的成交金額，挑強勢股的候選名單用：{代號: (成交金額, Yahoo代號, 名稱)}


def fetch_prices():
    """最新收盤價（帳本用），同時把當天完整日K存成快照（模擬倉用）。上市、上櫃日期分開記。"""
    prices, dates, snaps = {}, {}, {}
    rows = get_json("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")
    snap = {}
    for r in rows:
        c, p = r.get("Code", ""), num(r.get("ClosingPrice"))
        if CODE_RE.match(c) and p:
            prices[c] = {"n": r.get("Name", "").strip(), "c": p, "m": "上市"}
            LIQ[c] = (num(r.get("TradeValue")) or 0, c + ".TW", prices[c]["n"])
            dates.setdefault("twse", set()).add(roc_date(r["Date"]))
            bar = ohlc(r, ("OpeningPrice", "HighestPrice", "LowestPrice", "ClosingPrice"))
            if bar:
                snap[c] = bar
    if len(dates.get("twse", ())) == 1:
        snaps["twse"] = (next(iter(dates["twse"])), snap)
    n_twse = len(prices)
    try:
        rows = get_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes")
        snap = {}
        for r in rows:
            c, p = r.get("SecuritiesCompanyCode", ""), num(r.get("Close"))
            if CODE_RE.match(c) and p and c not in prices:
                prices[c] = {"n": r.get("CompanyName", "").strip(), "c": p, "m": "上櫃"}
                LIQ[c] = (num(r.get("TransactionAmount")) or 0, c + ".TWO", prices[c]["n"])
                dates.setdefault("tpex", set()).add(roc_date(r["Date"]))
                bar = ohlc(r, ("Open", "High", "Low", "Close"))
                if bar:
                    snap[c] = bar
        if len(dates.get("tpex", ())) == 1:
            snaps["tpex"] = (next(iter(dates["tpex"])), snap)
    except Exception as e:  # 上櫃失敗不影響上市
        print("上櫃資料失敗：", e)
    print(f"上市 {n_twse} 檔，上櫃 {len(prices) - n_twse} 檔，日期 { {k: sorted(v) for k, v in dates.items()} }")
    if n_twse < 500:
        raise RuntimeError("上市資料筆數太少，可能抓錯")
    # 日K快照：檔名用資料裡的日期（不是執行日期），同一天重跑會覆蓋成同樣內容
    for mkt, (d, snap) in snaps.items():
        if len(snap) > 100:
            save(f"daily/{mkt}/{d}.json", snap)
            print(f"快照 {mkt} {d}：{len(snap)} 檔")
    all_dates = [max(v) for v in dates.values()]
    return {"date": max(all_dates), "dates": {k: max(v) for k, v in dates.items()},
            "updated": int(time.time()), "prices": prices}


def write_index():
    idx = {}
    for mkt in ("twse", "tpex"):
        d = os.path.join(OUT, "daily", mkt)
        idx[mkt] = sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json")) if os.path.isdir(d) else []
    save("daily/index.json", idx)


def fetch_us():
    """美股日K：清單在 data/us_symbols.txt。每次重抓一年，漏掉的日子下次自動補回。"""
    import datetime as dt
    import yfinance as yf
    from zoneinfo import ZoneInfo
    path = os.path.join(OUT, "us_symbols.txt")
    syms = [x.strip().upper() for x in open(path, encoding="utf-8") if x.strip() and not x.startswith("#")]
    ny = dt.datetime.now(ZoneInfo("America/New_York"))
    today = ny.strftime("%Y-%m-%d")
    closed = ny.weekday() >= 5 or (ny.hour, ny.minute) >= (16, 30)
    df = yf.download(syms, period="1y", interval="1d", auto_adjust=False, group_by="ticker", progress=False, threads=True)
    out = {}
    for s in syms:
        try:
            d = df[s].dropna(subset=["Open", "High", "Low", "Close"])
        except KeyError:
            continue
        rows = []
        for ts, r in d.iterrows():
            day = ts.strftime("%Y-%m-%d")
            if day == today and not closed:
                continue  # 盤中還沒收完的K棒不要
            rows.append([day] + [round(float(r[k]), 4) for k in ("Open", "High", "Low", "Close")])
        if rows:
            out[s] = rows
    print(f"美股 {len(out)}/{len(syms)} 檔，最後日期 {max(r[-1][0] for r in out.values()) if out else None}")
    if len(out) < len(syms) * 0.8:
        raise RuntimeError("美股抓到的檔數太少")
    return {"updated": int(time.time()), "rows": out}


def fetch_bench():
    import yfinance as yf
    out = {}
    for code, sym in BENCH.items():
        d = yf.Ticker(sym).history(period="max", auto_adjust=False)
        d = d.dropna(subset=["Close", "Adj Close"])
        if len(d) < 100:
            raise RuntimeError(f"{sym} 資料太少")
        rows = [[ts.strftime("%Y-%m-%d"), round(float(r["Close"]), 4), round(float(r["Adj Close"]), 6)]
                for ts, r in d.iterrows()]
        out[code] = {"symbol": sym, "rows": rows}
        print(f"{code}: {len(rows)} 天，{rows[0][0]} ~ {rows[-1][0]}")
    return {"updated": int(time.time()), "bench": out}


US_ETF = {"VOO", "SPY", "QQQ", "VTI", "VT", "SCHD", "VYM", "SOXX", "SMH", "TLT", "GLD", "IWM", "DIA"}
N_TWSE, N_TPEX, TOP = 200, 100, 10


def kt_score(d, L=20):
    """ktshen 強勢分數（同 backtest_rs_tw.py）：
    N = [(C-MA30)+(C-MA45)+(C-MA60)+(MA30-MA45)+(MA30-MA60)+(MA45-MA60)] / ATR60，分數 = 最近 L 天 N 的平均"""
    import numpy as np
    C, H, Lo = d["Close"], d["High"], d["Low"]
    m30, m45, m60 = (C.rolling(n).mean() for n in (30, 45, 60))
    pc = C.shift(1)
    tr = np.maximum(H - Lo, np.maximum((H - pc).abs(), (Lo - pc).abs()))
    atr = tr.rolling(60).mean()
    N = ((C - m30) + (C - m45) + (C - m60) + (m30 - m45) + (m30 - m60) + (m45 - m60)) / atr
    return N.rolling(L).mean()


def bars_of(d, n=250):
    d = d.tail(n)
    return [[ts.strftime("%Y-%m-%d")] + [round(float(r[k]), 4) for k in ("Open", "High", "Low", "Close")] + [int(r["Volume"] or 0)]
            for ts, r in d.iterrows()]


def build_strong():
    """每天挑強勢股：台股取成交金額前 200（上市）+ 前 100（上櫃）的股票，美股用清單裡的個股；
    用一年日K算強勢分數，分數 > 0 的前 10 名連同K線存進 data/strong.json"""
    import yfinance as yf
    if not LIQ:
        raise RuntimeError("沒有今天的成交資料，無法挑候選股")
    stocks = [(c, v) for c, v in LIQ.items() if not c.startswith("00")]
    tw_cand = sorted([x for x in stocks if x[1][1].endswith(".TW")], key=lambda x: -x[1][0])[:N_TWSE] +               sorted([x for x in stocks if x[1][1].endswith(".TWO")], key=lambda x: -x[1][0])[:N_TPEX]
    us_syms = [x.strip().upper() for x in open(os.path.join(OUT, "us_symbols.txt"), encoding="utf-8")
               if x.strip() and not x.startswith("#")]
    us_cand = [s for s in us_syms if s not in US_ETF]

    def rank(cands, index_sym, index_name):
        syms = [y for _, y, _ in cands] + [index_sym]
        df = yf.download(syms, period="1y", interval="1d", auto_adjust=False, group_by="ticker", progress=False, threads=True)
        out = []
        for code, ysym, name in cands:
            try:
                d = df[ysym].dropna(subset=["Open", "High", "Low", "Close"])
            except KeyError:
                continue
            if len(d) < 100:
                continue
            sc = kt_score(d).iloc[-1]
            if sc == sc and sc > 0:  # 不是 NaN 且大於 0
                out.append({"code": code, "name": name, "score": round(float(sc), 3), "date": d.index[-1].strftime("%Y-%m-%d"),
                            "close": round(float(d["Close"].iloc[-1]), 4), "bars": bars_of(d)})
        out.sort(key=lambda x: -x["score"])
        for i, x in enumerate(out):
            x["rank"] = i + 1
        idx = df[index_sym].dropna(subset=["Open", "High", "Low", "Close"])
        ix_score = kt_score(idx).iloc[-1]
        print(f"{index_name}：候選 {len(cands)}，分數>0 的 {len(out)} 檔，前三 {[(x['code'], x['score']) for x in out[:3]]}")
        return {"index": {"code": index_sym, "name": index_name, "score": None if ix_score != ix_score else round(float(ix_score), 3),
                          "bars": bars_of(idx)}, "pool": len(cands), "positive": len(out), "list": out[:TOP]}

    tw = rank([(c, v[1], v[2]) for c, v in tw_cand], "^TWII", "加權指數")
    us = rank([(s, s, s) for s in us_cand], "^GSPC", "S&P 500")
    if len(tw["list"]) < 3:
        raise RuntimeError("台股強勢股太少，可能抓資料失敗")
    return {"updated": int(time.time()), "tw": tw, "us": us}


def save(name, obj):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    ok = 0
    for name, fn in (("prices.json", fetch_prices), ("bench.json", fetch_bench), ("daily/us.json", fetch_us),
                     ("strong.json", build_strong)):
        try:
            save(name, fn())
            ok += 1
        except Exception as e:
            print(f"⚠️ {name} 更新失敗，保留舊檔：{e}")
    write_index()
    if ok == 0 and not os.path.exists(os.path.join(OUT, "prices.json")):
        sys.exit(1)


if __name__ == "__main__":
    main()
