/**
 * sovereign_dashboard.js — Sovereign Intelligence Data Layer v2.0
 *
 * Architecture: Schema-validated, error-boundary-wrapped, auto-refreshing
 * data singleton. Both dashboards import this one file. No inline JS data
 * logic lives in HTML — render functions only.
 *
 * Usage:
 *   Sovereign.on('loaded', data => renderAll(data));
 *   Sovereign.on('updated', data => refreshPrices(data));
 *   const wr = Sovereign.get('competition.equity.win_rate', 0);
 */

const Sovereign = (() => {
  // ── Schema & safe defaults ─────────────────────────────────────────────────
  // Every field the dashboard reads. If Python changes a field name, JS gets
  // the default instead of undefined/crash.
  const SCHEMA = {
    competition_ledger: {
      last_updated: '',
      equity: { total_trades:0, wins:0, losses:0, win_rate:0, sharpe_proxy:0,
                current_streak:0, streak_type:'—', avg_roi:0 },
      crypto: { total_trades:0, wins:0, losses:0, win_rate:0 },
      competition: { leader:'—', equity_score:0, crypto_score:0, edge:'—' },
      commissioner_decisions: [],
    },
    system_health: {
      state:'HEALTHY', status_emoji:'🟢', position_multiplier:1.0,
      issues:[], checked_at:'',
    },
    portfolio_public: {
      position_count:0, symbols:[], regimes:[], strategies:[], last_updated:'',
    },
    portfolio_private: {
      cash:0, start_of_day_value:0, positions:{}, last_updated:'',
    },
    shadow_summary: {
      AGGRESSIVE:  { total_trades:0, win_rate:0, max_drawdown:0 },
      CONSERVATIVE:{ total_trades:0, win_rate:0, max_drawdown:0 },
      EXPERIMENTAL:{ total_trades:0, win_rate:0, max_drawdown:0 },
    },
    meta_learnings: { equity:[], crypto:[] },
    live_readiness: {
      gates_passed:0, gates_total:7, all_pass:false,
      readiness_pct:0, gates:{}, equity_stats:{}, crypto_stats:{},
    },
    performance_attribution: {
      generated_at:'', total_trades:0,
      tribunal:{ tribunal_vetoes:0, tribunal_approvals:0, live_win_rate:0,
                 live_total_trades:0, tribunal_veto_rate:0, insight:'' },
      regime_performance:{ best_regime:'—', best_win_rate:0, by_regime:{} },
      kelly_performance:{},
    },
    tribunal_accuracy: {
      last_updated:'', weights:{}, judges:{},
    },
    multi_timeframe: {
      symbols:{}, last_updated:'',
    },
    cross_asset: {
      signal:'NEUTRAL', urgency:'LOW', btc_2h_change:null,
      btc_1h_change:null, btc_dominance:null, action:'', checked_at:'',
    },
    decisions_recent: [],
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let _data       = JSON.parse(JSON.stringify(SCHEMA));
  let _prices     = {};
  let _fg         = { value:null, label:'—', color:'#8B84BE' };
  let _listeners  = { loaded:[], updated:[], error:[] };
  let _loaded     = false;
  let _baseUrl    = '';  // auto-detected

  // ── Utilities ──────────────────────────────────────────────────────────────

  function _detectBase() {
    // Works on GitHub Pages (/path/) and localhost
    const path = window.location.pathname;
    if (path.includes('/private')) {
      return path.replace(/\/private\/?.*$/, '') + '/data/';
    }
    return path.replace(/\/?$/, '/') + 'data/';
  }

  function _safe(obj, path, def) {
    try {
      return path.split('.').reduce((o,k) => (o != null ? o[k] : def), obj) ?? def;
    } catch { return def; }
  }

  function _merge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const out = Object.assign({}, target);
    for (const k of Object.keys(source)) {
      if (k in target && target[k] !== null && typeof target[k] === 'object'
          && !Array.isArray(target[k]) && !Array.isArray(source[k])) {
        out[k] = _merge(target[k], source[k]);
      } else {
        out[k] = source[k] != null ? source[k] : target[k];
      }
    }
    return out;
  }

  async function _fetch(file) {
    const url = _baseUrl + file + '?t=' + Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + ' ' + file);
    return res.json();
  }

  function _emit(event, payload) {
    (_listeners[event] || []).forEach(fn => { try { fn(payload); } catch(e) { console.warn('Sovereign listener error:', e); } });
  }

  // ── Normalise multi_timeframe (handles cache-key format OR simple format) ──
  function _normaliseMTF(raw) {
    if (!raw) return { symbols:{} };
    const symbols = {};
    // Format 1: { "ETH/USD_20260402_18": { symbol, score, signals, ... } }
    // Format 2: { "symbols": { "ETH/USD": {...} } }  (future normalised)
    if (raw.symbols) return raw;
    for (const [k, v] of Object.entries(raw)) {
      const sym = v?.symbol || k.split('_')[0];
      if (sym && sym.includes('/')) symbols[sym] = v;
    }
    return { symbols, last_updated: new Date().toISOString() };
  }

  // ── Load all data files ────────────────────────────────────────────────────
  async function _loadAll() {
    const files = [
      'competition_ledger.json',
      'system_health.json',
      'portfolio_public.json',
      'shadow_summary.json',
      'meta_learnings.json',
      'live_readiness.json',
      'performance_attribution.json',
      'tribunal_accuracy.json',
      'multi_timeframe.json',
      'cross_asset.json',
      'decisions_recent.json',
    ];

    const results = await Promise.allSettled(files.map(f => _fetch(f)));

    results.forEach((r, i) => {
      const key = files[i].replace('.json', '').replace(/-/g, '_');
      if (r.status === 'fulfilled' && r.value != null) {
        const schema = SCHEMA[key];
        if (schema && !Array.isArray(schema)) {
          _data[key] = _merge(schema, r.value);
        } else if (key === 'decisions_recent') {
          _data[key] = Array.isArray(r.value) ? r.value : [];
        } else if (key === 'multi_timeframe') {
          _data[key] = _normaliseMTF(r.value);
        } else {
          _data[key] = r.value;
        }
      }
    });

    _data.multi_timeframe = _normaliseMTF(_data.multi_timeframe);
  }

  // ── Crypto prices (CoinGecko) ──────────────────────────────────────────────
  async function _loadPrices() {
    try {
      const ids = 'bitcoin,ethereum,solana,polkadot,avalanche-2,chainlink,cardano,ripple';
      const r = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd` +
        `&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`
      );
      if (!r.ok) return;
      const d = await r.json();
      _prices = {
        'BTC/USD': d.bitcoin,    'ETH/USD': d.ethereum,
        'SOL/USD': d.solana,     'DOT/USD': d.polkadot,
        'AVAX/USD': d['avalanche-2'], 'LINK/USD': d.chainlink,
        'ADA/USD': d.cardano,    'XRP/USD': d.ripple,
      };
    } catch(e) { console.warn('CoinGecko failed:', e); }
  }

  async function _loadGlobal() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global');
      if (!r.ok) return;
      const d = (await r.json()).data;
      const dom = d?.market_cap_percentage?.btc;
      if (dom) _prices._btcDominance = dom;
      const mc = d?.total_market_cap?.usd;
      if (mc) _prices._totalMarketCap = mc;
    } catch {}
  }

  async function _loadFearGreed() {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      if (!r.ok) return;
      const d = (await r.json()).data[0];
      const val = parseInt(d.value);
      const label = d.value_classification;
      const colorMap = {
        'Extreme Fear':'#10B981','Fear':'#6EE7B7',
        'Neutral':'#F59E0B','Greed':'#F97316','Extreme Greed':'#EF4444',
      };
      _fg = { value:val, label, color: colorMap[label] || '#8B84BE' };
    } catch {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    /** Subscribe to events: 'loaded', 'updated', 'error' */
    on(event, fn) {
      if (_listeners[event]) _listeners[event].push(fn);
      if (event === 'loaded' && _loaded) fn(_data);
    },

    /** Safe field accessor: Sovereign.get('competition.equity.win_rate', 0) */
    get(path, def = null) { return _safe(_data, path, def); },

    /** Raw data access */
    data()   { return _data; },
    prices() { return _prices; },
    fg()     { return _fg; },

    /** Price for a symbol: Sovereign.price('ETH/USD') */
    price(sym) { return _prices[sym]?.usd || null; },

    /** Format utilities (available globally) */
    fmt: {
      dollar: n => n != null ? '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n > 100 ? 0 : 2 }) : '—',
      pct:    n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%' : '—',
      pct0:   n => n != null ? (Number(n) * 100).toFixed(0) + '%' : '—',
      num:    n => n != null ? Number(n).toLocaleString() : '—',
      round:  (n, dec=2) => n != null ? Number(n).toFixed(dec) : '—',
    },

    /** Initial load + start auto-refresh */
    async init(options = {}) {
      _baseUrl = _detectBase();
      await Promise.all([_loadAll(), _loadPrices(), _loadGlobal(), _loadFearGreed()]);
      _loaded = true;
      _emit('loaded', _data);

      // Auto-refresh system data every 60s
      setInterval(async () => {
        await _loadAll();
        _emit('updated', _data);
      }, 60_000);

      // Refresh prices every 60s
      setInterval(async () => {
        await _loadPrices();
        _emit('updated', _data);
      }, 60_000);

      // Refresh F&G every 5 min
      setInterval(_loadFearGreed, 300_000);
      setInterval(_loadGlobal, 300_000);
    },
  };
})();
