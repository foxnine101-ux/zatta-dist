// ==UserScript==
// @name         RO相場自動記録
// @namespace    ro-price-logger
// @version      1.8.0
// @description  RO公式ツールのアイテムページで、取引相場の自動記録・価格推移グラフ・エンチャント素材早引き(相場でコスト計算)と相場予想を行う
// @match        https://rotool.gungho.jp/item/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      workers.dev
// @connect      ragnarokonline.gungho.jp
// @updateURL    https://foxnine101-ux.github.io/zatta-dist/zatta.user.js
// @downloadURL  https://foxnine101-ux.github.io/zatta-dist/zatta.user.js
// ==/UserScript==
(function () {
  'use strict';
  const ENDPOINT = 'https://zatta.foxnine101.workers.dev';
  // 合言葉と端末名は、初回に入力した値を端末(Tampermonkey)に保存して使う。スクリプトには埋め込まない。
  let TOKEN = '', DEVICE = 'pc';
  try { TOKEN = GM_getValue('cfg_key', '') || ''; DEVICE = GM_getValue('cfg_name', '') || 'pc'; } catch (e) { /* 未設定のまま */ }
  function askConfig() {
    const k = prompt('合言葉を入力してください(配布者から教わった文字列)', TOKEN);
    if (k == null) return;
    const n = (prompt('端末の名前(任意。英数字・-・_で20文字まで。空なら pc)', DEVICE) || '').trim();
    TOKEN = k.trim();
    DEVICE = /^[a-z0-9_-]{1,20}$/i.test(n) ? n : 'pc';
    GM_setValue('cfg_key', TOKEN);
    GM_setValue('cfg_name', DEVICE);
  }
  GM_registerMenuCommand('合言葉・名前の設定', () => { askConfig(); toast('設定を保存しました'); });
  if (!TOKEN && !GM_getValue('cfg_asked', false)) { GM_setValue('cfg_asked', true); askConfig(); }
  const KEY = 'log';
  const DEDUPE_MS = 6 * 3600 * 1000; // 同じアイテム・同じ絞り込みはこの時間内なら再記録しない
  const KEEP_SENT_MS = 30 * 86400000; // 送信済みの記録は、この期間を過ぎたら端末から消す
  const WAIT_MS = 15000;             // 価格表の読み込みを待つ最大時間

  const $ = s => document.querySelector(s);
  const num = t => { const m = String(t == null ? '' : t).replace(/,/g, '').match(/\d+/); return m ? +m[0] : null; };
  const load = () => { try { return JSON.parse(GM_getValue(KEY, '[]')); } catch (e) { return []; } };
  const save = a => GM_setValue(KEY, JSON.stringify(a));

  const sum = id => {
    const r = $('#' + id);
    const g = c => { const e = r && r.querySelector('.' + c + ' .money'); return num(e && e.textContent); };
    return { median: g('median_price'), min: g('min_price'), max: g('max_price') };
  };
  const rows = id => [...document.querySelectorAll('#' + id + ' tbody tr')].map(tr => {
    const td = tr.children;
    return { p: num(td[1] && td[1].textContent), n: num(td[2] && td[2].textContent), t: td[3] ? td[3].textContent.trim() : '', map: td[4] ? td[4].textContent.trim() : '' };
  }).filter(r => r.p != null);
  const med = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
    return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
  };
  const chk = c => [...document.getElementsByClassName(c)].filter(e => e.checked).map(e => e.value).join('|');
  const chkLabel = c => [...document.getElementsByClassName(c)].filter(e => e.checked)
    .map(e => ((e.closest('label') || e.parentElement).textContent || e.value).trim()).join(',');
  const kind = (sid, tid) => {
    const s = sum(sid), r = rows(tid);
    return { med: s.median, min: s.min, max: s.max, recent: med(r.slice(0, 20).map(x => x.p)),
             last: r[0] ? r[0].p : null, lastAt: r[0] ? r[0].t : '', lastMap: r[0] ? r[0].map : '' };
  };

  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#36c;color:#fff;padding:8px 12px;border-radius:6px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2500);
  }

  // ---- 価格推移グラフ(概要と一覧の間) + 装備内容(精錬・カード・エンチャント)での絞り込み ----
  // 金額は K / M / G 表記(例: 290M, 22.5G)
  const fmt = n => n >= 1e9 ? +(n / 1e9).toFixed(2) + 'G' : n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  const ts = t => Date.parse(t.replace(' ', 'T') + ':00+09:00');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const RANGES = [['1d', '1日', 1], ['3d', '3日', 3], ['1w', '1週間', 7], ['1m', '1ヶ月', 30], ['3m', '3ヶ月', 90], ['all', '全期間', 0]];
  let range = '1w';
  let forecast = false;
  try { forecast = GM_getValue('chartForecast', false) === true; } catch (e) { /* 既定はオフ */ }
  try { const r = GM_getValue('chartRange', '1w'); if (RANGES.some(x => x[0] === r)) range = r; } catch (e) { /* 既定の1週間 */ }
  const picked = new Set(); // 装備内容の絞り込み(クリックで追加/解除)

  // 取引一覧の先頭セルは <div>超越段階 ★1</div><div>+10 装備名</div><div>カード</div><div>エンチャント</div>… の形(超越段階は無いことも)。
  // 精錬値・超越段階は、ページ本来の「露店取引情報」のボタン(チェックボックス)と連動させる。
  // カード・エンチャント名は、取得済みの一覧をこちらで絞り込む(選ぶとページ側の「カード・エンチャント: あり」も入れる)。
  const tokensOf = tr => [...((tr.children[0] && tr.children[0].children) || [])].map(d => {
    const t = clean(d.textContent);
    let m = t.match(/^超越段階\s*★\s*(\d+)/);
    if (m) return { k: 'grade', v: m[1], label: '★' + m[1] };
    m = t.match(/^\+\s*(\d+)\s/);
    if (m) return { k: 'refine', v: m[1], label: '+' + m[1] };
    return t ? { k: 'card', v: t, label: t } : null;
  });
  const dataRows = id => [...document.querySelectorAll('#' + id + ' tbody tr')];
  const nativeBox = (cls, v) => [...document.getElementsByClassName(cls)].find(i => i.value === String(v));
  const nativeOn = tk => tk.k === 'card' ? picked.has(tk.v) : !!(nativeBox(tk.k === 'refine' ? 'refining_level' : 'grade_level', tk.v) || {}).checked;
  let autoCard = false; // 「カード・エンチャント: あり」を、こちらで入れたかどうか

  function toggleToken(tk) {
    if (tk.k === 'card') {
      if (picked.has(tk.v)) picked.delete(tk.v); else picked.add(tk.v);
      const box = nativeBox('card_flg', 1);
      if (picked.size && box && !box.checked) { box.click(); autoCard = true; return; }
      if (!picked.size && autoCard && box && box.checked) { box.click(); autoCard = false; return; }
      drawChart();
      return;
    }
    const box = nativeBox(tk.k === 'refine' ? 'refining_level' : 'grade_level', tk.v);
    if (box) box.click(); // ページ側が一覧・概要を取り直す → 変化を検知してグラフも描き直す
  }
  function clearAll() {
    picked.clear();
    let n = 0;
    ['refining_level', 'grade_level', 'card_flg'].forEach(c => [...document.getElementsByClassName(c)].forEach(i => { if (i.checked) { i.click(); n++; } }));
    autoCard = false;
    if (!n) drawChart();
  }

  function applyFilter() {
    ['Normal_Coefficient', 'Noatun_Coefficient'].forEach(id => dataRows(id).forEach(tr => {
      const tk = tokensOf(tr);
      tr.style.display = [...picked].every(p => tk.some(x => x && x.k === 'card' && x.v === p)) ? '' : 'none';
      [...((tr.children[0] && tr.children[0].children) || [])].forEach((d, i) => {
        const on = tk[i] && nativeOn(tk[i]);
        d.style.color = on ? '#0a5bd8' : '';
        d.style.fontWeight = on ? 'bold' : '';
        if (tk[i]) d.title = 'クリックでこの内容に絞り込み / 解除';
      });
    }));
  }
  // グラフの点 → 取引一覧の該当行へスクロールして、数秒だけ色を付ける
  let hlRow = null, hlTimer;
  const paint = (tr, color) => { [...tr.children].forEach(td => { td.style.backgroundColor = color; }); };
  function jumpTo(tr) {
    if (!tr || !tr.isConnected) return;
    if (hlRow) paint(hlRow, '');
    hlRow = tr;
    paint(tr, '#fff0a0');
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearTimeout(hlTimer);
    hlTimer = setTimeout(() => { paint(tr, ''); if (hlRow === tr) hlRow = null; }, 6000);
  }

  // ---- 日別の蓄積(使うほど育つ) ----
  // 取引履歴は新しい順に1000件までしか見えないため、日別の中央値・件数を端末と共有DBに貯めて長い履歴に育てる。
  const DAILY_MAX = 800;
  const loadJson = (k) => { try { return JSON.parse(GM_getValue(k, '{}')) || {}; } catch (e) { return {}; } };
  const loadDaily = () => loadJson('daily');
  const dailyKey = (mm, kc) => [mm[1], mm[2] || 0, chk('refining_level'), chk('card_flg'), chk('grade_level'), kc].join('/');
  // days: [{day,cnt,med,min,max}] を保存先にマージ。同じ日は件数が多い方を残し、更新された日を返す
  function mergeDaily(store, key, days) {
    const cur = store[key] || (store[key] = {}), changed = [];
    days.forEach(d => {
      if (!d || !/^\d{4}-\d\d-\d\d$/.test(d.day) || !(d.cnt > 0) || !(d.med > 0)) return;
      const o = cur[d.day];
      if (!o || d.cnt > o[0]) { cur[d.day] = [d.cnt, d.med, d.min, d.max]; changed.push(d); }
    });
    const ks = Object.keys(cur).sort();
    ks.slice(0, Math.max(0, ks.length - DAILY_MAX)).forEach(k => { delete cur[k]; });
    return changed;
  }
  function dailyOf(tid) {
    const rs = rows(tid), by = {};
    rs.forEach(r => { const d = r.t.slice(0, 10); if (/^\d{4}-\d\d-\d\d$/.test(d)) (by[d] = by[d] || []).push(r.p); });
    const days = Object.keys(by).sort();
    if (rs.length >= 1000) days.shift(); // 履歴は新しい順に1000件で切れるので、一番古い日は途中までしかない
    return days.map(day => { const a = by[day]; return { day, cnt: a.length, med: Math.round(med(a)), min: Math.min(...a), max: Math.max(...a) }; });
  }
  const DAILY_KINDS = [['n', 'Normal_Coefficient'], ['a', 'Noatun_Coefficient']];

  // 相場予想: 直近FIT_DAYS日の日別中央値(+この端末に貯めた記録)の対数価格に直線を当てはめ、少し先まで延ばす。
  const FIT_DAYS = 14, DAY = 86400000;
  function makeForecast(all, vis, now) {
    const from = now - FIT_DAYS * DAY;
    const pts = all.filter(r => r.x >= from).map(r => ({ x: r.x, p: r.p }));
    const first = all.length ? Math.min(...all.map(r => r.x)) : now;
    // 絞り込みなしのときだけ、貯めたログ(直近20件中央値)で取引履歴より前の分を補う
    const mm = location.pathname.match(/^\/item\/(\d+)(?:\/(\d+))?/);
    if (mm && !picked.length) {
      const nk = vis && /^Noatun/.test(vis.id) ? 'noatun' : 'normal';
      load().filter(r => r.id === +mm[1] && r.make === +(mm[2] || 0) && r.refine === chk('refining_level') && r.card === chk('card_flg') && r.grade === chk('grade_level'))
        .forEach(r => { const x = Date.parse(r.ts), v = r[nk] && r[nk].recent; if (v > 0 && x >= from && x < first) pts.push({ x, p: v }); });
      const dd = loadDaily()[dailyKey(mm, vis && /^Noatun/.test(vis.id) ? 'a' : 'n')] || {};
      Object.entries(dd).forEach(([day, v]) => { const x = Date.parse(day + 'T12:00:00+09:00'); if (v[1] > 0 && x >= from && x < first) pts.push({ x, p: v[1] }); });
    }
    const bins = {};
    pts.forEach(q => { (bins[Math.floor((q.x + 9 * 3600000) / DAY)] = bins[Math.floor((q.x + 9 * 3600000) / DAY)] || []).push(q); });
    const B = Object.values(bins).map(g => ({ x: g.reduce((a, q) => a + q.x, 0) / g.length, y: Math.log(med(g.map(q => q.p))), w: Math.sqrt(g.length) }));
    if (B.length < 4) return { err: '予想には直近' + FIT_DAYS + '日のうち4日分以上のデータが必要です(今は' + B.length + '日分)' };
    const W = B.reduce((a, q) => a + q.w, 0), mx = B.reduce((a, q) => a + q.w * q.x, 0) / W, my = B.reduce((a, q) => a + q.w * q.y, 0) / W;
    let sxx = 0, sxy = 0;
    B.forEach(q => { sxx += q.w * (q.x - mx) ** 2; sxy += q.w * (q.x - mx) * (q.y - my); });
    const lim = Math.log(1.3) / DAY;   // 1日あたり±30%を上限にして極端な外挿を防ぐ
    const b = sxx ? Math.max(-lim, Math.min(lim, sxy / sxx)) : 0;
    const at = x => my + b * (x - mx);
    const sd = Math.max(0.03, Math.sqrt(B.reduce((a, q) => a + q.w * (q.y - at(q.x)) ** 2, 0) / W));
    const x0 = Math.min(...B.map(q => q.x)), x1 = Math.max(...B.map(q => q.x)), span = Math.max(x1 - x0, DAY);
    const H = Math.max(DAY, Math.min(7 * DAY, span / 3));
    return { at, b, sd, x1, span, H, n: B.length, band: (x) => 1.28 * sd * Math.sqrt(1 + Math.max(0, x - x1) / span) };
  }

  function drawChart() {
    const wrap = document.getElementById('trade_log');
    if (!wrap) return;
    applyFilter();
    let box = document.getElementById('ro-chart');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ro-chart';
      box.style.cssText = 'margin:16px auto;max-width:900px;';
      wrap.parentNode.insertBefore(box, wrap);
    }
    box.textContent = '';
    const vis = [...wrap.children].find(e => getComputedStyle(e).display !== 'none');
    const now = Date.now(), days = RANGES.find(x => x[0] === range)[2];
    const x0 = days ? now - days * 86400000 : 0;
    const all = (vis ? dataRows(vis.id) : []).filter(tr => tr.style.display !== 'none').map(tr => {
      const td = tr.children;
      return { p: num(td[1] && td[1].textContent), n: num(td[2] && td[2].textContent), t: td[3] ? td[3].textContent.trim() : '', map: td[4] ? td[4].textContent.trim() : '', tr };
    }).filter(r => r.p != null).map(r => Object.assign(r, { x: ts(r.t) })).filter(r => isFinite(r.x) && r.p > 0);
    const data = all.filter(r => r.x >= x0).sort((a, b) => a.x - b.x);

    // 見出し・期間ボタン・絞り込みバー
    const cap = document.createElement('div');
    cap.style.cssText = 'text-align:center;font-weight:bold;color:#555;margin-bottom:4px';
    const flt = [['精錬', 'refining_level'], ['カード', 'card_flg'], ['超越', 'grade_level']]
      .map(([n, c]) => { const l = chkLabel(c); return l ? n + ':' + l : ''; }).filter(Boolean).join(' / ');
    cap.textContent = '価格推移(単価・対数軸)' + (flt ? ' [' + flt + ']' : '');
    box.appendChild(cap);

    const bar = document.createElement('div');
    bar.style.cssText = 'text-align:center;margin-bottom:6px';
    RANGES.forEach(([k, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'margin:0 3px;padding:3px 10px;border-radius:14px;cursor:pointer;border:1px solid #3b82c4;' + (k === range ? 'background:#3b82c4;color:#fff' : 'background:#fff;color:#3b82c4');
      b.onclick = () => { range = k; try { GM_setValue('chartRange', k); } catch (e) { /* 保存できなくても動く */ } drawChart(); };
      bar.appendChild(b);
    });
    const fbtn = document.createElement('button');
    fbtn.textContent = '相場予想';
    fbtn.style.cssText = 'margin:0 3px 0 14px;padding:3px 10px;border-radius:14px;cursor:pointer;border:1px solid #e0662b;' + (forecast ? 'background:#e0662b;color:#fff' : 'background:#fff;color:#e0662b');
    fbtn.onclick = () => { forecast = !forecast; try { GM_setValue('chartForecast', forecast); } catch (e) { /* 保存できなくても動く */ } drawChart(); };
    bar.appendChild(fbtn);
    box.appendChild(bar);

    const fb = document.createElement('div');
    fb.style.cssText = 'text-align:center;margin-bottom:6px;font-size:13px';
    const act = [];
    [...document.getElementsByClassName('refining_level')].filter(i => i.checked).forEach(i => act.push('+' + i.value));
    [...document.getElementsByClassName('grade_level')].filter(i => i.checked).forEach(i => act.push('超越' + (i.value === '0' ? 'なし' : '★' + i.value)));
    [...document.getElementsByClassName('card_flg')].filter(i => i.checked).forEach(i => act.push('カード・エンチャント' + (i.value === '1' ? 'あり' : 'なし')));
    picked.forEach(v => act.push(v));
    if (act.length) {
      const lab = document.createElement('span');
      lab.textContent = '絞り込み中: ' + act.join(' + ') + '  ';
      lab.style.color = '#0a5bd8';
      const clr = document.createElement('button');
      clr.textContent = '絞り込み解除';
      clr.style.cssText = 'padding:2px 10px;cursor:pointer;border:1px solid #c33;background:#fff;color:#c33;border-radius:4px';
      clr.onclick = clearAll;
      fb.append(lab, clr);
    } else {
      fb.textContent = '取引一覧の「+10」「超越段階」やカード・エンチャント名をクリックすると、露店取引情報の絞り込みと連動して絞り込めます';
      fb.style.color = '#888';
    }    box.appendChild(fb);

    const sm = document.createElement('div');
    sm.style.cssText = 'text-align:center;font-size:13px;color:#555;margin-bottom:4px';
    const sp = data.map(d => d.p).sort((a, b) => a - b);
    sm.textContent = '該当 ' + data.length + '件' + (data.length ? ' / 中央値 ' + fmt(med(sp)) + ' / 最安 ' + fmt(sp[0]) + ' / 最高 ' + fmt(sp[sp.length - 1]) : '');
    box.appendChild(sm);
    if (data.length < 2) { const m = document.createElement('div'); m.textContent = '期間内に、グラフにできる取引が2件以上ありません(期間を広げてください)'; m.style.cssText = 'text-align:center;color:#888;padding:12px'; box.appendChild(m); return; }

    const W = 900, H = 280, L = 62, R = 14, T = 12, B = 30;
    const fc = forecast ? makeForecast(all, vis, now) : null;
    const fok = fc && !fc.err;
    const xa = days ? x0 : data[0].x, xb0 = days ? now : data[data.length - 1].x, xb = fok ? Math.max(xb0, fc.x1) + fc.H : xb0;
    // 外れ値で縦軸がつぶれないよう、下位2%〜上位98%の価格を軸の範囲にする(範囲外の点は端に張り付く)
    let lo = sp[Math.floor((sp.length - 1) * 0.02)], hi = sp[Math.ceil((sp.length - 1) * 0.98)];
    if (fok) {
      const ends = [Math.exp(fc.at(xb) - fc.band(xb)), Math.exp(fc.at(xb) + fc.band(xb))];
      lo = Math.min(lo, ...ends); hi = Math.max(hi, ...ends);
    }
    if (lo === hi) { lo = lo / 2; hi = hi * 2; }
    const ly = v => Math.log(v);
    const X = v => L + (v - xa) / ((xb - xa) || 1) * (W - L - R);
    const Y = v => T + (1 - (ly(Math.min(hi, Math.max(lo, v))) - ly(lo)) / (ly(hi) - ly(lo))) * (H - T - B);
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', style: 'background:#fff;border:1px solid #ddd;border-radius:6px' }, box);
    const gm = Math.sqrt(lo * hi);
    [lo, gm, hi].forEach(v => {
      el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#e3e3e3' }, svg);
      const tx = el('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#666' }, svg); tx.textContent = fmt(v);
    });
    const dfmt = v => new Date(v + 9 * 3600000).toISOString().slice(days && days <= 3 ? 5 : 2, 16).replace('T', ' ');
    [xa, (xa + xb) / 2, xb].forEach((v, i) => {
      const tx = el('text', { x: X(v), y: H - 10, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle', 'font-size': 11, fill: '#666' }, svg); tx.textContent = dfmt(v);
    });
    data.forEach(d => {
      const c = el('circle', { cx: X(d.x), cy: Y(d.p), r: 2.8, fill: '#3b82c4', 'fill-opacity': 0.5 }, svg);
      // 点は小さくて押しにくいので、見えない大きめの円でクリックを受ける(クリックで一覧の該当行へ移動)
      const hit = el('circle', { cx: X(d.x), cy: Y(d.p), r: 10, fill: 'transparent', style: 'cursor:pointer' }, svg);
      hit.addEventListener('click', () => jumpTo(d.tr));
      hit.addEventListener('mouseenter', () => { c.setAttribute('r', 5); c.setAttribute('fill-opacity', 1); });
      hit.addEventListener('mouseleave', () => { c.setAttribute('r', 2.8); c.setAttribute('fill-opacity', 0.5); });
      const tt = el('title', {}, hit); tt.textContent = fmt(d.p) + 'z × ' + (d.n == null ? '?' : d.n) + '  ' + d.t + '  ' + d.map + '  (クリックで一覧の該当行へ)';
    });
    const win = Math.max(5, Math.round(data.length / 20));
    const pts = data.map((d, i) => { const w = data.slice(Math.max(0, i - win + 1), i + 1).map(q => q.p); return X(d.x) + ',' + Y(med(w)); }).join(' ');
    el('polyline', { points: pts, fill: 'none', stroke: '#e0662b', 'stroke-width': 2 }, svg);
    if (fok) {
      const steps = 24, xs = Array.from({ length: steps + 1 }, (_, i) => fc.x1 + (xb - fc.x1) * i / steps);
      const up = xs.map(x => X(x) + ',' + Y(Math.exp(fc.at(x) + fc.band(x))));
      const dn = xs.map(x => X(x) + ',' + Y(Math.exp(fc.at(x) - fc.band(x)))).reverse();
      el('polygon', { points: up.concat(dn).join(' '), fill: '#e0662b', 'fill-opacity': 0.14 }, svg);
      el('line', { x1: X(xb0), x2: X(xb0), y1: T, y2: H - B, stroke: '#e0662b', 'stroke-dasharray': '3 3', 'stroke-opacity': 0.5 }, svg);
      el('polyline', { points: xs.map(x => X(x) + ',' + Y(Math.exp(fc.at(x)))).join(' '), fill: 'none', stroke: '#e0662b', 'stroke-width': 2, 'stroke-dasharray': '6 4' }, svg);
    }
    const leg = document.createElement('div');
    leg.style.cssText = 'text-align:center;font-size:12px;color:#777;margin-top:2px';
    leg.textContent = '青い点=取引 / オレンジ線=直近' + win + '件の中央値 / 縦軸は下位2%〜上位98%の範囲(日本時間)' + (fok ? ' / 点線=予想と目安の幅' : '');
    box.appendChild(leg);
    if (fc) {
      const fs = document.createElement('div');
      fs.style.cssText = 'text-align:center;font-size:13px;margin-top:4px;color:' + (fok ? '#b8501c' : '#888');
      if (fok) {
        const d = Math.round(fc.H / DAY * 10) / 10, pct = (Math.exp(fc.b * DAY) - 1) * 100;
        fs.textContent = '予想: ' + d + '日後 約' + fmt(Math.exp(fc.at(xb))) + '(目安 ' + fmt(Math.exp(fc.at(xb) - fc.band(xb))) + '〜' + fmt(Math.exp(fc.at(xb) + fc.band(xb))) + ') / 傾向 1日あたり' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% / 直近' + fc.n + '日分から計算。参考値です';
      } else fs.textContent = fc.err;
      box.appendChild(fs);
    }
  }

  let chartTimer;
  const scheduleChart = () => { clearTimeout(chartTimer); chartTimer = setTimeout(drawChart, 150); };
  function startChart() {
    const wrap = document.getElementById('trade_log');
    if (!wrap) return;
    const st = document.createElement('style');
    st.textContent = '#trade_log td:first-child>div:not(:first-child),#trade_log td:first-child>div:first-child{cursor:pointer}#trade_log td:first-child>div:hover{background:#eef5ff}';
    document.head.appendChild(st);
    new MutationObserver(scheduleChart).observe(wrap, { childList: true, subtree: true });
    // 装備内容のクリックで絞り込みを追加/解除
    wrap.addEventListener('click', e => {
      const d = e.target.closest && e.target.closest('td:first-child > div');
      const tr = d && d.closest('tr');
      if (!tr || !tr.closest('tbody')) return;
      const i = [...d.parentElement.children].indexOf(d);
      const tk = tokensOf(tr)[i];
      if (!tk) return;
      toggleToken(tk);
    });
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.parameter-buttons, .parameter-control')) { scheduleChart(); setTimeout(scheduleChart, 800); } }, true);
    scheduleChart();
  }

  // ---- エンチャント素材早引き(アイテム説明欄に組み込み) ----
  const SOURCES = [
    ['スペシャルエンチャント', 'https://ragnarokonline.gungho.jp/gameguide/system/equip-powerup/special-enchant.html'],
    ['ファロスエンチャント', 'https://ragnarokonline.gungho.jp/gameguide/system/equip-powerup/pharos-enchant.html'],
    ['シャドウエンチャント(神秘の館)', 'https://ragnarokonline.gungho.jp/gameguide/system/equip-powerup/house-of-Mysteries'],
    ['天体図書館エンチャント', 'https://ragnarokonline.gungho.jp/gameguide/system/equip-powerup/4th-lib.html'],
    ['タナトスの記憶アクセサリー', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/thanatosmemory-accessories.html'],
    ['フィデスエンチャント', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/fides.html'],
    ['グレイウルフ', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/graywolf.html'],
    ['未知なるブーツ', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/hero_air_crash_boots.html'],
    ['ゲフェン夜間闘技場', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/geffen_night_arena.html'],
    ['雪花', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/snowflower.html'],
    ['グレイシア武器', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/glacier.html'],
    ['星座の塔', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/star.html'],
    ['時計塔地下 未知の空間', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/clock-tower-unknown-space.html'],
    ['時間のサークレット', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/circlet-of-time.html'],
    ['グレイシア防具', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/glacier-armor.html'],
    ['ディムグレイシア武器', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/d-glacier.html'],
    ['ポエニテンティア武器', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/poenitentia.html'],
    ['生命の殿堂', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/hall-of-life.html'],
    ['暴食', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/gluttony.html'],
    ['バイオスフィア', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/biosphere.html'],
    ['ゲオルグ防具', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/gaebolg.html'],
    ['ヨルスキャールヴ', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/yorscalp.html'],
    ['セプルクルム・ホノリス', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/sepulchrum-honoris.html'],
    ['エントワインドマジカル', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/tangled-magic.html'],
    ['特異点 タナトスタワー', 'https://ragnarokonline.gungho.jp/gameguide/system/expand-item/singularity-thanatos-tower.html'],
    ['深淵の回廊', 'https://ragnarokonline.gungho.jp/special/corridor-of-the-abyss/data/']
  ];
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).normalize('NFKC');
  const zen = s => num(String(s).normalize('NFKC'));

  // 毎週火曜0時(日本時間)を過ぎたら、公式ページを取り直す。
  const weekStart = () => {
    const j = new Date(Date.now() + 9 * 3600000);
    return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - (j.getUTCDay() - 2 + 7) % 7) - 9 * 3600000;
  };
  const gmGet = url => new Promise((ok, ng) => GM_xmlhttpRequest({
    method: 'GET', url, timeout: 30000,
    onload: r => r.status === 200 ? ok(r.responseText) : ng(new Error('HTTP ' + r.status)),
    onerror: () => ng(new Error('通信エラー')), ontimeout: () => ng(new Error('タイムアウト'))
  }));

  // 公式ページを「見出し単位のまとまり」に分け、装備名([1]など付きの名前)・素材(「名前 N個」)・本文を取り出す。
  // 表の行の先頭セルに装備名が1つだけある行は、その装備専用の素材(rowMats)として扱う。
  const IDX_VER = 7; // buildEntriesの出力形式を変えたら上げる(古い保存データを自動で取り直す)
  const NAME_RE = /[^\s「」、,]+\[\d\]/g;
  // 「[シャドウ] ○○」のように先頭に[タグ]が付く名前(末尾の[0]などは無いこともある)
  const TAG_RE = /\[[^\]\d\s][^\]\s]*\]\s?[^\s「」、,\[]+(?:\[\d\])?/g;
  const cellMat = t => {
    const m = t.normalize('NFKC').match(/^「?([^「」]+?)」?\s*[x×]?\s*([0-9,]+)\s*個$/);
    if (!m || /\[\d\]$/.test(m[1]) || /^[\d,+\s]+$/.test(m[1]) || m[1].length < 2) return null;
    const q = +m[2].replace(/,/g, '');
    return q > 0 ? { name: m[1].trim(), qty: q } : null;
  };
  const nameKey = n => n.replace(/^[「+]+/, '');
  const namesIn = t => {
    const nt = t.normalize('NFKC'), out = [];
    (nt.match(NAME_RE) || []).forEach(n => out.push(nameKey(n)));
    (nt.match(TAG_RE) || []).forEach(n => out.push(nameKey(n).replace(/\]\s+/, '] ')));
    return out;
  };
  // 条件の表(エンチャント手数料・成功率など)から、素材と条件を読む
  const ruleKey = lb => /手数料/.test(lb) ? '' : /精錬値/.test(lb) ? 'refine' : /超越段階/.test(lb) ? 'grade' : /グレード/.test(lb) ? 'gradeRank' : /成功率/.test(lb) ? 'rate' : /失敗時/.test(lb) ? 'fail' : /上書き/.test(lb) ? 'over' : '';

  function buildEntries(doc, family, pageUrl) {
    const root = doc.querySelector('#main3column') || doc.body;
    const out = []; let h3 = '', h3id = '', h4 = '', intro = '', rules = {}, paras = [], tables = [], gMats = [], rowMats = {}, rowFees = {}, items = new Set(), segs = [];
    const addMat = (arr, m) => { if (m && !arr.some(x => x.name === m.name)) arr.push(m); };
    const flush = () => {
      const base = { fam: family, npc: h3, url: pageUrl + (h3id ? '#' + h3id : ''), title: h4, intro, text: paras.join('\n').slice(0, 1500), tables: tables.slice(0, 12) };
      if (items.size && (paras.length || tables.length)) {
        if (segs.length >= 2) {
          // 見出しの中に「条件の表→対象アイテムの表」の組が複数ある場合は、組ごとに別の項目にする
          segs.forEach(sg => { if (sg.items.size) out.push(Object.assign({}, base, { rules: sg.rules, items: [...sg.items], mats: sg.mats, rowMats: {}, rowFees: {} })); });
        } else out.push(Object.assign({}, base, { rules, items: [...items], mats: gMats, rowMats, rowFees }));
      }
      paras = []; tables = []; gMats = []; rowMats = {}; rowFees = {}; items = new Set(); rules = {}; segs = [];
    };
    root.querySelectorAll('h3,h4,p,table').forEach(e => {
      const tag = e.tagName;
      if (tag === 'H3') { flush(); h3 = clean(e.textContent); h3id = e.id || ''; h4 = ''; intro = ''; }
      else if (tag === 'H4') { if (!h4 && paras.length && !items.size) intro = paras.join('\n').slice(0, 400); flush(); h4 = clean(e.textContent); }
      else if (tag === 'P') {
        if (e.closest('table')) return;
        const t = clean(e.textContent); if (!t) return;
        paras.push(t);
        const nt = t.normalize('NFKC');
        namesIn(t).forEach(n => items.add(n));
        nt.replace(/「([^」]+)」(?:を|×|x)?\s*(?:[0-9]+回につき)?\s*([0-9,]+)\s*個/g, (m, n, q) => { if (!/\[\d\]$/.test(n) && +q.replace(/,/g, '') > 0) addMat(gMats, { name: n, qty: +q.replace(/,/g, '') }); return m; });
      } else {
        const ths = [...e.querySelectorAll('thead th')];
        const name = clean((ths[0] || e.querySelector('th,td') || {}).textContent);
        const rows = [...e.querySelectorAll('tbody tr')].slice(0, 8).map(tr => { const c = [...tr.children].map(x => clean(x.textContent)); return [c[0] || '', (c[1] || '').slice(0, 160)]; });
        tables.push({ name, rule: clean((ths[1] || {}).textContent).slice(0, 120), rows });
        // 入手方法・交換の表(入手できるアイテム | 素材 | 個数 | 手数料)は、行ごとに素材と手数料を読む
        const trs = [...e.querySelectorAll('tr')];
        const hdr = trs.length ? [...trs[0].children].map(x => clean(x.textContent)) : [];
        if (hdr.length >= 2 && /入手できる|アイテム名/.test(hdr[0]) && /個数|手数料/.test(hdr.join(' '))) {
          const headerMat = (hdr.join(' ').match(/「([^」]+)」/) || [])[1] || (h4.match(/「([^」]+)」/) || [])[1] || '';
          const isNum = t => /^[0-9,]+$/.test(t.normalize('NFKC').trim());
          const toNum = t => +t.normalize('NFKC').replace(/,/g, '');
          let lastOut = '';
          trs.slice(1).forEach(tr => {
            const cells = [...tr.children].map(x => clean(x.textContent));
            cells.forEach(cc => namesIn(cc).forEach(n => items.add(n)));
            const nm0 = (cells[0] || '').normalize('NFKC').match(NAME_RE) || [];
            if (!nm0.length) { // 2つ目の素材が次の行(「呪いの象徴」「100」)に書かれている形
              if (cells.length === 2 && isNum(cells[1]) && lastOut && rowMats[lastOut] && cells[0].length >= 2) addMat(rowMats[lastOut], { name: cells[0], qty: toNum(cells[1]) });
              return;
            }
            lastOut = nameKey(nm0[0]);
            const mats = []; let fee = null;
            cells.forEach((t, j) => {
              if (j === 0 || !isNum(t)) return;
              const hj = hdr[j] || '';
              if (/手数料/.test(hj)) fee = toNum(t);
              else if (/個数/.test(hj) && !/入手できる個数/.test(hj)) {
                const prev = cells[j - 1] || '';
                const nm = /素材/.test(hdr[j - 1] || '') && prev && !isNum(prev) ? prev : headerMat;
                if (nm) addMat(mats, { name: nm.replace(/^「|」$/g, ''), qty: toNum(t) });
              }
            });
            if (mats.length) rowMats[lastOut] = mats;
            if (fee != null && mats.length) rowFees[lastOut] = fee;
          });
          return;
        }
        const allRows = trs.map(tr => [...tr.children].map(x => clean(x.textContent)));
        // 「エンチャント手数料」「成功率」の行がある表 = 条件の表。ここから新しい組を始める
        const isRule = allRows.some(r => r.length >= 2 && /手数料|成功率/.test(r[0]));
        let seg = null;
        if (isRule) { seg = { mats: [], rules: {}, items: new Set() }; segs.push(seg); }
        else if (segs.length) seg = segs[segs.length - 1];
        trs.forEach(tr => {
          const cells = [...tr.children].map(x => clean(x.textContent));
          const names0 = (cells[0] || '').normalize('NFKC').match(NAME_RE) || [];
          const mats = cells.map(cellMat).filter(Boolean);
          if (cells.length >= 2) {
            const key = ruleKey(cells[0]), val = cells[1].slice(0, 140);
            if (key && val && !rules[key]) rules[key] = val;
            if (isRule && key && val && !seg.rules[key]) seg.rules[key] = val;
          }
          cells.forEach(c => namesIn(c).forEach(n => { items.add(n); if (seg && !isRule) seg.items.add(n); }));
          if (names0.length === 1 && mats.length) { const k = nameKey(names0[0]); rowMats[k] = rowMats[k] || mats; }
          else mats.forEach(m => { addMat(gMats, m); if (isRule) addMat(seg.mats, m); });
        });
      }
    });
    flush();
    // 手数料がグループごとに書かれていないNPC向けに、同じNPC(見出し)の他グループの素材を持たせる
    const byNpc = {};
    out.forEach(g => { if (g.npc && g.mats.length) byNpc[g.npc] = byNpc[g.npc] || g.mats; });
    out.forEach(g => { g.npcMats = g.mats.length ? [] : (byNpc[g.npc] || []); });
    return out;
  }  async function getIndex(onStatus) {
    let idx = null;
    try { idx = JSON.parse(GM_getValue('enchIdx', 'null')); } catch (e) { /* 壊れていたら取り直す */ }
    if (idx && idx.v === IDX_VER && idx.at >= weekStart()) return idx;
    if (onStatus) onStatus('公式ページから素材情報を取得中…');
    const entries = [], warns = [];
    let next = 0;
    const worker = async () => {
      while (next < SOURCES.length) {
        const [family, url] = SOURCES[next++];
        try {
          const html = await gmGet(url);
          entries.push(...buildEntries(new DOMParser().parseFromString(html, 'text/html'), family, url));
        } catch (e) { warns.push(family + ': ' + e.message); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!entries.length) { if (idx) return idx; throw new Error('公式ページを取得できませんでした'); }
    idx = { v: IDX_VER, at: Date.now(), entries, warns };
    try { GM_setValue('enchIdx', JSON.stringify(idx)); } catch (e) { /* 容量超過でも今回は表示できる */ }
    return idx;
  }

  // 素材の相場: 名前→item_id→直近の取引(単価=price/個数)の中央値。1時間キャッシュ。
  const priceCache = {};
  async function materialPrice(name) {
    const key = norm(name);
    if (priceCache[key]) return priceCache[key];
    const p = (async () => {
      try {
        const sr = await fetch('/item/prediction_conversion_search_name/?item_name=' + encodeURIComponent(name), { credentials: 'omit' }).then(r => r.json());
        const list = Array.isArray(sr) ? sr : [sr];
        const it = list.find(x => x && norm(x.item_name || '') === key);
        if (!it) return { name, none: true };
        const log = await fetch('/item_trade_log_filtered_search/?item_id=' + it.item_id + '&make_flag=' + (it.make_flag || 0), { credentials: 'omit' }).then(r => r.json());
        const unit = (Array.isArray(log) ? log : []).slice(0, 20).map(x => +x.price / (+x.item_count || 1)).filter(v => isFinite(v) && v > 0);
        return { name, id: it.item_id, make: it.make_flag || 0, med: med(unit), n: unit.length };
      } catch (e) { return { name, none: true }; }
    })();
    priceCache[key] = p;
    return p;
  }

  function parseFee(text) {
    const zm = text.normalize('NFKC').match(/([0-9][0-9,]*)\s*(?:ゼニー|zeny|Zeny)/);
    return zm ? +zm[1].replace(/,/g, '') : 0;
  }
  const myName = () => norm(($('h1') || {}).textContent || document.title.split('|')[0]);
  const baseName = s => s.replace(/\[\d\]$/, '');

  // アイテム説明欄と同じセクションに組み込む。グリッドで、1行目=アイコン(左列)、2行目=説明(左列)+素材欄(右列)。
  // 素材欄の上端は説明の上端に揃える(スクロール追従はしない)。
  function enchantBox() {
    let box = document.getElementById('ro-enchant');
    if (box) return box;
    const sec = document.querySelector('article.contents > section.content-wrap');
    if (!sec) return null;
    const fig = sec.querySelector('figure.img-item'), desc = sec.querySelector('.description');
    const narrow = innerWidth <= 760;
    sec.style.display = 'grid';
    sec.style.gridTemplateColumns = narrow ? 'max-content minmax(0,1fr)' : 'max-content minmax(300px,440px)';
    sec.style.justifyContent = 'center';
    sec.style.alignItems = 'start';
    sec.style.columnGap = narrow ? '8px' : '28px';
    if (fig) { fig.style.gridArea = '1 / 1'; fig.style.justifySelf = 'center'; }
    if (desc) desc.style.gridArea = '2 / 1';
    const st = document.createElement('style');
    st.textContent = '#ro-enchant{grid-area:2 / 2;min-width:0;box-sizing:border-box;background:#fff;padding:8px 14px 12px}'
      + '@media (max-width:760px){#ro-enchant{padding:4px 6px 8px;font-size:11px}#ro-enchant h3{font-size:13px}#ro-enchant td{font-size:11px;padding:2px 2px}#ro-enchant td:nth-child(3){display:none}}'
      + '#ro-enchant table{width:100%;border-collapse:collapse}#ro-enchant td{padding:2px 4px;border-bottom:1px solid #e5e5e5;font-size:13px}#ro-enchant td:not(:first-child){text-align:right;white-space:nowrap}';
    document.head.appendChild(st);
    box = document.createElement('div');
    box.id = 'ro-enchant';
    const h = document.createElement('h3');
    h.className = 'section-ttl_mini';
    h.textContent = 'エンチャント素材';
    const body = document.createElement('div');
    body.id = 'ro-enchant-body';
    box.append(h, body);
    sec.appendChild(box);
    return box;
  }
  const dropEnchantBox = () => {
    const box = document.getElementById('ro-enchant');
    if (!box) return;
    const sec = box.parentElement;
    box.remove();
    ['display', 'gridTemplateColumns', 'justifyContent', 'alignItems', 'columnGap'].forEach(k => { sec.style[k] = ''; });
    sec.querySelectorAll('figure.img-item,.description').forEach(e => { e.style.gridArea = ''; e.style.justifySelf = ''; });
  };
  const yen = v => v == null ? '-' : (innerWidth <= 760 ? fmt(v) : Math.round(v).toLocaleString()) + 'z';

  async function showEnchant() {
    const me = myName(), mb = baseName(me);
    let idx;
    try { idx = await getIndex(null); } catch (e) { return; }
    const hits = idx.entries.filter(e => e.items.some(n => { const nn = norm(n); return nn === me || (/\[\d\]$/.test(nn) ? !/\[\d\]$/.test(me) && baseName(nn) === mb : nn === mb); }))
      // 「シリーズとは?」のような、素材も条件も書かれていないまとまりは出さない
      .filter(e => (e.mats || []).length || (e.npcMats || []).length || Object.keys(e.rowMats || {}).length || Object.keys(e.rules || {}).length);
    if (!hits.length) return; // 該当なしなら、元のレイアウトのまま何も足さない
    const box = enchantBox();
    if (!box) return;
    const body = box.querySelector('#ro-enchant-body');
    body.textContent = '';
    for (const h of hits.slice(0, 8)) {
      const sec = document.createElement('div');
      sec.style.cssText = 'border-top:1px solid #ddd;padding:8px 0';
      const t = document.createElement('div');
      t.style.fontWeight = 'bold';
      t.textContent = h.fam + ' / ' + (h.title || h.npc);
      sec.appendChild(t);
      { // NPC名(なければ種類名)を、公式ゲームガイドの該当箇所へのリンクにする
        const n = document.createElement('div'); n.style.fontSize = '12px';
        const a = document.createElement('a'); a.href = h.url || '#'; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = h.npc || h.fam; a.title = '公式ゲームガイドの該当箇所を別タブで開く';
        n.appendChild(a); sec.appendChild(n);
      }
      // 大事な条件だけ表示(超越・精錬値・成功率・失敗時・上書き)
      const R = h.rules || {};
      const rl = [['超越', R.grade], ['グレード', R.gradeRank], ['精錬', R.refine], ['成功率', R.rate], ['失敗時', R.fail], ['上書き', R.over]].filter(x => x[1]);
      rl.forEach(([k, v]) => {
        const r = document.createElement('div'); r.style.cssText = 'font-size:12px;margin:1px 0';
        const b = document.createElement('b'); b.textContent = k + ': '; b.style.color = '#555';
        const none = /^[-ー―－]+$/.test(v.trim()); // 公式の表で「-」=制限なし/失敗なし
        const val = document.createElement('span'); val.textContent = none ? (k === '失敗時' ? 'なし' : '制限なし') : v.replace(/\s+/g, ' ');
        if (k === '失敗時' && /消滅|消失|破壊|壊/.test(v)) { val.style.cssText = 'color:#c22;font-weight:bold'; }
        r.append(b, val); sec.appendChild(r);
      });
      const shown = h.text || h.intro || '';
      if (shown) { // 公式の説明文は、気になる人だけ開く
        const dt = document.createElement('details'); dt.style.cssText = 'font-size:11px;color:#777;margin:2px 0';
        const sm = document.createElement('summary'); sm.textContent = '公式の説明';
        const tx = document.createElement('div'); tx.style.whiteSpace = 'pre-wrap'; tx.textContent = shown.length > 400 ? shown.slice(0, 400) + '…' : shown;
        dt.append(sm, tx); sec.appendChild(dt);
      }      const key = Object.keys(h.rowMats || {}).find(k => norm(k) === me);
      let mats = (key && h.rowMats[key]) || h.mats || [];
      const ref = !mats.length && (h.npcMats || []).length > 0;
      if (ref) mats = h.npcMats;
      const fee = key && h.rowFees && h.rowFees[key] != null ? h.rowFees[key] : parseFee(h.text);
      if (mats.length) {
        const tbl = document.createElement('table');
        sec.appendChild(tbl);
        const total = document.createElement('div');
        total.style.cssText = 'font-weight:bold;margin-top:4px';
        total.textContent = '材料合計: 計算中…';
        sec.appendChild(total);
        Promise.all(mats.map(m => materialPrice(m.name))).then(ps => {
          let sumv = fee, unknown = 0;
          ps.forEach((p, i) => {
            const m = mats[i], tr = document.createElement('tr');
            const sub = p.med == null ? null : p.med * m.qty;
            if (sub == null) unknown++; else sumv += sub;
            [m.name, '×' + m.qty, p.med == null ? (p.none ? '取引なし' : '-') : yen(p.med), yen(sub)].forEach((v, k) => {
              const td = document.createElement('td');
              if (k === 0 && p.id != null) {
                // 素材名から、その素材のアイテムページを別タブで開く
                const a = document.createElement('a');
                a.href = '/item/' + p.id + '/' + (p.make || 0) + '/';
                a.target = '_blank'; a.rel = 'noopener';
                a.textContent = v;
                td.appendChild(a);
              } else td.textContent = v;
              tr.appendChild(td);
            });
            tbl.appendChild(tr);
          });
          total.textContent = '材料合計: ' + yen(sumv) + (fee ? '(手数料 ' + yen(fee) + ' 含む)' : '') + (unknown ? ' ※相場なし' + unknown + '種は除く' : '');
        });
      } else {
        const n = document.createElement('div'); n.style.cssText = 'font-size:12px;color:#a60'; n.textContent = '公式ページに素材の記載が見つかりませんでした。公式ゲームガイドで確認してください。'; sec.appendChild(n);
      }
      const mine = h.tables.find(x => norm(x.name) === me) || h.tables.find(x => baseName(norm(x.name)) === mb);
      if (mine) {
        const d = document.createElement('details'); d.style.cssText = 'font-size:12px;margin-top:4px';
        const s = document.createElement('summary'); s.textContent = '効果の候補'; d.appendChild(s);
        if (mine.rule) { const r = document.createElement('div'); r.textContent = mine.rule; d.appendChild(r); }
        mine.rows.forEach(rw => { const r = document.createElement('div'); r.textContent = rw[0] + (rw[1] ? ': ' + rw[1] : ''); r.style.marginTop = '2px'; d.appendChild(r); });
        sec.appendChild(d);
      }
      body.appendChild(sec);
    }
    const foot = document.createElement('div');
    foot.style.cssText = 'font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:4px';
    foot.textContent = '公式ゲームガイドの文章から自動で抜き出しています。相場は直近20件の中央値。必ず公式の説明も確認してください。';
    body.appendChild(foot);
  }

  GM_registerMenuCommand('素材情報を取り直す', () => { GM_setValue('enchIdx', 'null'); dropEnchantBox(); showEnchant(); toast('素材情報を取り直します'); });

  // ---- CSV・メニュー ----
  function csv() {
    const H = ['記録日時', 'アイテムID', 'make_flag', 'アイテム名', '精錬', 'カード', '超越',
      '通常_中央値(全期間)', '通常_最低', '通常_最高', '通常_直近20件中央値', '通常_最新価格', '通常_最新日時', '通常_最新MAP',
      'Noatun_中央値(全期間)', 'Noatun_最低', 'Noatun_最高', 'Noatun_直近20件中央値', 'Noatun_最新価格', 'Noatun_最新日時', 'Noatun_最新MAP'];
    const L = load().map(r => [r.ts, r.id, r.make, r.name, r.refine, r.card, r.grade,
      r.normal.med, r.normal.min, r.normal.max, r.normal.recent, r.normal.last, r.normal.lastAt, r.normal.lastMap,
      r.noatun.med, r.noatun.min, r.noatun.max, r.noatun.recent, r.noatun.last, r.noatun.lastAt, r.noatun.lastMap]);
    return '﻿' + [H].concat(L).map(a => a.map(v => '"' + (v == null ? '' : String(v)).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  }

  GM_registerMenuCommand('CSVをダウンロード', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv()], { type: 'text/csv;charset=utf-8' }));
    a.download = 'ro_price_log_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });
  GM_registerMenuCommand('CSVをクリップボードにコピー', () => { GM_setClipboard(csv()); toast('コピーしました(' + load().length + '件)'); });
  GM_registerMenuCommand('記録件数を表示', () => toast('記録 ' + load().length + ' 件'));
  GM_registerMenuCommand('記録を全削除', () => { if (confirm('この端末の記録を全て削除しますか?')) { save([]); toast('削除しました'); } });

  const m = location.pathname.match(/^\/item\/(\d+)(?:\/(\d+))?/);
  if (!m) return;

  function record() {
    const name = (($('h1') || {}).textContent || document.title.split('|')[0]).trim();
    const rec = { ts: new Date().toISOString(), id: +m[1], make: +(m[2] || 0), name: name,
      refine: chk('refining_level'), card: chk('card_flg'), grade: chk('grade_level'),
      normal: kind('Normal_Coefficient_Summary', 'Normal_Coefficient'),
      noatun: kind('Noatun_Coefficient_Summary', 'Noatun_Coefficient') };
    const all = load().filter(r => !r.sent || Date.now() - Date.parse(r.ts) < KEEP_SENT_MS);
    const dup = all.some(r => r.id === rec.id && r.make === rec.make && r.refine === rec.refine && r.card === rec.card && r.grade === rec.grade
      && Date.now() - Date.parse(r.ts) < DEDUPE_MS);
    if (dup) return;
    rec.device = DEVICE;
    all.push(rec); save(all);
    toast('相場を記録しました(累計 ' + all.length + ' 件)');
    sync();
  }

  // 未送信分をCloudflareへ送る。失敗しても端末側に残り、次回のページ表示で再送する。
  function sync() {
    if (!TOKEN) return;
    const all = load(), pending = all.filter(r => !r.sent);
    if (!pending.length) return;
    GM_xmlhttpRequest({
      method: 'POST', url: ENDPOINT.replace(/\/$/, '') + '/log',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      data: JSON.stringify(pending),
      onload: res => {
        if (res.status !== 200) return toast('同期失敗 ' + res.status);
        const sentTs = new Set(pending.map(r => r.ts));
        save(load().map(r => sentTs.has(r.ts) ? Object.assign(r, { sent: true }) : r));
      },
      onerror: () => toast('同期失敗(通信エラー)')
    });
  }
  GM_registerMenuCommand('今すぐ同期', () => { sync(); toast('同期を実行しました'); });

  // 開いたページの日別データを端末に貯め、新しい日・件数が増えた日だけ共有DBへ送る
  function harvest() {
    const canSend = !!TOKEN;
    const store = loadDaily(), sent = loadJson('dailySent'), up = [];
    DAILY_KINDS.forEach(([kc, tid]) => {
      const key = dailyKey(m, kc), mine = dailyOf(tid);
      mergeDaily(store, key, mine);
      mine.forEach(d => {
        if ((sent[key + '/' + d.day] || 0) < d.cnt && store[key][d.day][0] === d.cnt)
          up.push({ id: +m[1], make: +(m[2] || 0), refine: chk('refining_level'), card: chk('card_flg'), grade: chk('grade_level'), kind: kc, day: d.day, cnt: d.cnt, med: d.med, min: d.min, max: d.max });
      });
    });
    GM_setValue('daily', JSON.stringify(store));
    for (let i = 0; canSend && i < up.length; i += 400) {
      const part = up.slice(i, i + 400);
      GM_xmlhttpRequest({
        method: 'POST', url: ENDPOINT.replace(/\/$/, '') + '/daily',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
        data: JSON.stringify(part),
        onload: res => {
          if (res.status !== 200) return;
          const s2 = loadJson('dailySent');
          part.forEach(r => { s2[[r.id, r.make, r.refine, r.card, r.grade, r.kind].join('/') + '/' + r.day] = r.cnt; });
          GM_setValue('dailySent', JSON.stringify(s2));
        },
        onerror: () => { /* 次回のページ表示で再送する */ }
      });
    }
  }

  // 他の人が貯めた日別データを取り込む(使う人が増えるほど履歴が育つ)
  function pullDaily() {
    if (!TOKEN) return;
    DAILY_KINDS.forEach(([kc]) => {
      const key = dailyKey(m, kc);
      const q = ['item=' + m[1], 'make=' + (m[2] || 0), 'refine=' + encodeURIComponent(chk('refining_level')), 'card=' + encodeURIComponent(chk('card_flg')),
        'grade=' + encodeURIComponent(chk('grade_level')), 'kind=' + kc].join('&');
      GM_xmlhttpRequest({
        method: 'GET', url: ENDPOINT.replace(/\/$/, '') + '/daily?' + q,
        headers: { 'Authorization': 'Bearer ' + TOKEN },
        onload: res => {
          if (res.status !== 200) return;
          let j; try { j = JSON.parse(res.responseText); } catch (e) { return; }
          const store = loadDaily(), sent = loadJson('dailySent');
          const ch = mergeDaily(store, key, Array.isArray(j.days) ? j.days : []);
          if (!ch.length) return;
          ch.forEach(d => { sent[key + '/' + d.day] = d.cnt; });   // 受け取った分は送り返さない
          GM_setValue('daily', JSON.stringify(store));
          GM_setValue('dailySent', JSON.stringify(sent));
          scheduleChart();
        },
        onerror: () => { /* 取り込めなくても動く */ }
      });
    });
  }
  GM_registerMenuCommand('日別の蓄積を表示', () => {
    const st = loadDaily(), ks = Object.keys(st);
    toast('日別データ ' + ks.length + '種類 / 合計 ' + ks.reduce((a, k) => a + Object.keys(st[k]).length, 0) + '日分');
  });

  // 価格表は非同期で描画されるため、行が出るまで待つ。取引が1件もないアイテムは時間切れで空のまま記録する。
  const t0 = Date.now();
  const timer = setInterval(() => {
    const ready = document.querySelector('#Normal_Coefficient tbody tr, #Noatun_Coefficient tbody tr');
    if (ready || Date.now() - t0 > WAIT_MS) { clearInterval(timer); startChart(); record(); harvest(); pullDaily(); }
  }, 500);
  showEnchant();
})();












