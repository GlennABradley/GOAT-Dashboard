/**
 * sovereign_dashboard.js — Sovereign Intelligence Data Layer v3.0
 *
 * Two-phase rendering:
 *   Phase 1 (instant): Reads window.__SD__ embedded by push_dashboard_data.py
 *                      Page renders in <100ms with correct data — no network.
 *   Phase 2 (refresh): Fetches fresh data + live prices in background.
 *                      Updates smoothly without flash.
 *
 * Usage:
 *   Sovereign.on('loaded', data => renderAll(data));
 *   Sovereign.on('updated', data => renderAll(data));
 *   const wr = Sovereign.get('competition_ledger.equity.win_rate', 0);
 */

const Sovereign = (() => {
  // ── Schema defaults ────────────────────────────────────────────────────
  // If any field is missing from live data, these safe defaults prevent
  // undefined/crash in render functions.
  const SCHEMA = {
    competition_ledger: {
      last_updated:'', commissioner_decisions:[],
      equity:  {total_trades:0,wins:0,losses:0,win_rate:0,sharpe_proxy:0,current_streak:0,streak_type:'—',avg_roi:0},
      crypto:  {total_trades:0,wins:0,losses:0,win_rate:0,sharpe_proxy:0},
      competition: {leader:'—',equity_score:0,crypto_score:0,edge:'—'},
    },
    system_health: {state:'HEALTHY',status_emoji:'🟢',position_multiplier:1.0,issues:[],checked_at:''},
    portfolio_public:  {position_count:0,symbols:[],regimes:[],strategies:[],last_updated:''},
    portfolio_private: {cash:0,equity_cash:0,start_of_day_value:0,positions:{},equity_positions:{},last_updated:''},
    shadow_summary:    {AGGRESSIVE:{total_trades:0,win_rate:0,max_drawdown:0},CONSERVATIVE:{total_trades:0,win_rate:0,max_drawdown:0},EXPERIMENTAL:{total_trades:0,win_rate:0,max_drawdown:0}},
    meta_learnings:    {equity:[],crypto:[]},
    live_readiness:    {gates_passed:0,gates_total:7,all_pass:false,readiness_pct:0,gates:{},equity_stats:{},crypto_stats:{}},
    performance_attribution: {generated_at:'',total_trades:0,tribunal:{tribunal_vetoes:0,tribunal_approvals:0,live_win_rate:0,tribunal_veto_rate:0,insight:'—'},regime_performance:{best_regime:'—',best_win_rate:0,by_regime:{}}},
    tribunal_accuracy: {last_updated:'',weights:{},judges:{}},
    multi_timeframe:   {symbols:{},last_updated:''},
    cross_asset:       {signal:'NEUTRAL',urgency:'LOW',btc_2h_change:0,btc_1h_change:0,action:'—',checked_at:''},
    decisions_recent:  [],
  };

  // ── State ──────────────────────────────────────────────────────────────
  let _data      = JSON.parse(JSON.stringify(SCHEMA));
  let _prices    = {};
  let _fg        = {value:null,label:'—',color:'#8B84BE'};
  let _listeners = {loaded:[],updated:[],error:[]};
  let _loaded    = false;
  let _baseUrl   = '';

  // ── Utilities ──────────────────────────────────────────────────────────
  function _safe(obj, path, def) {
    try { return path.split('.').reduce((o,k)=>o!=null?o[k]:def, obj) ?? def; }
    catch { return def; }
  }

  function _merge(base, src) {
    if (!src || typeof src !== 'object') return base;
    const out = Object.assign({}, base);
    for (const k of Object.keys(src)) {
      if (k in out && out[k] !== null && typeof out[k] === 'object'
          && !Array.isArray(out[k]) && !Array.isArray(src[k])) {
        out[k] = _merge(out[k], src[k]);
      } else if (src[k] != null) {
        out[k] = src[k];
      }
    }
    return out;
  }

  function _normaliseMTF(raw) {
    if (!raw) return {symbols:{}};
    if (raw.symbols) return raw;
    const symbols = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      const sym = (v||{}).symbol || k.split('_')[0];
      if (sym && sym.includes('/')) symbols[sym] = v;
    }
    return {symbols, last_updated: new Date().toISOString()};
  }

  function _applyBundle(bundle) {
    for (const [key, val] of Object.entries(bundle)) {
      if (!val) continue;
      const schema = SCHEMA[key];
      if (!schema) { _data[key] = val; continue; }
      if (Array.isArray(schema)) { _data[key] = Array.isArray(val) ? val : []; continue; }
      if (key === 'multi_timeframe') { _data[key] = _normaliseMTF(val); continue; }
      _data[key] = _merge(schema, val);
    }
  }

  function _emit(ev, payload) {
    (_listeners[ev]||[]).forEach(fn => { try { fn(payload); } catch(e) { console.warn('Sovereign:', e); } });
  }

  function _detectBase() {
    const p = window.location.pathname;
    if (p.includes('/private')) return p.replace(/\/private\/?.*$/, '') + '/data/';
    return p.replace(/\/?$/, '/') + 'data/';
  }

  async function _fetch(file) {
    const r = await fetch(_baseUrl + file + '?t=' + Date.now());
    if (!r.ok) throw new Error(r.status + ' ' + file);
    return r.json();
  }

  // ── Live price fetchers ────────────────────────────────────────────────
  async function _loadPrices() {
    try {
      const ids = 'bitcoin,ethereum,solana,polkadot,avalanche-2,chainlink,cardano,ripple';
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`);
      if (!r.ok) return;
      const d = await r.json();
      _prices = {
        'BTC/USD':d.bitcoin,'ETH/USD':d.ethereum,'SOL/USD':d.solana,'DOT/USD':d.polkadot,
        'AVAX/USD':d['avalanche-2'],'LINK/USD':d.chainlink,'ADA/USD':d.cardano,'XRP/USD':d.ripple,
      };
    } catch(e) { console.warn('CoinGecko:', e.message); }
  }

  async function _loadGlobal() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global');
      if (!r.ok) return;
      const d = (await r.json()).data;
      if (d?.market_cap_percentage?.btc) _prices._btcDominance = d.market_cap_percentage.btc;
      if (d?.total_market_cap?.usd) _prices._totalMarketCap = d.total_market_cap.usd;
    } catch {}
  }

  async function _loadFearGreed() {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      if (!r.ok) return;
      const d = (await r.json()).data[0];
      const val = parseInt(d.value), label = d.value_classification;
      const colorMap = {'Extreme Fear':'#10B981','Fear':'#6EE7B7','Neutral':'#F59E0B','Greed':'#F97316','Extreme Greed':'#EF4444'};
      _fg = {value:val, label, color: colorMap[label]||'#8B84BE'};
    } catch {}
  }

  async function _loadAll() {
    const files = [
      'competition_ledger.json','system_health.json','portfolio_public.json',
      'portfolio_private.json','shadow_summary.json','meta_learnings.json',
      'live_readiness.json','performance_attribution.json','tribunal_accuracy.json',
      'multi_timeframe.json','cross_asset.json','decisions_recent.json',
    ];
    const results = await Promise.allSettled(files.map(f => _fetch(f)));
    const fresh = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value != null) {
        fresh[files[i].replace('.json','').replace(/-/g,'_')] = r.value;
      }
    });
    _applyBundle(fresh);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  return {
    on(event, fn) {
      if (_listeners[event]) _listeners[event].push(fn);
      if (event === 'loaded' && _loaded) fn(_data);
    },
    get(path, def=null) { return _safe(_data, path, def); },
    data()   { return _data; },
    prices() { return _prices; },
    fg()     { return _fg; },
    price(sym) { return _prices[sym]?.usd || null; },

    fmt: {
      dollar: n => n != null ? '$' + Number(n).toLocaleString('en-US', {maximumFractionDigits: n>100?0:2}) : '—',
      pct:    n => n != null ? (n>=0?'+':'') + Number(n).toFixed(2) + '%' : '—',
      pct0:   n => n != null ? (Number(n)*100).toFixed(0) + '%' : '—',
      round:  (n,dec=2) => n != null ? Number(n).toFixed(dec) : '—',
    },

    async init() {
      _baseUrl = _detectBase();

      // ── PHASE 1: Instant render from embedded data ──────────────────
      // push_dashboard_data.py injects window.__SD__ into the HTML.
      // This fires 'loaded' before any network request.
      if (window.__SD__) {
        _applyBundle(window.__SD__);
        _loaded = true;
        _emit('loaded', _data);
      }

      // ── PHASE 2: Background refresh with fresh data + live prices ───
      await Promise.allSettled([_loadAll(), _loadPrices(), _loadGlobal(), _loadFearGreed()]);

      if (!window.__SD__) {
        // No embedded data — first-time load without injection
        _loaded = true;
        _emit('loaded', _data);
      } else {
        // Update with any fresher data from fetches
        _emit('updated', _data);
      }

      // Auto-refresh every 60s
      setInterval(async () => {
        await Promise.allSettled([_loadAll(), _loadPrices()]);
        _emit('updated', _data);
      }, 60000);
      setInterval(_loadFearGreed, 300000);
      setInterval(_loadGlobal, 300000);
    },
  };
})();
