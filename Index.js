// index.js
// Playwright scraper that posts new leak cards to a Discord webhook.
//
// Configure with environment variables (see .env.example).

const fs = require('fs').promises;
const path = require('path');
const { chromium } = require('playwright');
const { fetch } = require('undici'); // lightweight fetch

// --- Configurable ---
const TARGET_URL = process.env.TARGET_URL || 'https://ugcleaks.short-term.workers.dev/leaks';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK; // required
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || '60'); // loop interval
const DATA_FILE = process.env.DATA_FILE || path.resolve(__dirname, 'seen.json');
const HEADLESS = (process.env.HEADLESS || 'true') === 'true';
const RUN_ONCE = (process.env.RUN_ONCE || 'false') === 'true';

// Mapping category label text -> role id to ping
const CATEGORIES = [
  { key: 'upcoming', label: 'upcoming', roleId: '1545880166683906118' },
  { key: 'paid', label: 'paid', roleId: '1545880048567984188' },
  { key: 'regular', label: 'regular', roleId: '1545881749064646777' },
  { key: 'abandoned', label: 'abandoned', roleId: '1545880971415527504' },
  { key: 'active', label: 'active', roleId: '1545881407656558612' },
];

// Heuristics / selectors (tweak if needed for the site's markup)
const CARD_ANCESTOR_SELECTOR = '[class*="card"], article, .item, [class*="leak"], .leak-card'; // used by Element.closest()
const BUY_LINK_TEXT = 'Buy from Roblox'; // exact link text we search for
const TITLE_SELECTORS = ['h3', 'h2', '.title', '.name'];
const DESC_SELECTORS = ['.description', '.desc', 'p'];
const TIME_SELECTORS = ['time', '.timestamp', '.time', '.date'];

// Discord embed color (blue)
const EMBED_COLOR = 0x3498db; // decimal color

if (!DISCORD_WEBHOOK) {
  console.error('ERROR: DISCORD_WEBHOOK environment variable is required.');
  process.exit(1);
}

async function loadSeen() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch (err) {
    return new Set();
  }
}

async function saveSeen(seenSet) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(Array.from(seenSet), null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write seen file:', err);
  }
}

function makeUniqueId(item) {
  // prefer the buy link href as unique id, otherwise title+time fallback
  if (item.href) return item.href;
  return `${item.title || ''}::${item.time || ''}`;
}

async function postToDiscord(payload) {
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('Discord webhook returned non-OK:', res.status, text);
    }
  } catch (err) {
    console.error('Failed to post to Discord webhook:', err);
  }
}

async function extractCardDataFromBuyLink(page, buyLinkElement) {
  // evaluate in page context to extract title, description, time, and href
  return buyLinkElement.evaluate((el, CARD_ANCESTOR_SELECTOR, TITLE_SELECTORS, DESC_SELECTORS, TIME_SELECTORS) => {
    function getClosestCard(element) {
      // try several selectors via closest; if none, fallback to parent chain
      const selectors = CARD_ANCESTOR_SELECTOR.split(',').map(s => s.trim()).filter(Boolean);
      for (const sel of selectors) {
        const card = element.closest(sel);
        if (card) return card;
      }
      // fallback: ascend 4 levels to find a reasonable container
      let cur = element;
      for (let i = 0; i < 4 && cur; i++) {
        cur = cur.parentElement;
        if (cur && cur.querySelector) {
          // heuristic: if it contains a header or time, consider it a card
          if (cur.querySelector('h2,h3,time')) return cur;
        }
      }
      return null;
    }

    const card = getClosestCard(el) || el.parentElement || el;
    function findTextOnCard(selectors) {
      for (const sel of selectors) {
        try {
          const node = card.querySelector(sel);
          if (node && node.innerText && node.innerText.trim()) return node.innerText.trim();
        } catch (e) {}
      }
      return '';
    }

    const title = findTextOnCard(TITLE_SELECTORS) || (card.querySelector('a')?.innerText?.trim() || '');
    const desc = findTextOnCard(DESC_SELECTORS) || '';
    const timeNode = (function() {
      for (const sel of TIME_SELECTORS) {
        try {
          const n = card.querySelector(sel);
          if (n) return n;
        } catch (e) {}
      }
      return null;
    })();
    const time = timeNode ? (timeNode.getAttribute('datetime') || timeNode.innerText || '') : '';
    const href = el.href || (el.getAttribute && el.getAttribute('href')) || '';
    return { title: title.trim(), desc: desc.trim(), time: (time || '').toString().trim(), href };
  }, CARD_ANCESTOR_SELECTOR, TITLE_SELECTORS, DESC_SELECTORS, TIME_SELECTORS);
}

