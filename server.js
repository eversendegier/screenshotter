const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { chromium } = require('playwright');

const PORT = 3000;
const isElectron = process.env.ELECTRON_APP === '1';

const SCREENSHOTS_BASE = path.join(os.tmpdir(), 'screenshotter-session');
fs.mkdirSync(SCREENSHOTS_BASE, { recursive: true });

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com',
  'doubleclick.net', 'adservice.google.com',
  'hotjar.com', 'mouseflow.com', 'crazyegg.com', 'fullstory.com',
  'clarity.ms', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
  'ads.linkedin.com', 'snap.licdn.com',
  'intercomcdn.com', 'widget.intercom.io',
  'js.hs-scripts.com', 'js.hubspot.com', 'js.usemessages.com',
  'drift.com', 'js.driftt.com',
  'crisp.chat', 'client.crisp.chat',
  'tidio.com', 'code.tidio.co',
  'zdassets.com', 'static.zdassets.com',
  'cdn.lr-ingest.io', 'logrocket.com',
  'sentry.io', 'browser.sentry-cdn.com',
];

async function launchBrowser(settings = {}) {
  const viewportWidth = settings.viewport || 1512;
  const scaleFactor = settings.scale || 2;

  let browser;
  if (isElectron) {
    for (const p of CHROME_PATHS) {
      if (fs.existsSync(p)) { browser = await chromium.launch({ executablePath: p }); break; }
    }
  }
  if (!browser) browser = await chromium.launch();

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: viewportWidth, height: 900 },
    deviceScaleFactor: scaleFactor,
  });

  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (BLOCKED_DOMAINS.some(d => url.includes(d))) return route.abort();
    route.continue();
  });

  return { browser, context };
}

const skipWords = ['privacy', 'cookie', 'disclaimer', 'voorwaarden', 'login', 'account', 'winkelwagen', 'cart', 'zoeken', 'search', 'sitemap', 'feed', 'rss', 'wp-'];

const acceptTexts = [
  'accepteer', 'accepteren', 'accept', 'akkoord', 'agree', 'toestaan',
  'toestemming', 'allow', 'allow all', 'accept all', 'alles accepteren',
  'alle cookies', 'ok', 'oke', 'oké', 'yes', 'ja', 'got it', 'begrepen',
  'sluiten', 'close', 'dismiss', 'ik begrijp het', 'i understand',
  'continue', 'doorgaan', 'confirm', 'bevestigen'
];

function getDepth(url) {
  try {
    const p = new URL(url).pathname.replace(/\/$/, '');
    return p === '' ? 0 : p.split('/').filter(Boolean).length;
  } catch(e) { return 99; }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(new URL(res.headers.location, url).href).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchSitemapUrls(base) {
  const urls = [];
  const candidates = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];

  for (const candidate of candidates) {
    try {
      const text = await fetchText(candidate);
      if (!text.includes('<loc')) continue;

      if (text.includes('<sitemapindex')) {
        const subSitemaps = [...text.matchAll(/<loc>(.*?)<\/loc>/gi)].map(m => m[1].trim());
        for (const sub of subSitemaps.slice(0, 8)) {
          try {
            const subText = await fetchText(sub);
            const locs = [...subText.matchAll(/<loc>(.*?)<\/loc>/gi)].map(m => m[1].trim());
            urls.push(...locs);
          } catch(e) {}
        }
      } else {
        const locs = [...text.matchAll(/<loc>(.*?)<\/loc>/gi)].map(m => m[1].trim());
        urls.push(...locs);
      }

      if (urls.length > 0) break;
    } catch(e) {}
  }

  return urls;
}

function filterLinks(rawUrls, host) {
  const seen = new Set();
  const links = [];

  for (const u of rawUrls) {
    try {
      const full = new URL(u).href.replace(/\/$/, '');
      if (new URL(full).hostname !== host) continue;
      if (seen.has(full)) continue;
      if (skipWords.some(w => full.toLowerCase().includes(w))) continue;
      if (/\.(pdf|jpg|png|zip|gif|svg|webp)/.test(full)) continue;
      if (getDepth(full) > 3) continue;
      seen.add(full);
      const pathname = new URL(full).pathname.replace(/\/$/, '') || '/';
      links.push({ url: full, label: pathname === '/' ? 'Homepage' : pathname });
    } catch(e) {}
  }

  return links;
}

async function injectConsentAndAntiBot(page) {
  await page.addInitScript(() => {
    // Verberg webdriver-vlag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Zet consent-cookies
    const cookies = [
      'cookieconsent_status=dismiss',
      'cookie_consent=accepted',
      'CookieConsent=true',
      'gdpr=1',
      'consent=1',
    ];
    cookies.forEach(c => { try { document.cookie = c + '; path=/; max-age=86400'; } catch(e) {} });

    // Zet consent in localStorage
    try {
      localStorage.setItem('cookieConsent', 'true');
      localStorage.setItem('cookie_consent', 'accepted');
      localStorage.setItem('gdpr_consent', '1');
      localStorage.setItem('euconsent', '1');
      localStorage.setItem('CookieConsent', JSON.stringify({
        stamp: Date.now(), necessary: true, preferences: true, statistics: true, marketing: true
      }));
    } catch(e) {}
  });
}

