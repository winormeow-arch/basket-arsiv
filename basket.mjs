// Mackolik Basketbol Arşivi 1.0 — GitHub Actions sürümü (Node 20+, ek paket yok)
// İddaa'da oranı açılan basketbol maçları · maç önü oranlar + periyot (çeyrek) skorları
//
// MOD=test   : ÖNCE BUNU ÇALIŞTIR — birkaç günü dener, debug/ içine teşhis yazar, veriye dokunmaz
// MOD=guncel : son günleri günceller
// MOD=gecmis : 5 yıllık geçmişin kendi parçasını tarar (PARCA / PARCA_SAYI)
// MOD=csv    : cikti/ içine CSV üretir
//
// Ayrı depo: basket-arsiv (futbol deposundan bağımsız)
// Veri: data/maclar/YYYY/MM/YYYY-MM-DD.json

import fs from 'node:fs/promises';
import path from 'node:path';

const KOK = process.cwd();
const VERI = path.join(KOK, 'data');
const CIKTI = path.join(KOK, 'cikti');
const DEBUG = path.join(KOK, 'debug');
const BASE = 'https://arsiv.mackolik.com';

const MOD = (process.env.MOD || 'guncel').trim();
const BUTCE_DK = +process.env.BUTCE_DK || 45;
const YIL = +process.env.YIL || 5;
const PARALEL = +process.env.PARALEL || 4;
const BEKLE = +process.env.BEKLE || 150;
const SON_GUN = +process.env.SON_GUN || 3;
const ANKRAJ = process.env.ANKRAJ || '2026-09-27';
const PARCA = +process.env.PARCA || 0;
const PARCA_SAYI = +process.env.PARCA_SAYI || 1;
// Maç listesinde sporu gösteren alan (futbolda r[23] === 1). Test raporuna göre ayarlanır.
const SPOR_ALAN = +(process.env.SPOR_ALAN || 23);
const SPOR_DEGER = String(process.env.SPOR_DEGER || '2');
const LISTE_EK = process.env.LISTE_EK || '';
const BITIS = Date.now() + BUTCE_DK * 60000;
const zamanBitti = () => Date.now() > BITIS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ==================================================================
   0) Yardımcılar
   ================================================================== */
const sade = s => (s || '')
  .replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase()
  .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
  .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
  .replace(/\s+/g, ' ').trim();

const entity = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));

function tokenlar(html) {
  return entity(html
    .replace(/<script[\s\S]*?<\/script>/gi, '|')
    .replace(/<style[\s\S]*?<\/style>/gi, '|')
    .replace(/<[^>]+>/g, '|'))
    .split('|').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const topla = x => x.reduce((s, v) => s + v, 0);
const nf = v => +String(v).replace(',', '.');
const skorCoz = s => { const p = (s || '').split('-').map(Number); return (p.length === 2 && !p.some(isNaN)) ? p : null; };

const gun = d => d.toISOString().slice(0, 10);
const trBugun = () => gun(new Date(Date.now() + 3 * 3600e3));
const gunEkle = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return gun(d); };
const mk = s => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const trTarih = s => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };

/* ==================================================================
   1) HTTP — futbol toplayıcısıyla aynı, zorlanınca yavaşlar
   ================================================================== */
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate',
  'Referer': BASE + '/Canli-Sonuclar'
};
class KaliciHata extends Error {}

