/**
 * S₂ Battle News Server
 * 
 * 功能：代理 NewsAPI，对标题做关键词打分，返回结构化事件
 * 
 * 部署：
 *   本地：node s2_server.js
 *   云端免费：Railway / Render（直接push即可，见README）
 * 
 * 环境变量：
 *   NEWS_API_KEY=你的NewsAPI密钥  (https://newsapi.org 免费注册)
 *   PORT=3001 (可选)
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3001;
const NEWS_API_KEY = process.env.NEWS_API_KEY || '';

// ── 关键词打分规则 ──
// 每条规则：{ pattern: 正则, effects: { country: { dim: delta } }, label, icon }
// ── 中文摘要模板（根据匹配规则自动生成）──
const ZH_TEMPLATES = [
  { pattern: /strike|airstrike|bomb|destroy/i,         zh: (t) => `空袭行动：${extractTarget(t)}遭到打击` },
  { pattern: /missile.*Iran|Iran.*missile|ballistic/i, zh: (t) => `伊朗发射弹道导弹，防空系统拦截` },
  { pattern: /missile|rocket/i,                        zh: (t) => `导弹袭击事件报告` },
  { pattern: /ceasefire|cease-fire|truce/i,            zh: (t) => `停火谈判出现新进展` },
  { pattern: /negotiate|diplomacy|mediat/i,            zh: (t) => `外交斡旋渠道出现活动` },
  { pattern: /peace talks/i,                           zh: (t) => `各方和谈迹象浮现` },
  { pattern: /Hormuz/i,                                zh: (t) => `霍尔木兹海峡局势更新` },
  { pattern: /oil price|crude/i,                       zh: (t) => `原油价格受战事影响波动` },
  { pattern: /tanker|shipping/i,                       zh: (t) => `航运安全受到威胁` },
  { pattern: /nuclear|uranium|enrichment/i,            zh: (t) => `核问题相关动态更新` },
  { pattern: /IAEA/i,                                  zh: (t) => `国际原子能机构发布声明` },
  { pattern: /Congress|Senate|AUMF/i,                  zh: (t) => `美国国会对战争授权展开辩论` },
  { pattern: /protest|opposition/i,                    zh: (t) => `国内反对声音持续上升` },
  { pattern: /Hezbollah|Lebanon/i,                     zh: (t) => `黎巴嫩真主党介入态势` },
  { pattern: /IDF|Israel.*attack|Israel.*strike/i,     zh: (t) => `以色列国防军发动新一轮打击` },
  { pattern: /Iron Dome|intercept/i,                   zh: (t) => `以色列拦截系统成功拦截来袭目标` },
  { pattern: /civilian|casualt|humanitarian/i,         zh: (t) => `平民伤亡与人道主义危机加剧` },
  { pattern: /UN Security Council|United Nations/i,    zh: (t) => `联合国安理会紧急磋商` },
  { pattern: /Iran.*protest|unrest/i,                  zh: (t) => `伊朗国内出现动荡迹象` },
  { pattern: /US forces|Pentagon|US military/i,        zh: (t) => `美军部队采取新行动` },
  { pattern: /Oman|Qatar.*mediat/i,                    zh: (t) => `海湾国家介入调停斡旋` },
  { pattern: /sanction/i,                              zh: (t) => `新一轮制裁措施出台` },
  { pattern: /oil|energy/i,                            zh: (t) => `能源市场受冲突影响` },
];

function extractTarget(text) {
  if (/Iran/i.test(text)) return '伊朗目标';
  if (/Israel/i.test(text)) return '以色列目标';
  if (/Syria/i.test(text)) return '叙利亚目标';
  return '军事目标';
}

function generateZhSummary(title) {
  for (const t of ZH_TEMPLATES) {
    if (t.pattern.test(title)) return t.zh(title);
  }
  return null;
}

const SCORING_RULES = [
  // 军事打击 → 伊朗T↓R↓
  {
    pattern: /strike|airstrike|bomb|missile|attack|hit|destroy|targeted/i,
    effects: { ir: { T: -0.04, R: -0.02 } },
    labels: [['🇮🇷 T−', 'neg'], ['🇮🇷 R−', 'neg']],
    icon: '💥'
  },
  // 美军行动 → 美T+
  {
    pattern: /US forces|Pentagon|US military|American forces|F-35|B-2|carrier/i,
    effects: { us: { T: +0.03, F: +0.02 } },
    labels: [['🇺🇸 T+', 'pos']],
    icon: '✈️'
  },
  // 停火/外交 → A路径压力
  {
    pattern: /ceasefire|cease-fire|peace talks|negotiate|diplomacy|truce|mediat/i,
    effects: { us: { I: +0.02 }, ir: { F: +0.02 } },
    labels: [['A路径+', 'pos']],
    icon: '🕊️'
  },
  // 伊朗导弹 → 伊朗T消耗，以色列R受压
  {
    pattern: /Iran.*missile|ballistic|IRGC|Revolutionary Guard|rocket/i,
    effects: { ir: { T: -0.03, R: -0.02 }, il: { R: -0.02 } },
    labels: [['🇮🇷 弹药−', 'neg'], ['🇮🇱 R−', 'neg']],
    icon: '🚀'
  },
  // 霍尔木兹/油价 → 全球F压力
  {
    pattern: /Hormuz|oil price|crude|tanker|shipping|blockade/i,
    effects: { us: { F: -0.02, R: -0.01 }, ir: { F: +0.02 } },
    labels: [['🛢️ 油价压力', 'neg']],
    icon: '🛢️'
  },
  // 国内反对/国会 → 美国I↓
  {
    pattern: /Congress|Senate|authorization|protest|opposition|approval rating/i,
    effects: { us: { I: -0.03, N: -0.02 } },
    labels: [['🇺🇸 I−', 'neg']],
    icon: '⚖️'
  },
  // 以色列行动成功 → 以色列F+
  {
    pattern: /Israel.*success|Iron Dome|intercept|IDF/i,
    effects: { il: { F: +0.03, T: +0.01 } },
    labels: [['🇮🇱 F+', 'pos']],
    icon: '🛡️'
  },
  // Hezbollah/Lebanon → 以色列R受压
  {
    pattern: /Hezbollah|Lebanon|southern Lebanon/i,
    effects: { il: { R: -0.02, F: -0.02 } },
    labels: [['🇮🇱 R−', 'neg']],
    icon: '🔥'
  },
  // 人道危机/平民伤亡 → 美以N↓
  {
    pattern: /civilian|casualt|humanitarian|hospital|genocide/i,
    effects: { us: { N: -0.02 }, il: { N: -0.03 } },
    labels: [['🇺🇸 N−', 'neg'], ['🇮🇱 N−', 'neg']],
    icon: '🆘'
  },
  // 安理会/联合国 → 美国I压力
  {
    pattern: /UN Security Council|United Nations|resolution|veto/i,
    effects: { us: { I: -0.01 }, il: { I: -0.02 } },
    labels: [['🌐 国际压力', 'neg']],
    icon: '🌐'
  },
  // 伊朗抗议/内部动荡 → 伊朗N↓
  {
    pattern: /Iran.*protest|dissent|unrest|opposition.*Iran/i,
    effects: { ir: { N: -0.03, C: -0.02 } },
    labels: [['🇮🇷 N−', 'neg']],
    icon: '✊'
  },
  // 核相关 → D路径压力
  {
    pattern: /nuclear|uranium|enrichment|IAEA|atomic/i,
    effects: { ir: { I: -0.02 }, us: { F: -0.01 } },
    labels: [['☢️ D路径↑', 'neg']],
    icon: '☢️'
  },
  // 第三方斡旋 → A路径+
  {
    pattern: /Oman|Qatar|Turkey.*mediat|Gulf.*mediat|neutral.*mediat/i,
    effects: { ir: { F: +0.02 }, us: { I: +0.01 } },
    labels: [['🕊️ 调停+', 'pos']],
    icon: '🤝'
  }
];

// ── 对一条标题打分 ──
function scoreHeadline(title, description) {
  const text = `${title} ${description || ''}`;
  const matchedRules = [];
  let combinedEffects = {};

  for (const rule of SCORING_RULES) {
    if (rule.pattern.test(text)) {
      matchedRules.push(rule);
      // merge effects
      for (const [country, dims] of Object.entries(rule.effects)) {
        if (!combinedEffects[country]) combinedEffects[country] = {};
        for (const [dim, delta] of Object.entries(dims)) {
          combinedEffects[country][dim] = (combinedEffects[country][dim] || 0) + delta;
        }
      }
    }
  }

  if (matchedRules.length === 0) return null;

  // collect unique labels (max 3)
  const labels = [...new Set(matchedRules.flatMap(r => r.labels))].slice(0, 3);
  const icon = matchedRules[0].icon;
  const zhText = generateZhSummary(title);

  return {
    text: title,
    zhText: zhText,
    displayText: zhText ? zhText : title,
    icon,
    effects: combinedEffects,
    labels,
    source: null // filled by caller
  };
}

// ── 从 NewsAPI 拉取新闻 ──
let newsCache = [];
let lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10分钟

const QUERIES = [
  'Iran Israel war 2026',
  'Iran missile strike 2026',
  'Hormuz strait oil 2026',
  'Iran nuclear 2026',
  'Middle East war ceasefire'
];

function fetchNewsAPI(query) {
  return new Promise((resolve, reject) => {
    if (!NEWS_API_KEY) { resolve([]); return; }
    const params = new URLSearchParams({
      q: query,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: '10',
      apiKey: NEWS_API_KEY
    });
    const options = {
      hostname: 'newsapi.org',
      path: `/v2/everything?${params}`,
      method: 'GET',
      headers: { 'User-Agent': 'S2Battle/1.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.articles || []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.abort(); resolve([]); });
    req.end();
  });
}

async function refreshNews() {
  if (Date.now() - lastFetch < CACHE_TTL && newsCache.length > 0) return;
  console.log('[S2] Fetching news from NewsAPI...');

  const allArticles = [];
  for (const q of QUERIES) {
    const articles = await fetchNewsAPI(q);
    allArticles.push(...articles);
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  // deduplicate by title
  const seen = new Set();
  const scored = [];
  for (const article of allArticles) {
    if (seen.has(article.title)) continue;
    seen.add(article.title);
    const event = scoreHeadline(article.title, article.description);
    if (event) {
      event.source = article.source?.name || 'NewsAPI';
      event.url = article.url;
      event.publishedAt = article.publishedAt;
      scored.push(event);
    }
  }

  // sort by recency
  scored.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  newsCache = scored.slice(0, 30);
  lastFetch = Date.now();
  console.log(`[S2] Got ${newsCache.length} scored events`);
}


// ── 服务端贝叶斯概率计算 ──
const WEIGHTS = { T:0.25, R:0.25, C:0.18, F:0.15, I:0.10, N:0.07 };
const INIT_DIMS = {
  us: { T: 0.8, R: -0.1, C: 0.4, F: -0.2, I: -0.1, N: 0.3 },
  il: { T: 0.7, R:  0.0, C: 0.7, F:  0.3, I:  0.4, N: 0.6 },
  ir: { T:-0.4, R: -0.8, C:-0.3, F: -0.8, I: -0.7, N:-0.6 }
};

function computeCurrentPaths(events) {
  // Deep copy dims
  const dims = {
    us: { ...INIT_DIMS.us },
    il: { ...INIT_DIMS.il },
    ir: { ...INIT_DIMS.ir }
  };

  // 去重：双重去重
  // 1. 标题去重（完全相同）
  // 2. 效果指纹去重（不同标题但命中相同规则 = 实质相同新闻）
  const seenTitles = new Set();
  const seenFingerprints = new Set();
  const unique = events.filter(ev => {
    // 标题去重
    const titleKey = (ev.text || '').slice(0, 60);
    if (seenTitles.has(titleKey)) return false;
    seenTitles.add(titleKey);

    // 效果指纹去重：把 effects 序列化为字符串
    // 相同的效果组合 = 实质相同的新闻，同一天只算一次
    if (ev.effects) {
      const day = (ev.publishedAt || '').slice(0, 10); // 同一天内去重
      const effectStr = JSON.stringify(ev.effects, Object.keys(ev.effects).sort());
      const fingerprint = day + '|' + effectStr;
      if (seenFingerprints.has(fingerprint)) return false;
      seenFingerprints.add(fingerprint);
    }
    return true;
  });

  // Apply all unique events once (sorted oldest first)
  const sorted = [...unique].sort((a,b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  const eventCount = sorted.length || 1;

  for (const ev of sorted) {
    if (!ev.effects) continue;
    // 衰减系数：新闻越多每条权重越小，防止堆积
    const decay = Math.max(0.15, 0.5 / Math.sqrt(eventCount));
    for (const [country, dimDeltas] of Object.entries(ev.effects)) {
      if (!dims[country]) continue;
      for (const [dim, delta] of Object.entries(dimDeltas)) {
        if (dims[country][dim] !== undefined) {
          dims[country][dim] = Math.max(-1, Math.min(1, dims[country][dim] + delta * decay));
        }
      }
    }
  }

  // Calc scores
  const scores = {};
  for (const c of ['us','il','ir']) {
    scores[c] = Object.keys(WEIGHTS).reduce((s,d) => s + WEIGHTS[d] * dims[c][d], 0);
  }

  // Bayesian path update from prior
  const prior = { a: 13, b: 48, c: 11, d: 27 };
  let { a, b, c, d } = prior;

  const irScore = scores.ir;
  const usScore = scores.us;
  const irT = dims.ir.T;
  const irR = dims.ir.R;
  const irI = dims.ir.I;
  const usF = dims.us.F;
  const usI = dims.us.I;

  if (usI < -0.1) a *= 1 + Math.abs(usI) * 0.5;
  if (usF < -0.2) a *= 1 + (Math.abs(usF) - 0.2) * 0.4;
  if (irScore < -0.6) a *= 1 + (Math.abs(irScore) - 0.6) * 0.6;

  if (irT > -0.6) b *= 1.05;
  if (irT < -0.7) b *= 0.85;
  if (usF < -0.25) b *= 1 - (Math.abs(usF) - 0.25) * 0.3;

  if (irI < -0.75) c *= 1 + (Math.abs(irI) - 0.75) * 1.8;
  if (irScore < -0.7) c *= 1 + (Math.abs(irScore) - 0.7) * 0.8;

  if (irT < -0.65 && irR < -0.75) d *= 1 + (Math.abs(irT) - 0.65) * 1.2;
  if (usF < -0.35) d *= 1 + (Math.abs(usF) - 0.35) * 0.6;
  if (irScore < -0.6 && usI < -0.1) { a *= 0.85; d *= 0.85; }

  const maxDev = 8;
  const t = a + b + c + d;
  return {
    a: Math.round(Math.max(prior.a - maxDev, Math.min(prior.a + maxDev, (a/t)*100))),
    b: Math.round(Math.max(prior.b - maxDev, Math.min(prior.b + maxDev, (b/t)*100))),
    c: Math.round(Math.max(prior.c - maxDev, Math.min(prior.c + maxDev, (c/t)*100))),
    d: Math.round(Math.max(prior.d - maxDev, Math.min(prior.d + maxDev, (d/t)*100))),
    dims, scores
  };
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/news') {
    try {
      await refreshNews();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const currentPaths = computeCurrentPaths(newsCache);
      res.end(JSON.stringify({
        ok: true,
        count: newsCache.length,
        lastFetch: new Date(lastFetch).toISOString(),
        currentPaths,
        events: newsCache
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cached: newsCache.length, apiKey: !!NEWS_API_KEY }));
    return;
  }

  res.writeHead(404);
  res.end('S2 Battle News Server — /news | /health');
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   S₂ Battle News Server  · Port ${PORT}    ║
╠══════════════════════════════════════════╣
║  API Key: ${NEWS_API_KEY ? '✓ 已配置' : '✗ 未配置 (将使用内置新闻)'}          ║
║  GET /news    → 拉取打分后的新闻事件    ║
║  GET /health  → 服务状态检查            ║
╠══════════════════════════════════════════╣
║  部署到 Railway:                         ║
║  1. railway login                        ║
║  2. railway init                         ║
║  3. railway up                           ║
║  4. railway vars set NEWS_API_KEY=xxx    ║
╚══════════════════════════════════════════╝
  `);
  if (NEWS_API_KEY) refreshNews();
});
