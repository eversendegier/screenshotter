const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { chromium } = require('playwright');

const PORT = 3000;
const isElectron = process.env.ELECTRON_APP === '1';

const SCREENSHOTS_BASE = isElectron
  ? path.join(os.homedir(), 'Documents', 'Screenshotter')
  : path.join(__dirname, 'screenshots');

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

async function launchBrowser() {
  let browser;
  if (isElectron) {
    for (const p of CHROME_PATHS) {
      if (fs.existsSync(p)) { browser = await chromium.launch({ executablePath: p }); break; }
    }
  }
  if (!browser) browser = await chromium.launch();

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1512, height: 900 },
    deviceScaleFactor: 2,
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

  // Scroll door de hele pagina om lazy-load content te triggeren
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const distance = 400, delay = 30;
      let scrolled = 0;
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        scrolled += distance;
        if (scrolled >= total) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
      }, delay);
    });
  });

  // Wacht op netwerk + afbeeldingen + lottie-players klaar
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}),
    page.waitForFunction(() => {
      if (![...document.images].every(img => img.complete)) return false;
      const players = [...document.querySelectorAll('lottie-player, dotlottie-player')];
      return players.every(p => p.getLottie?.() || p.shadowRoot?.querySelector('canvas, svg'));
    }, { timeout: 8000 }).catch(() => {}),
  ]);

  // Wacht extra op video's en fonts
  await Promise.all([
    page.evaluate(() => document.fonts.ready).catch(() => {}),
    page.evaluate(() => Promise.all(
      [...document.querySelectorAll('video')].map(v =>
        v.readyState >= 2 ? Promise.resolve() : new Promise(r => v.addEventListener('loadeddata', r, { once: true }))
      )
    )).catch(() => {}),
  ]);

  await page.evaluate(() => {
    // Chat widgets verbergen
    const chatSelectors = [
      '#intercom-container', '.intercom-namespace', '[class*="intercom-"]',
      '#hubspot-messages-iframe-container', '.HubSpotConversations',
      '#drift-widget', '#drift-frame-controller', '.drift-frame-controller',
      '#crisp-chatbox', '.crisp-client',
      '#tidio-chat', '#tidio-chat-code',
      '#launcher', '.zEWidget-launcher', '#zendesk',
      '[id*="chat-widget"]', '[class*="chat-widget"]',
      '.fc-widget-normal', '#freshchat-container',
    ].join(', ');
    document.querySelectorAll(chatSelectors).forEach(el => {
      try { el.style.display = 'none'; } catch(e) {}
    });

    // Sticky/fixed navbars: herstel naar top (ondanks hide-on-scroll JS)
    document.querySelectorAll('header, nav, [class*="navbar"], [class*="nav-bar"], [class*="site-header"], [class*="page-header"]').forEach(el => {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          el.style.transform = 'none';
          el.style.top = '0';
          el.style.opacity = '1';
          el.style.visibility = 'visible';
          el.style.transition = 'none';
        }
      } catch(e) {}
    });

    // GSAP
    const g = window.gsap || window.GSAP;
    if (g) {
      try { g.globalTimeline.progress(1); } catch(e) {}
      try { g.killTweensOf('*'); } catch(e) {}
    }
    if (window.ScrollTrigger) {
      try { window.ScrollTrigger.getAll().forEach(t => { try { t.progress(1); } catch(e) {} }); } catch(e) {}
    }

    // AOS (Animate on Scroll)
    if (window.AOS) {
      try { window.AOS.refreshHard?.(); } catch(e) {}
    }
    document.querySelectorAll('[data-aos]').forEach(el => {
      try {
        el.classList.add('aos-animate');
        el.style.transitionDuration = '0s';
        el.style.animationDuration = '0s';
      } catch(e) {}
    });

    // Lottie-web / bodymovin
    const lottie = window.lottie || window.bodymovin;
    if (lottie?.getRegisteredAnimations) {
      lottie.getRegisteredAnimations().forEach(anim => {
        try { anim.goToAndStop(0, true); } catch(e) {}
      });
    }

    // <lottie-player> en <dotlottie-player> web components
    document.querySelectorAll('lottie-player, dotlottie-player').forEach(el => {
      try {
        el.stop?.();
        el.seek?.(0);
        if (el.getLottie?.()) el.getLottie().goToAndStop(0, true);
      } catch(e) {}
    });

    // Video's pauzeren op eerste frame
    document.querySelectorAll('video').forEach(v => {
      try { v.pause(); v.currentTime = 0; } catch(e) {}
    });

    // CSS animaties en transities bevriezen
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      html, body { overflow: visible !important; height: auto !important; }
    `;
    document.head.appendChild(style);

    // Verborgen elementen zichtbaar maken (entrance-animaties die nog niet af zijn)
    document.querySelectorAll('*').forEach(el => {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.opacity === '0' || cs.visibility === 'hidden') {
          el.style.opacity = '1';
          el.style.visibility = 'visible';
        }
        if (cs.transform && cs.transform !== 'none') el.style.transform = 'none';
      } catch(e) {}
    });
  });

  // Extra wachttijd voor lottie-players om te renderen na seek
  const hasLottie = await page.$('lottie-player, dotlottie-player');
  await page.waitForTimeout(hasLottie ? 600 : 200);
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
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); return res.end();
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
      let { url, pages } = JSON.parse(body);
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const domain = new URL(url).hostname.replace('www.', '');
      const outputDir = path.join(SCREENSHOTS_BASE, domain);
      fs.mkdirSync(outputDir, { recursive: true });

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        const { browser, context } = await launchBrowser();
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
              await tab.screenshot({ path: filepath, fullPage: true });
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
            const filename = `${String(i + 1).padStart(2, '0')}-${label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40)}.png`;
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
