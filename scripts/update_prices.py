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
BENCH = {"0050": "0050.TW", "0056": "0056.TW", "00646": "00646.TW"}
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


def fetch_prices():
    prices, dates = {}, set()
    rows = get_json("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")
    for r in rows:
        c, p = r.get("Code", ""), num(r.get("ClosingPrice"))
        if CODE_RE.match(c) and p:
            prices[c] = {"n": r.get("Name", "").strip(), "c": p, "m": "上市"}
            dates.add(roc_date(r["Date"]))
    n_twse = len(prices)
    try:
        rows = get_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes")
        for r in rows:
            c, p = r.get("SecuritiesCompanyCode", ""), num(r.get("Close"))
            if CODE_RE.match(c) and p and c not in prices:
                prices[c] = {"n": r.get("CompanyName", "").strip(), "c": p, "m": "上櫃"}
                dates.add(roc_date(r["Date"]))
    except Exception as e:  # 上櫃失敗不影響上市
        print("上櫃資料失敗：", e)
    print(f"上市 {n_twse} 檔，上櫃 {len(prices) - n_twse} 檔，日期 {sorted(dates)}")
    if n_twse < 500:
        raise RuntimeError("上市資料筆數太少，可能抓錯")
    return {"date": max(dates), "updated": int(time.time()), "prices": prices}


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


def save(name, obj):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    ok = 0
    for name, fn in (("prices.json", fetch_prices), ("bench.json", fetch_bench)):
        try:
            save(name, fn())
            ok += 1
        except Exception as e:
            print(f"⚠️ {name} 更新失敗，保留舊檔：{e}")
    if ok == 0 and not os.path.exists(os.path.join(OUT, "prices.json")):
        sys.exit(1)


if __name__ == "__main__":
    main()