function metinCoz(buf, ct) {
  let cs = ((ct || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4000).toString('latin1').match(/charset=["']?([\w-]+)/i) || [])[1];
  cs = (cs || 'utf-8').toLowerCase();
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

let ardHata = 0, engel = false, ekBekle = 0, istekSay = 0;
let aktif = Math.min(PARALEL, 3), seri = 0, sonDusus = 0;
const basari = () => { ardHata = 0; ekBekle = Math.max(0, ekBekle * 0.5 - 100); if (++seri >= 5 && aktif < PARALEL) { aktif++; seri = 0; } };
const zorlandi = ms => {
  seri = 0;
  ekBekle = Math.min(ekBekle + ms, 2500);
  if (Date.now() - sonDusus > 8000 && aktif > 2) { aktif--; sonDusus = Date.now(); }
};
async function getir(url, deneme = 3, zamanAsimi = 20000) {
  let son = null;
  for (let i = 1; i <= deneme; i++) {
    try {
      istekSay++;
      const r = await fetch(url, { headers: HDR, redirect: 'follow', signal: AbortSignal.timeout(zamanAsimi) });
      if (r.status === 200) {
        const buf = Buffer.from(await r.arrayBuffer());
        basari();
        return metinCoz(buf, r.headers.get('content-type'));
      }
      if (r.status === 404 || r.status === 410) throw new KaliciHata('HTTP ' + r.status);
      son = new Error('HTTP ' + r.status);
      if (r.status === 429 || r.status >= 500) zorlandi(1000);
      if (i < deneme) await sleep(r.status === 429 || r.status === 503 ? 3000 * i : 800 * i);
    } catch (e) {
      if (e instanceof KaliciHata) throw e;
      son = e;
      zorlandi(400);
      if (i < deneme) await sleep(800 * i);
    }
  }
  if (++ardHata >= 30) engel = true;
  throw son || new Error('istek başarısız');
}

/* ==================================================================
   2) Günün maç listesi (livedata) → sadece basketbol
   ================================================================== */
const LISTE_URL = [
  d => `https://vd.mackolik.com/livedata?date=${d}`,
  d => `https://goapi.mackolik.com/livedata?date=${d}`,
  d => `http://goapi.mackolik.com/livedata?date=${d}`
];
async function listeJson(tarih, durum, ek = LISTE_EK) {
  const d = mk(tarih);
  const sira = [durum.listeUrl || 0, 0, 1, 2].filter((v, i, a) => a.indexOf(v) === i);
  let hata = '';
  for (const k of sira) {
    try {
      const txt = await getir(LISTE_URL[k](d) + ek, 3);
      const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
      const json = JSON.parse(txt.slice(a, b + 1));
      durum.listeUrl = k;
      return (Array.isArray(json.m) ? json.m : []).filter(Array.isArray);
    } catch (e) { hata = e.message; }
  }
  throw new Error('maç listesi alınamadı: ' + hata);
}

const hamLig = r => Array.isArray(r[36]) ? r[36].filter(v => typeof v === 'string').join(' | ') : '';
const okunurAd = p => { const a = (p[0] || '').trim(), b = (p[1] || '').trim(); return b && !/^\d{4}/.test(b) ? `${a} - ${b}` : a; };
const okunurLig = r => Array.isArray(r[36]) ? okunurAd(r[36].filter(v => typeof v === 'string')) : '';
const basketMi = r => String(r[SPOR_ALAN]) === SPOR_DEGER;
const iddaaKodlu = r => typeof r[14] === 'number' && r[14] > 0;
const SEZON_AY = new Set([1, 2, 3, 4, 5, 10, 11, 12]);

function aday(r) {
  const h = String(r[29] ?? ''), a = String(r[30] ?? '');
  return {
    id: String(r[0]), lig: okunurLig(r) || hamLig(r) || '?', ligHam: hamLig(r),
    ev: typeof r[2] === 'string' ? r[2] : '',
    dep: typeof r[4] === 'string' ? r[4] : '',
    saat: typeof r[16] === 'string' && /^\d{1,2}:\d{2}$/.test(r[16]) ? r[16] : '',
    kod: iddaaKodlu(r) ? String(r[14]) : '',
    ms: /^\d+$/.test(h) && /^\d+$/.test(a) ? h + '-' + a : '',
    iy: typeof r[7] === 'string' && /^\d{1,3}\s*-\s*\d{1,3}$/.test(r[7]) ? r[7].replace(/\s/g, '') : ''
  };
}

async function gunListesi(tarih, durum) {
  const rows = await listeJson(tarih, durum);
  const b = rows.filter(basketMi).filter(r => /^\d+$/.test(String(r[0])));
  // Sezon içinde kalabalık bir listede hiç basketbol yoksa ayar yanlıştır: boş gün diye kaydetme
  if (!b.length && rows.length > 100 && SEZON_AY.has(+tarih.slice(5, 7)))
    throw new Error(`listede ${rows.length} maç var ama hiç basketbol yok (SPOR_ALAN/SPOR_DEGER ayarı?)`);
  const kodPay = b.length ? b.filter(iddaaKodlu).length / b.length : 0;
  const kodFiltre = kodPay > 0.02;   // İddaa kodu hiç yoksa bu alan basketbolda farklıdır, eleme yapma
  return b.filter(r => !kodFiltre || iddaaKodlu(r)).map(aday);
}

/* ==================================================================
   3) Maç sayfası → oranlar + periyot skorları + MBS
   ================================================================== */
// Basketbol maç sayfası: /Basket-Mac/{id}/{Ev-Dep}
const slug = s => sade(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const MAC_YOL = [
  a => `/Basket-Mac/${a.id}/${slug(a.ev + ' ' + a.dep) || 'mac'}`,
  a => `/Basket-Mac/${a.id}`,
  a => `/Basket-Mac/${a.id}/mac`
];
let yolSira = 0;

// Sayfa gerçekten bu maça mı ait? (aynı id başka spordan bir maça denk gelebilir)
function sayfaUygun(html, a) {
  const ev = sade(a.ev).slice(0, 6);
  if (!ev) return /openOddsDialog/.test(html);
  const bas = (html.match(/<title>([\s\S]*?)<\/title>/i) || ['', ''])[1];
  return sade(entity(bas || html.slice(0, 20000))).includes(ev);
}
async function macGetir(a) {
  for (let n = 0; n < MAC_YOL.length; n++) {
    const k = (yolSira + n) % MAC_YOL.length;
    let html;
    try { html = await getir(BASE + MAC_YOL[k](a), 2, 10000); }
    catch (e) { if (e instanceof KaliciHata) continue; return null; }
    if (sayfaUygun(html, a)) { yolSira = k; return html; }
  }
  return null;
}

const MBS_DESEN = [
  /data-mbs=["']?([1-4])/i,
  /["']?mbs["']?\s*[:=]\s*["']?([1-4])\b/i,
  /mbs[_\-]?([1-4])\.(?:png|gif|jpe?g|svg|webp)/i,
  /class=["'][^"']*\bmbs[_\-]?([1-4])\b/i,
  /\bMBS\b\s*(?:<[^>]*>\s*){0,4}[:=]?\s*(?:<[^>]*>\s*){0,4}([1-4])\b/i
];
const mbsBul = html => { for (const p of MBS_DESEN) { const m = html.match(p); if (m) return m[1]; } return ''; };

// [p1,p2,p3,p4,(uzatma),(toplam)] ya da [toplam,p1,...] dizisinden periyotları ayıklar
function diziCoz(n, hedef) {
  for (let k = Math.min(n.length, 7); k >= 4; k--) {
    if (topla(n.slice(0, k)) === hedef) return n.slice(0, k);
    if (n[0] === hedef && k + 1 <= n.length && topla(n.slice(1, k + 1)) === hedef) return n.slice(1, k + 1);
  }
  return null;
}
// [periyot, kümülatif] çiftleri tutarlı mı ve son kümülatif skora eşit mi
// Skor listede normal süre skoru olarak da gelebilir (uzatmalı maçlarda): 4. periyot sonu da kabul
const kumTamam = (c, hedef) => c.length >= 4 && c.every((x, i) => x[1] === (i ? c[i - 1][1] : 0) + x[0]) &&
  (c[c.length - 1][1] === hedef || c[3][1] === hedef);
function periyotTablo(duz, s) {
  const bas = /(?:^|\s)1P\s+\d{1,3}\s+\d{1,3}/g;
  let m;
  while ((m = bas.exec(duz))) {
    const z = /\s*(?:[1-9]P|\d?U[ZT]*\d?|OT\d?|Uzatma\s*\d?)\s+(\d{1,3})\s+(\d{1,3})(?=\s|$)/iy;
    z.lastIndex = m.index;
    const ev = [];
    let son = m.index, x;
    while ((x = z.exec(duz))) { ev.push([+x[1], +x[2]]); son = z.lastIndex; }
    if (!kumTamam(ev, s[0])) continue;
    const n = (duz.slice(son, son + 400).match(/\d{1,3}/g) || []).map(Number);
    const k = ev.length;
    for (let o = 0; o + 2 * k <= n.length && o < 15; o++) {
      const dep = Array.from({ length: k }, (_, i) => [n[o + 2 * i], n[o + 2 * i + 1]]);
      if (kumTamam(dep, s[1])) return ev.map((e, i) => [e[0], dep[i][0]]);
    }
  }
  return null;
}
const hucreMetin = c => entity(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const satirlar = t => [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => m[0]);
const hucreler = tr => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
const tabloAl = (html, desen) => { const i = html.search(desen); if (i < 0) return ''; const j = html.indexOf('</table>', i); return j < 0 ? '' : html.slice(i, j); };

// <table class="tbl-period-scores">: her hücrede periyot skoru + kümülatif skor
function periyotHtml(html, s) {
  const t = tabloAl(html, /<table[^>]*class="tbl-period-scores"/i);
  if (!t) return null;
  const takim = satirlar(t).map(tr => hucreler(tr).filter(c => !/team-name/.test(c)).map(c => {
    const kum = (c.match(/cumilative-period-scores[^>]*>\s*(\d{1,3})/i) || [])[1];
    const per = hucreMetin(c.replace(/<span[^>]*period-name[^>]*>[\s\S]*?<\/span>/gi, '').replace(/<span[^>]*cumilative[\s\S]*?<\/span>/gi, ''));
    return [+per, +kum];
  }).filter(x => !isNaN(x[0]) && !isNaN(x[1])));
  const tr = takim.filter(x => x.length >= 4);
  if (tr.length < 2) return null;
  const [ev, dep] = tr;
  if (ev.length !== dep.length || !kumTamam(ev, s[0]) || !kumTamam(dep, s[1])) return null;
  return ev.map((e, i) => [e[0], dep[i][0]]);
}

// Kutu skor: #tblHomeStats / #tblAwayStats tablolarının takım toplamı satırı (oyuncular alınmaz)
const KUTU = { 'Sa.': 'Sayı', 'Rbd': 'Ribaund', 'Ast': 'Asist', '2S': '2 Sayı', '3S': '3 Sayı', 'SA': 'Serbest Atış',
  'RH': 'Hücum Ribaundu', 'RS': 'Savunma Ribaundu', 'Fa': 'Faul', 'Bl': 'Blok', 'TÇ': 'Top Çalma', 'TK': 'Top Kaybı' };
function kutuTakim(html, id) {
  const t = tabloAl(html, new RegExp(`<table[^>]*id="${id}"`, 'i'));
  if (!t) return null;
  const tr = satirlar(t);
  const bas = tr.find(x => /table-header/.test(x));
  const top = tr.find(x => /total_row/.test(x));
  if (!bas || !top) return null;
  const b = hucreler(bas).map(hucreMetin), v = hucreler(top).map(hucreMetin);
  const o = {};
  b.forEach((h, i) => {
    const ad = KUTU[h]; if (!ad || !v[i]) return;
    const m = v[i].match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) o[ad] = [+m[1], +m[2]];
    else if (/^\d+$/.test(v[i])) o[ad] = +v[i];
  });
  return Object.keys(o).length >= 3 ? o : null;
}
function kutuSkor(html) {
  const ev = kutuTakim(html, 'tblHomeStats'), dep = kutuTakim(html, 'tblAwayStats');
  return ev && dep ? { ev, dep } : null;
}

function periyotBul(html, duz, ev, dep, ms) {
  const s = skorCoz(ms);
  if (!s) return null;
  const h = periyotHtml(html, s);
  if (h) return h;
  const tablo = periyotTablo(duz, s);
  if (tablo) return tablo;
  const t = tokenlar(html);
  // a) Skor tablosu: takım adından sonra gelen sayılar, toplamı maç skoruna eşit olmalı
  const takim = (ad, hedef) => {
    const a = sade(ad), out = [];
    if (!a) return out;
    for (let i = 0; i < t.length; i++) {
      if (sade(t[i]) !== a) continue;
      const n = [];
      for (let j = i + 1; j < t.length && n.length < 8 && /^\d{1,3}$/.test(t[j]); j++) n.push(+t[j]);
      const c = diziCoz(n, hedef);
      if (c) out.push(c);
    }
    return out;
  };
  const e = takim(ev, s[0]), d = takim(dep, s[1]);
  for (const x of e) for (const y of d) if (x.length === y.length) return x.map((v, i) => [v, y[i]]);
  // b) Metin içinde art arda periyot skorları: "20-18 22-25 19-21 24-20"
  const c = [...duz.matchAll(/(\d{1,3})\s*[-–:]\s*(\d{1,3})/g)]
    .map(m => ({ h: +m[1], a: +m[2], i: m.index, son: m.index + m[0].length }));
  for (let i = 0; i < c.length; i++)
    for (let k = 4; k <= 6 && i + k <= c.length; k++) {
      const p = c.slice(i, i + k);
      if (p.some((x, j) => j && x.i - p[j - 1].son > 12)) break;
      if (topla(p.map(x => x.h)) === s[0] && topla(p.map(x => x.a)) === s[1]) return p.map(x => [x.h, x.a]);
    }
  return null;
}

const ODDS_RE = /openOddsDialog\(\s*'[^']*'\s*,\s*'([^']*)'\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*,\s*'([^']*)'/g;
const arr = s => s.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

function macAyristir(html, a) {
  const duz = entity(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const r = { ...a, mbs: mbsBul(html), oran: {}, per: null };
  if (!r.ms) {
    const og = html.match(/property="og:title"\s+content="([^"]*)"/i);
    if (og) { const s = og[1].match(/\s(\d{1,3})\s*-\s*(\d{1,3})\s/); if (s) r.ms = s[1] + '-' + s[2]; }
  }
  const d = duz.match(/Tarih\s*:\s*(\d{2}\.\d{2}\.\d{4})\s*(\d{2}:\d{2})/);
  if (d && !r.saat) r.saat = d[2];
  // Bütün marketler ham hâliyle saklanır; CSV'de ana olanlar ayrıca çıkarılır
  ODDS_RE.lastIndex = 0;
  let m;
  while ((m = ODDS_RE.exec(html)) !== null) {
    const ad = m[1].trim();
    if (!r.kod) r.kod = m[4];
    const et = arr(m[2]), or = arr(m[3]);
    const h = r.oran[ad] || (r.oran[ad] = {});
    et.forEach((e, i) => { if (or[i]) h[e.trim()] = or[i]; });
  }
  if (r.ms) r.per = periyotBul(html, duz, r.ev, r.dep, r.ms);
  // Uzatmalı maçta skor uzatma dahil hâline getirilir (iddaa basketbol sonuçları uzatma dahildir)
  if (r.per && r.per.length > 4) r.ms = topla(r.per.map(x => x[0])) + '-' + topla(r.per.map(x => x[1]));
  r.ist = kutuSkor(html);
  return r;
}

/* ==================================================================
   4) Market seçimi (CSV ve test için)
   ================================================================== */
const AU_RE = /alt ?\/ ?ust|alt-ust|\balt\b.*\bust\b/;
const BOLUM_RE = /periyot|ceyrek|yari|\biy\b|takim|ev ?sahibi|deplasman|\btek\b|cift|uzatma|handikap/;
function auIki(e) {
  let alt, ust;
  for (const [k, v] of Object.entries(e)) { const s = sade(k); if (s.includes('alt')) alt = v; else if (s.includes('ust')) ust = v; }
  return [alt, ust];
}
const cizgiBul = (ad, e) => {
  const m = ad.match(/(\d{1,3}[.,]5)/) || Object.keys(e).join(' ').match(/(\d{1,3}[.,]5)/);
  return m ? nf(m[1]) : null;
};
// Birden çok çizgi varsa oranları birbirine en yakın olan "ana çizgi" sayılır
function auSecim(oran, filtre) {
  let en = null;
  for (const [ad, e] of Object.entries(oran)) {
    const s = sade(ad);
    if (!AU_RE.test(s) || !filtre(s)) continue;
    const [alt, ust] = auIki(e), c = cizgiBul(ad, e);
    if (!(nf(alt) > 1) || !(nf(ust) > 1) || c === null) continue;   // '-' = oran yok
    const fark = Math.abs(nf(alt) - nf(ust));
    if (!en || fark < en.fark) en = { cizgi: c, alt, ust, fark };
  }
  return en;
}
const anaAU = o => auSecim(o, s => !BOLUM_RE.test(s));
const iyAU = o => auSecim(o, s => /(1\.? ?yari|ilk yari|\biy\b)/.test(s) && !/periyot|ceyrek|takim|handikap|ev ?sahibi|deplasman/.test(s));
const ucluSec = e => {
  const o = {};
  for (const [k, v] of Object.entries(e)) { const s = sade(k); if (/^1/.test(s)) o['1'] = v; else if (/^x/.test(s)) o.X = v; else if (/^2/.test(s)) o['2'] = v; }
  return o;
};
// "Maç Sonucu" ya da "Maç Sonucu (Uzt. Dahil)"
function msOran(oran) {
  for (const [ad, e] of Object.entries(oran)) { const s = sade(ad); if (/^mac sonucu\b/.test(s) && !/alt|ust/.test(s)) return ucluSec(e); }
  return null;
}
// Birden çok handikap çizgisinden oranları en dengeli olanı. "(0:18,5)" → ev sahibi −18,5
function handikap(oran) {
  let en = null;
  for (const [ad, e] of Object.entries(oran)) {
    const s = sade(ad);
    if (!s.includes('handikap') || /periyot|ceyrek|yari|\biy\b/.test(s)) continue;
    const u = ucluSec(e), h = ad.match(/\(\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)\s*\)/);
    if (!(nf(u['1']) > 1) || !(nf(u['2']) > 1) || !h) continue;
    const fark = Math.abs(nf(u['1']) - nf(u['2']));
    if (!en || fark < en.fark) en = { ad, evHnd: nf(h[1]) - nf(h[2]), ...u, fark };
  }
  return en;
}

/* ==================================================================
   5) Depolama: data/maclar/YYYY/MM/YYYY-MM-DD.json
   ================================================================== */
const gunDosya = t => path.join(VERI, 'maclar', t.slice(0, 4), t.slice(5, 7), t + '.json');
const gunler = new Map(), kirli = new Set();
async function gunYukle(t) {
  if (gunler.has(t)) return gunler.get(t);
  let o = {};
  try { o = JSON.parse(await fs.readFile(gunDosya(t), 'utf8')); } catch { }
  gunler.set(t, o);
  return o;
}
function jsonSatir(o) {
  const ks = Object.keys(o).sort((a, b) => ((o[a].saat || '') + a).localeCompare((o[b].saat || '') + b));
  return '{\n' + ks.map(k => JSON.stringify(k) + ':' + JSON.stringify(o[k])).join(',\n') + '\n}\n';
}
async function kirliYaz() {
  for (const t of kirli) {
    const f = gunDosya(t);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, jsonSatir(gunler.get(t)));
  }
  kirli.clear();
}
const durumDosya = () => path.join(VERI, 'durum', MOD === 'gecmis' ? `gecmis-${PARCA}.json` : 'guncel.json');
async function durumYukle() { try { return JSON.parse(await fs.readFile(durumDosya(), 'utf8')); } catch { return {}; } }
async function durumYaz(d) {
  await fs.mkdir(path.dirname(durumDosya()), { recursive: true });
  await fs.writeFile(durumDosya(), JSON.stringify(d, null, 2) + '\n');
}
// Basketbol olmayan günler (yaz arası) de boş dosya olarak yazılır, böylece tekrar taranmaz
const dosyaVar = async t => { try { await fs.stat(gunDosya(t)); return true; } catch { return false; } };

/* ==================================================================
   6) İşleme
   ================================================================== */
const say = { yeni: 0, guncellenen: 0, ayni: 0, periyotlu: 0, istatistikli: 0, mbsli: 0, oransiz: 0, oynanmamis: 0, hata: 0 };
const tamam = r => r && Array.isArray(r.per) && r.per.length >= 4;
const tamIst = r => tamam(r) && r.ist;
const karsilastir = r => JSON.stringify({ ...r, guncel: 0 });

async function havuz(isler, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: PARALEL }, async (_, w) => {
    while (i < isler.length && !zamanBitti() && !engel) {
      if (w >= aktif) { await sleep(500); continue; }
      await fn(isler[i++]);
      const b = BEKLE + ekBekle;
      if (b) await sleep(b);
    }
  }));
}

async function macIsle(a, tarih) {
  const html = await macGetir(a);
  if (!html) return false;
  const r = macAyristir(html, a);
  if (!r.ms) { say.oynanmamis++; return; }
  // Sadece "-" olan (hiç oynanamayan) marketler oran sayılmaz
  if (!Object.values(r.oran).some(e => Object.values(e).some(v => nf(v) > 1))) { say.oransiz++; return; }
  const g = await gunYukle(tarih);
  const eski = g[a.id];
  const yeni = {
    id: a.id, mbs: r.mbs, tarih, saat: r.saat, lig: a.lig, ligHam: a.ligHam,
    ev: r.ev, dep: r.dep, iy: r.iy, ms: r.ms, per: r.per, ist: r.ist, kod: r.kod, oran: r.oran,
    guncel: new Date().toISOString()
  };
  if (tamam(yeni)) say.periyotlu++;
  if (yeni.ist) say.istatistikli++;
  if (r.mbs) say.mbsli++;
  if (eski && karsilastir(eski) === karsilastir(yeni)) { say.ayni++; return; }
  g[a.id] = yeni;
  kirli.add(tarih);
  if (eski) say.guncellenen++; else say.yeni++;
}

async function gunIsle(tarih, durum, sadeceEksik) {
  const liste = await gunListesi(tarih, durum);
  const g = await gunYukle(tarih);
  kirli.add(tarih);   // liste alındıysa gün dosyası (boş olsa bile) yazılır
  const taze = r => r && Date.now() - Date.parse(r.guncel || 0) < 12 * 3600e3;
  const isler = liste.filter(a => sadeceEksik ? !(tamIst(g[a.id]) || taze(g[a.id])) : !g[a.id]);
  const once = { ...say }, bas = Date.now();
  let hatali = [];
  await havuz(isler, async a => { if (await macIsle(a, tarih) === false) hatali.push(a); });
  if (hatali.length && !zamanBitti() && !engel) {
    await sleep(5000);
    const tekrar = hatali; hatali = [];
    await havuz(tekrar, async a => { if (await macIsle(a, tarih) === false) hatali.push(a); });
  }
  say.hata += hatali.length;
  await kirliYaz();
  const f = k => say[k] - once[k];
  const sn = (Date.now() - bas) / 1000;
  console.log(`${trTarih(tarih)} · listede ${liste.length} · işlenen ${isler.length} → +${f('yeni')} yeni, ${f('guncellenen')} güncel, ` +
    `${f('periyotlu')} periyotlu, ${f('istatistikli')} ist., ${f('mbsli')} MBS, ${f('oransiz')} oransız, ${f('oynanmamis')} oynanmamış, ${f('hata')} hata` +
    (isler.length ? ` · ${(isler.length / Math.max(sn, 0.1)).toFixed(1)} maç/sn` : '') + ` · ${aktif} paralel`);
  return !zamanBitti() && !engel;
}

async function ozetYaz(satirlar) {
  const metin = satirlar.filter(Boolean).join('\n');
  console.log(metin);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, metin + '\n');
}
const sayOzet = () => `- Eklenen **${say.yeni}** · güncellenen ${say.guncellenen} · değişmeyen ${say.ayni} · periyotlu ${say.periyotlu} · istatistikli ${say.istatistikli} · MBS'li ${say.mbsli}\n` +
  `- Oransız ${say.oransiz} · oynanmamış ${say.oynanmamis} · hata ${say.hata} · istek ${istekSay}`;

/* ---------- güncel ---------- */
async function guncelCalis() {
  const durum = await durumYukle();
  const bugun = trBugun();
  let ilk = gunEkle(bugun, -SON_GUN);
  if (!durum.ileri) ilk = gunEkle(ANKRAJ, 1);
  else if (durum.ileri < ilk) ilk = gunEkle(durum.ileri, 1);
  if (ilk <= ANKRAJ) ilk = gunEkle(ANKRAJ, 1);
  const notlar = [];
  for (let t = ilk; t < bugun && !zamanBitti() && !engel; t = gunEkle(t, 1)) {
    try { if (await gunIsle(t, durum, true) && (!durum.ileri || t > durum.ileri)) durum.ileri = t; }
    catch (e) { notlar.push(`- ${t}: ${e.message}`); break; }
    await durumYaz(durum);
  }
  await kirliYaz(); await durumYaz(durum);
  await ozetYaz(['## Basketbol · güncel', sayOzet(), `- Son işlenen gün: ${durum.ileri || '-'}`, ...notlar]);
}

/* ---------- DURUM.md ---------- */
async function durumMdYaz(tumGunler, bosSet) {
  const dolu = tumGunler.length - bosSet.size;
  const yuzde = Math.round(dolu / tumGunler.length * 100);
  const bar = '█'.repeat(Math.round(yuzde / 4)) + '░'.repeat(25 - Math.round(yuzde / 4));
  const yil = {};
  for (const t of tumGunler) {
    const y = t.slice(0, 4);
    (yil[y] || (yil[y] = { dolu: 0, top: 0 })).top++;
    if (!bosSet.has(t)) yil[y].dolu++;
  }
  let mac = 0;
  const kok = path.join(VERI, 'maclar');
  for (const y of (await fs.readdir(kok).catch(() => [])).sort())
    for (const m of (await fs.readdir(path.join(kok, y)).catch(() => [])).sort())
      for (const f of await fs.readdir(path.join(kok, y, m)).catch(() => []))
        mac += Object.keys(JSON.parse(await fs.readFile(path.join(kok, y, m, f), 'utf8'))).length;
  const sat = [
    '# Basketbol arşivi — ilerleme', '',
    `\`${bar}\`  **%${yuzde}**`, '',
    `- Toplanan maç: **${mac.toLocaleString('tr-TR')}**`,
    `- Taranan gün: **${dolu} / ${tumGunler.length}** · kalan ${bosSet.size} gün`,
    `- Son güncelleme: ${new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} (Türkiye saati)`, '',
    '## Yıllara göre', '', '| Yıl | Taranan gün | Durum |', '| --- | --- | --- |',
    ...Object.keys(yil).sort().reverse().map(y => {
      const v = yil[y], p = Math.round(v.dolu / v.top * 100);
      return `| ${y} | ${v.dolu} / ${v.top} | ${'█'.repeat(Math.round(p / 10))}${'░'.repeat(10 - Math.round(p / 10))} %${p} |`;
    }), ''
  ];
  await fs.mkdir(VERI, { recursive: true });
  await fs.writeFile(path.join(VERI, 'DURUM.md'), sat.join('\n') + '\n');
}

/* ---------- geçmiş: futboldaki gibi iş paylaşımlı tarama ---------- */
async function gecmisCalis() {
  const toplam = Math.round(YIL * 365.25);
  const tumGunler = Array.from({ length: toplam }, (_, i) => gunEkle(ANKRAJ, -i));
  const k = Math.ceil(toplam / PARCA_SAYI);
  const ust = gunEkle(ANKRAJ, -PARCA * k);
  const alt = gunEkle(ANKRAJ, -Math.min((PARCA + 1) * k, toplam) + 1);
  const durum = await durumYukle();
  durum.ust = ust; durum.alt = alt; durum.tur = durum.tur || 1;

  const bosGunler = [];
  for (const t of tumGunler) if (!await dosyaVar(t)) bosGunler.push(t);
  await durumMdYaz(tumGunler, new Set(bosGunler));

  let sira, etiket;
  if (bosGunler.length) {
    const bas = Math.floor(PARCA * bosGunler.length / PARCA_SAYI);
    sira = bosGunler.slice(bas).concat(bosGunler.slice(0, bas));
    etiket = `1. tur · ${bosGunler.length} boş gün kaldı · ${sira[0]} tarihinden başlıyor`;
  } else {
    durum.tur = 2;
    sira = tumGunler.filter(t => t <= ust && t >= alt);
    etiket = `2. tur (eksik maç tamamlama) · ${alt} … ${ust}`;
  }
  console.log(`Basketbol parça ${PARCA + 1}/${PARCA_SAYI} · ${etiket} · ${PARALEL} paralel · ${BUTCE_DK} dk`);

  const notlar = [];
  let listeHata = 0, islenen = 0;
  for (const t of sira) {
    if (zamanBitti() || engel) break;
    try { await gunIsle(t, durum, false); islenen++; listeHata = 0; }
    catch (e) {
      notlar.push(`- ${t}: ${e.message}`);
      console.log(`${t} HATA: ${e.message}`);
      if (++listeHata >= 3) break;
      await sleep(20000);
    }
    durum.son = t;
    await durumYaz(durum);
  }
  const kalanGunler = [];
  for (const t of tumGunler) if (!await dosyaVar(t)) kalanGunler.push(t);
  await durumMdYaz(tumGunler, new Set(kalanGunler));
  const hepsiBitti = durum.tur >= 2 && islenen >= sira.length;
  durum.bitti = hepsiBitti;
  await kirliYaz(); await durumYaz(durum);
  if (hepsiBitti) await fs.writeFile(path.join(KOK, '.bitti'), '1');
  if (engel) await fs.writeFile(path.join(KOK, '.engel'), '1');
  const yuzde = Math.round((toplam - kalanGunler.length) / toplam * 100);
  await ozetYaz([`## Basketbol geçmiş parça ${PARCA + 1}/${PARCA_SAYI}`, sayOzet(),
    `- ${hepsiBitti ? 'TAMAMLANDI' : `${islenen} gün işlendi · arşivin %${yuzde}'i dolu · ${kalanGunler.length} boş gün kaldı`}`,
    engel ? '- ⚠️ Mackolik art arda hata verdi, bu parça bir sonraki turda devam edecek.' : '', ...notlar]);
}

/* ==================================================================
   7) CSV — analiz sütunlarıyla birlikte
   ================================================================== */
const csvD = (v, sayiMi) => {
  let s = v == null ? '' : String(v);
  if (sayiMi && /^-?\d+([.,]\d+)?$/.test(s)) s = s.replace('.', ',');
  return '"' + s.replace(/"/g, '""') + '"';
};
const IST_SUTUN = [['Ribaund'], ['Hücum Ribaundu'], ['Savunma Ribaundu'], ['Asist'], ['2 Sayı', 1], ['3 Sayı', 1],
  ['Serbest Atış', 1], ['Faul'], ['Blok'], ['Top Çalma'], ['Top Kaybı']];
const BASLIK = [
  'MBS', 'Tarih', 'Saat', 'Lig', 'Ev Sahibi', 'Deplasman',
  'P1 Ev', 'P1 Dep', 'P2 Ev', 'P2 Dep', 'P3 Ev', 'P3 Dep', 'P4 Ev', 'P4 Dep', 'Uzatma Ev', 'Uzatma Dep',
  'İY Skor', 'MS Skor', 'Sonuç', 'Uzatma?', 'Toplam Sayı', 'Normal Süre Toplam', 'P1 Toplam',
  'MS 1', 'MS X', 'MS 2', 'AÜ Çizgi', 'AÜ Alt', 'AÜ Üst', 'AÜ ✓',
  'HND Ev Handikap', 'HND 1', 'HND 2', 'İY AÜ Çizgi', 'İY AÜ Alt', 'İY AÜ Üst',
  'Beklenen P1 (Çizgi/4)', 'P1 Sapma %', 'Hız Projeksiyonu', 'Normal Süre − Projeksiyon', 'Toplam − Çizgi',
  'P1 Sonuç', 'P2 Sonuç', 'P3 Sonuç', 'P4 Sonuç',
  ...IST_SUTUN.flatMap(([ad, cift]) => cift
    ? [`${ad} İsabet Ev`, `${ad} Deneme Ev`, `${ad} İsabet Dep`, `${ad} Deneme Dep`]
    : [`${ad} Ev`, `${ad} Dep`]),
  'İddaa Kodu', 'Tüm Oranlar'
];
const csvBaslik = () => '\uFEFFsep=;\r\n' + BASLIK.map(b => csvD(b)).join(';') + '\r\n';
const yuv = x => String(Math.round(x * 100) / 100);

function csvSatir(r) {
  const t = skorCoz(r.ms), p = Array.isArray(r.per) ? r.per : [];
  const q = i => p[i] || ['', ''];
  const uz = p.length > 4 ? [topla(p.slice(4).map(x => x[0])), topla(p.slice(4).map(x => x[1]))] : ['', ''];
  const toplam = t ? t[0] + t[1] : '';
  const normal = p.length >= 4 ? topla(p.slice(0, 4).map(x => x[0] + x[1])) : '';
  const p1 = p.length ? p[0][0] + p[0][1] : '';
  const ms = msOran(r.oran) || {}, au = anaAU(r.oran), h = handikap(r.oran) || {}, iy = iyAU(r.oran);
  const bek = au ? au.cizgi / 4 : '';
  const sapma = au && p1 !== '' ? ((p1 - bek) / bek * 100).toFixed(1) : '';
  const proj = au && p1 !== '' ? p1 + au.cizgi * 0.75 : '';
  const tumu = Object.entries(r.oran).map(([ad, e]) => ad + ': ' + Object.entries(e).map(([k, v]) => `${k}=${v}`).join(' ')).join(' | ');
  const metin = [r.mbs || '', trTarih(r.tarih), r.saat, r.lig, r.ev, r.dep].map(v => csvD(v));
  const sayilar = [
    q(0)[0], q(0)[1], q(1)[0], q(1)[1], q(2)[0], q(2)[1], q(3)[0], q(3)[1], uz[0], uz[1]
  ].map(v => csvD(v, true));
  const orta = [
    csvD(r.iy), csvD(r.ms), csvD(t ? (t[0] > t[1] ? '1' : '2') : ''), csvD(p.length ? (p.length > 4 ? 'Var' : 'Yok') : ''),
    csvD(toplam, true), csvD(normal, true), csvD(p1, true),
    csvD(ms['1'] || '', true), csvD(ms.X || '', true), csvD(ms['2'] || '', true),
    csvD(au ? au.cizgi : '', true), csvD(au ? au.alt : '', true), csvD(au ? au.ust : '', true),
    csvD(au && t ? (toplam > au.cizgi ? 'Üst' : 'Alt') : ''),
    csvD(h.evHnd ?? '', true), csvD(h['1'] || '', true), csvD(h['2'] || '', true),
    csvD(iy ? iy.cizgi : '', true), csvD(iy ? iy.alt : '', true), csvD(iy ? iy.ust : '', true),
    csvD(bek === '' ? '' : yuv(bek), true), csvD(sapma, true),
    csvD(proj === '' ? '' : yuv(proj), true),
    csvD(proj !== '' && normal !== '' ? yuv(normal - proj) : '', true),
    csvD(au && t ? yuv(toplam - au.cizgi) : '', true),
    ...[0, 1, 2, 3].map(i => csvD(p[i] ? (p[i][0] > p[i][1] ? '1' : p[i][0] < p[i][1] ? '2' : 'X') : '')),
    ...IST_SUTUN.flatMap(([ad, cift]) => {
      const e = r.ist?.ev?.[ad], d = r.ist?.dep?.[ad];
      return (cift ? [e?.[0], e?.[1], d?.[0], d?.[1]] : [e, d]).map(v => csvD(v ?? '', true));
    }),
    csvD(r.kod), csvD(tumu)
  ];
  return [...metin, ...sayilar, ...orta].join(';') + '\r\n';
}

async function csvHepsi() {
  const kok = path.join(VERI, 'maclar');
  await fs.rm(CIKTI, { recursive: true, force: true });
  await fs.mkdir(CIKTI, { recursive: true });
  const tumF = path.join(CIKTI, 'basket_tum.csv');
  await fs.writeFile(tumF, csvBaslik());
  let toplam = 0, periyotlu = 0, istli = 0;
  for (const y of (await fs.readdir(kok).catch(() => [])).filter(x => /^\d{4}$/.test(x)).sort()) {
    const yF = path.join(CIKTI, `basket_${y}.csv`);
    await fs.writeFile(yF, csvBaslik());
    for (const m of (await fs.readdir(path.join(kok, y))).filter(x => /^\d{2}$/.test(x)).sort())
      for (const f of (await fs.readdir(path.join(kok, y, m))).filter(x => x.endsWith('.json')).sort()) {
        const maclar = Object.values(JSON.parse(await fs.readFile(path.join(kok, y, m, f), 'utf8')));
        const parca = maclar.map(csvSatir).join('');
        await fs.appendFile(yF, parca); await fs.appendFile(tumF, parca);
        toplam += maclar.length; periyotlu += maclar.filter(tamam).length; istli += maclar.filter(r => r.ist).length;
      }
  }
  await ozetYaz(['## Basketbol CSV', `- ${toplam} maç yazıldı · periyot skoru olan ${periyotlu} · istatistikli ${istli}`]);
}

/* ==================================================================
   8) Test modu — teşhis (veriye dokunmaz)
   ================================================================== */
async function testCalis() {
  const tarihler = process.env.TEST_TARIH ? process.env.TEST_TARIH.split(',').map(x => x.trim())
    : ['2026-03-14', '2025-11-15', '2024-02-10'];   // sezon içi cumartesiler
  const durum = {}, rapor = { tarihler, ayar: { SPOR_ALAN, SPOR_DEGER, LISTE_EK }, listeler: [], maclar: [] };
  await fs.mkdir(DEBUG, { recursive: true });
  try {
    const adaylar = [];
    for (const t of tarihler) {
      for (const ek of [LISTE_EK]) {
        try {
          const rows = await listeJson(t, durum, ek);
          const dag = {}, ornek = {};
          for (const r of rows) { const v = String(r[SPOR_ALAN]); dag[v] = (dag[v] || 0) + 1; if (!ornek[v]) ornek[v] = r; }
          const b = rows.filter(basketMi).filter(r => /^\d+$/.test(String(r[0])));
          rapor.listeler.push({ tarih: t, ek, satir: rows.length, sporAlaniDagilimi: dag, basket: b.length,
            basketIddaaKodlu: b.filter(iddaaKodlu).length, ornekSatirlar: ornek, basketOrnek: b.slice(0, 3) });
          if (ek === LISTE_EK) {
            const l = b.some(iddaaKodlu) ? b.filter(iddaaKodlu) : b;
            adaylar.push(...[0, 0.3, 0.6, 0.9].map(p => l[Math.floor(p * l.length)]).filter(Boolean).map(aday));
          }
        } catch (e) { rapor.listeler.push({ tarih: t, ek, hata: e.message }); }
        await sleep(800);
      }
    }
    let kayit = 0;
    for (const a of adaylar) {
      const deneme = [];
      let html = null;
      for (const f of MAC_YOL) {
        const yol = f(a);
        try {
          const h = await getir(BASE + yol, 2, 15000);
          const u = sayfaUygun(h, a);
          deneme.push({ yol, uygun: u, baslik: ((h.match(/<title>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim().slice(0, 150),
            oranCagrisi: (h.match(/openOddsDialog/g) || []).length });
          if (u && !html) html = h;
        } catch (e) { deneme.push({ yol, hata: e.message }); }
        await sleep(400);
      }
      const k = { aday: a, deneme };
      if (html) {
        const r = macAyristir(html, a);
        Object.assign(k, { ms: r.ms, per: r.per, ist: r.ist, mbs: r.mbs, marketler: Object.keys(r.oran), oran: r.oran,
          anaAU: anaAU(r.oran), iyAU: iyAU(r.oran), msOran: msOran(r.oran), handikap: handikap(r.oran) });
        const duz = entity(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
        const i = duz.search(/\s1P\s/);
        k.periyotMetni = i >= 0 ? duz.slice(Math.max(0, i - 120), i + 300) : '';
        if (kayit < 3) { await fs.writeFile(path.join(DEBUG, `mac-${a.id}.html`), html); kayit++; }
      }
      rapor.maclar.push(k);
    }
  } catch (e) { rapor.hata = e.message; }
  await fs.writeFile(path.join(DEBUG, 'test-raporu.json'), JSON.stringify(rapor, null, 2));
  const acilan = rapor.maclar.filter(m => m.ms);
  await ozetYaz(['## Basketbol test',
    `- Listede bulunan basketbol maçı (günlere göre): ${rapor.listeler.filter(l => l.ek === LISTE_EK).map(l => l.basket ?? 'hata').join(' / ')}`,
    `- Sayfası açılan: ${acilan.length}/${rapor.maclar.length} · periyotu çözülen: ${acilan.filter(m => m.per).length} · istatistiği çözülen: ${acilan.filter(m => m.ist).length} · ana alt/üst bulunan: ${acilan.filter(m => m.anaAU).length}`,
    rapor.hata ? `- HATA: ${rapor.hata}` : '']);
}

/* ==================================================================
   9) Başlat
   ================================================================== */
if (MOD === 'test') await testCalis();
else if (MOD === 'csv') await csvHepsi();
else if (MOD === 'gecmis') await gecmisCalis();
else await guncelCalis();