async function dismissPopups(page) {
  // Specifieke selectors voor bekende consent-frameworks
  const knownSelectors = [
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonAccept',
    '#CookiebotDialogBodyButtonAccept',
    '[data-cookiebotid="acceptAll"]',
    '.cc-accept-all',
    '#didomi-notice-agree-button',
    '.didomi-components-button--filled',
    '[data-testid="uc-accept-all-button"]',
    '#truste-consent-button',
    '.trustarc-agree-btn',
    'button[aria-label*="accept" i]',
    'button[aria-label*="accepteer" i]',
    'button[aria-label*="akkoord" i]',
    '[class*="CookieConsent"] button',
    '[id*="CookieConsent"] button',
    '.cookie-notice-container button',
    '#cookie-notice button',
  ];

  for (const sel of knownSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(300);
        return;
      }
    } catch(e) {}
  }

  // Fallback: zoek op button-tekst
  try {
    const buttons = await page.$$('button, a[role="button"], [class*="cookie"] button, [class*="consent"] button, [id*="cookie"] button, [id*="consent"] button');
    for (const btn of buttons) {
      try {
        const text = (await btn.innerText()).toLowerCase().trim();
        if (!await btn.isVisible()) continue;
        if (acceptTexts.some(t => text === t || text.includes(t))) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(400);
          break;
        }
      } catch(e) {}
    }
  } catch(e) {}
}

async function detectAdvancedRendering(page) {
  return await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    for (const canvas of canvases) {
      const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
      if (gl) return { detected: true, reason: 'WebGL canvas animaties' };
    }
    const signals = ['__THREE__', 'SPLINE', 'Spline'];
    for (const s of signals) {
      if (window[s]) return { detected: true, reason: `${s} animaties` };
    }
    if (document.querySelector('lottie-player, dotlottie-player')) {
      return { detected: true, reason: 'Lottie animaties' };
    }
    return { detected: false };
  });
}