async function processCategory(page, seen, category) {
  // attempt to click a category filter/tab/button by visible text first
  try {
    const label = category.label;
    const tab = page.locator(`text=${label}`);
    if (await tab.count() > 0) {
      try {
        await tab.first().click({ timeout: 5000 });
        // wait for potential XHR
        await page.waitForLoadState('networkidle').catch(()=>{});
        await page.waitForTimeout(1000);
      } catch (e) {
        // clicking might not be necessary; ignore
      }
    }
  } catch (err) {
    // ignore
  }

  // find buy links on page
  const buyLinks = page.locator(`a:has-text("${BUY_LINK_TEXT}")`);
  const count = await buyLinks.count();
  if (count === 0) {
    // fallback: sometimes the button text is different or in a button inside an anchor
    // We'll also try links where href contains "roblox" as fallback
    const fallback = page.locator('a[href*="roblox"]');
    if (await fallback.count() === 0) return;
    // reassign
  }

  const actualLocator = (await buyLinks.count()) > 0 ? buyLinks : page.locator('a[href*="roblox"]');

  for (let i = 0; i < await actualLocator.count(); i++) {
    const el = actualLocator.nth(i);
    try {
      const data = await extractCardDataFromBuyLink(page, el);
      const uid = makeUniqueId(data);
      if (seen.has(uid)) continue;

      // Build Discord payload
      const embed = {
        title: data.title || 'New leak',
        description: data.desc || undefined,
        url: data.href || TARGET_URL,
        color: EMBED_COLOR,
        timestamp: (new Date()).toISOString(),
        footer: {
          text: `Category: ${category.key}`
        }
      };
      const content = category.roleId ? `<@&${category.roleId}>` : undefined;
      const payload = content
        ? { content, embeds: [embed] }
        : { embeds: [embed] };

      await postToDiscord(payload);
      seen.add(uid);
      // small delay between posts to avoid being rate-limited
      await page.waitForTimeout(500);
    } catch (err) {
      console.error('Error extracting/posting a card:', err);
    }
  }
}

(async () => {
  console.log('Starting scraper', TARGET_URL);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  const seen = await loadSeen();

  async function runOnce() {
    try {
      await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 30000 });
    } catch (err) {
      console.warn('Failed to load page (will retry next cycle):', err.message);
      return;
    }

    for (const category of CATEGORIES) {
      try {
        await processCategory(page, seen, category);
      } catch (err) {
        console.error(`Error processing category ${category.key}:`, err);
      }
      // small pause between categories
      await page.waitForTimeout(700);
    }

    await saveSeen(seen);
  }

  if (RUN_ONCE) {
    // run a single cycle and exit (useful for CI / GitHub Actions)
    await runOnce();
    await browser.close();
    console.log('Run-once complete, exiting.');
    process.exit(0);
  }

  // initial run
  await runOnce();

  // schedule loop
  const intervalMs = Math.max(10, CHECK_INTERVAL_SECONDS) * 1000;
  console.log(`Scheduler running every ${intervalMs / 1000}s`);
  setInterval(async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('Unexpected error in scheduled run:', err);
    }
  }, intervalMs);

  // keep process alive
})();