async function preparePage(page) {
  await dismissPopups(page);

  // Forceer lazy images + videos te laden voor het scrollen
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"], img[data-src]').forEach(img => {
      try { if (img.dataset.src) img.src = img.dataset.src; img.removeAttribute('loading'); } catch(e) {}
    });
    document.querySelectorAll('video').forEach(v => {
      try { if (v.dataset.src && !v.src) v.src = v.dataset.src; if (v.preload === 'none') v.preload = 'auto'; v.load(); } catch(e) {}
    });
    document.querySelectorAll('iframe[data-src*="youtube"]').forEach(f => {
      try { if (!f.src) f.src = f.dataset.src; } catch(e) {}
    });
  });

  // Scroll langzaam door de pagina — triggert alle scroll-animaties en lazy content
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const distance = 200, delay = 60;
      let scrolled = 0;
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        scrolled += distance;
        if (scrolled >= total) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
      }, delay);
    });
  });

  // Wacht 2.5s zodat animaties van zichzelf uitlopen na het scrollen
  await page.waitForTimeout(2500);

  // Wacht op netwerk + fonts
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}),
    page.evaluate(() => document.fonts.ready).catch(() => {}),
  ]);

  // Nu pas bevriezen: alleen transitions stoppen zodat niets meer beweegt tijdens screenshot
  await page.evaluate(() => {
    // Chat widgets verbergen
    const chatSelectors = [
      '#intercom-container', '.intercom-namespace', '[class*="intercom-"]',
      '#hubspot-messages-iframe-container', '.HubSpotConversations',
      '#drift-widget', '#drift-frame-controller', '.drift-frame-controller',
      '#crisp-chatbox', '.crisp-client', '#tidio-chat', '#tidio-chat-code',
      '#launcher', '.zEWidget-launcher', '#zendesk',
      '[id*="chat-widget"]', '[class*="chat-widget"]',
      '.fc-widget-normal', '#freshchat-container',
    ].join(', ');
    document.querySelectorAll(chatSelectors).forEach(el => {
      try { el.style.display = 'none'; } catch(e) {}
    });

    // Sticky/fixed navbars bovenaan houden
    document.querySelectorAll('header, nav, [class*="navbar"], [class*="nav-bar"], [class*="site-header"], [class*="page-header"]').forEach(el => {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          el.style.transform = 'none'; el.style.top = '0';
          el.style.opacity = '1'; el.style.visibility = 'visible';
        }
      } catch(e) {}
    });

    // Video's pauzeren
    document.querySelectorAll('video').forEach(v => {
      try {
        v.pause();
        if (v.readyState < 2 && !v.poster) v.style.display = 'none';
        else if (v.readyState < 2 && v.poster) {
          const img = document.createElement('img');
          img.src = v.poster; img.style.cssText = v.style.cssText;
          img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
          v.parentNode.insertBefore(img, v); v.style.display = 'none';
        }
      } catch(e) {}
    });

    // Lottie pauzeren op huidig frame
    const lottie = window.lottie || window.bodymovin;
    if (lottie?.getRegisteredAnimations) {
      lottie.getRegisteredAnimations().forEach(a => { try { a.pause(); } catch(e) {} });
    }
    document.querySelectorAll('lottie-player, dotlottie-player').forEach(el => {
      try { el.pause?.(); } catch(e) {}
    });

    // Bevriezig alleen transitions + nieuwe animaties — laat huidige staat intact
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-play-state: paused !important;
      }
      html, body { overflow: visible !important; height: auto !important; }
    `;
    document.head.appendChild(style);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'GET' && reqUrl.pathname.startsWith('/screenshots/')) {
    const rel = reqUrl.pathname.replace(/^\/screenshots\//, '');
    const file = path.join(SCREENSHOTS_BASE, rel);
    if (fs.existsSync(file)) {
      const mime = file.endsWith('.webp') ? 'image/webp' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); return res.end();
  }

  if (req.method === 'POST' && reqUrl.pathname === '/open-file') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { domain, filename } = JSON.parse(body);
        const filepath = path.join(SCREENSHOTS_BASE, domain, filename);
        exec(`open -R "${filepath}"`);
      } catch(e) {}
      res.writeHead(200); res.end();
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/open-folder') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { domain } = JSON.parse(body);
        const folder = domain ? path.join(SCREENSHOTS_BASE, domain) : SCREENSHOTS_BASE;
        fs.mkdirSync(folder, { recursive: true });
        exec(`open "${folder}"`);
      } catch(e) {}
      res.writeHead(200); res.end();
    });
    return;
  }

  // Stap 1: ontdek pagina's via sitemap of link-crawl
  if (req.method === 'POST' && reqUrl.pathname === '/discover') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        let { url } = JSON.parse(body);
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const base = url.replace(/\/$/, '');
        const host = new URL(base).hostname;

        let rawUrls = await fetchSitemapUrls(base);
        let source = 'sitemap';

        if (rawUrls.length === 0) {
          source = 'crawl';
          const { browser, context } = await launchBrowser();
          const page = await context.newPage();
          await injectConsentAndAntiBot(page);
          await page.goto(base, { waitUntil: 'load', timeout: 30000 });
          rawUrls = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
          );
          rawUrls.unshift(base);
          await browser.close();
        }

        const links = filterLinks(rawUrls, host);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ links, source }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stap 2: screenshot de geselecteerde pagina's
  if (req.method === 'POST' && reqUrl.pathname === '/scan') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let { url, pages, settings = {} } = JSON.parse(body);
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const domain = new URL(url).hostname.replace('www.', '');
      const outputDir = path.join(SCREENSHOTS_BASE, domain);
      fs.mkdirSync(outputDir, { recursive: true });

      const format = settings.format || 'png';
      const ext = format === 'jpeg' ? 'jpg' : format;

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        const { browser, context } = await launchBrowser(settings);
        const total = pages.length;
        send({ type: 'total', total });

        const CONCURRENCY = 5;
        const queue = pages.map((p, i) => ({ ...p, i }));

        async function takeScreenshot(pageUrl, filepath, retries = 2) {
          for (let attempt = 1; attempt <= retries; attempt++) {
            const tab = await context.newPage();
            await injectConsentAndAntiBot(tab);
            try {
              await tab.goto(pageUrl, { waitUntil: 'load', timeout: 25000 });
              const rendering = await detectAdvancedRendering(tab);
              await preparePage(tab);
              await tab.screenshot({ path: filepath, fullPage: true, type: format });
              await tab.close();
              return { rendering };
            } catch(e) {
              await tab.close().catch(() => {});
              if (attempt === retries) throw e;
              await new Promise(r => setTimeout(r, 1500 * attempt));
            }
          }
        }

        async function worker() {
          while (queue.length > 0) {
            const { url: pageUrl, label, i } = queue.shift();
            const filename = `${String(i + 1).padStart(2, '0')}-${label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40)}.${ext}`;
            const filepath = path.join(outputDir, filename);
            try {
              const { rendering } = await takeScreenshot(pageUrl, filepath);
              const screenshotUrl = `/screenshots/${domain}/${filename}`;
              send({ type: 'screenshot', index: i + 1, total, label, url: pageUrl, filename, screenshotUrl, domain, warning: rendering.detected ? rendering.reason : null });
            } catch(e) {
              send({ type: 'error', index: i + 1, label, url: pageUrl, message: e.message.slice(0, 80) });
            }
          }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        await browser.close();
        send({ type: 'done', domain });
      } catch(e) {
        send({ type: 'fatal', message: e.message });
      }

      res.end();
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\nScreenshotter draait op http://localhost:${PORT}\n`);
});
