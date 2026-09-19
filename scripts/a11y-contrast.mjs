#!/usr/bin/env node
/**
 * a11y-contrast.mjs — WCAG 2.1 text contrast audit for VectorVroom.
 *
 * Graduated from a /tmp scratch snippet into a committed CI tool. Runs
 * headless Chromium via Playwright, walks the DOM across a matrix of
 * (theme × UI state) scenarios, and fails when any visible text element
 * falls below the required contrast ratio against its nearest opaque
 * ancestor background.
 *
 * Thresholds per WCAG 2.1 SC 1.4.3 (Contrast — Minimum, level AA):
 *   - Normal text: 4.5:1
 *   - Large text (≥24px, or ≥18.66px bold): 3.0:1
 *
 * SC 1.4.3 also exempts "inactive user interface components", so we skip
 * anything under button:disabled, [disabled], or [aria-disabled="true"].
 *
 * Usage:
 *   node scripts/a11y-contrast.mjs [--url http://localhost:8765/AI-Car-Racer/index.html]
 *
 * Exit codes: 0 = all scenarios pass, 1 = one or more failures.
 */

import { chromium } from 'playwright';

// ---------- CLI ----------
const argv = process.argv.slice(2);
let targetUrl = 'http://localhost:8765/AI-Car-Racer/index.html';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && argv[i + 1]) { targetUrl = argv[++i]; }
}

// ---------- In-page audit ----------
// Serialized and injected via page.evaluate(). All browser APIs only.
function pageAudit() {
  const srgb = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const parseColor = (s) => {
    if (!s) return null;
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).map((x) => parseFloat(x.trim())).filter((n) => !Number.isNaN(n));
    if (p.length < 3) return null;
    const alpha = p.length >= 4 ? p[3] : 1;
    return { rgb: [p[0], p[1], p[2]], a: alpha };
  };

  // Walk ancestors to find the nearest background with alpha > 0.5.
  // Anything more precise would require full alpha compositing which isn't
  // worth the complexity for an audit — the app uses mostly opaque surfaces.
  const resolveBg = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const p = parseColor(getComputedStyle(cur).backgroundColor);
      if (p && p.a > 0.5) return p.rgb;
      cur = cur.parentElement;
    }
    const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
    if (bodyBg && bodyBg.a > 0.5) return bodyBg.rgb;
    // Fallback: CSS color-scheme determines UA default. Best-effort.
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    return scheme.includes('dark') ? [0, 0, 0] : [255, 255, 255];
  };

  const isLargeText = (cs) => {
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight) || 400;
    return size >= 24 || (size >= 18.66 && weight >= 700);
  };

  // WCAG SC 1.4.3 exempts "inactive UI components". Skip disabled controls
  // and their descendants so we don't flag intentionally-muted text.
  const isUnderDisabled = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.nodeType === 1) {
        if (cur.matches && cur.matches('button:disabled, [disabled], [aria-disabled="true"]')) {
          return true;
        }
      }
      cur = cur.parentElement;
    }
    return false;
  };

  const results = [];
  const nodes = document.querySelectorAll('*');
  for (const el of nodes) {
    // Include ancestor opacity and closed disclosures in the visibility gate.
    // The collapsed training panel retains layout boxes while fully transparent.
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    // offsetParent is null for display:none and position:fixed items attached
    // to a display:none parent — close enough for a visibility gate. BODY/HTML
    // have no offsetParent by spec but we never evaluate text directly on them.
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
    if (isUnderDisabled(el)) continue;

    // Only consider direct text children (text nodes). Avoids counting a
    // container's aggregate text, which would double-flag.
    const textChunks = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = n.textContent.trim();
        if (t.length > 0) textChunks.push(t);
      }
    }
    if (textChunks.length === 0) continue;
    const text = textChunks.join(' ');

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (parseFloat(cs.opacity) < 0.5) continue;

    const fg = parseColor(cs.color);
    if (!fg) continue;
    // Fully transparent foreground: ignore (nothing rendered).
    if (fg.a < 0.1) continue;

    const bg = resolveBg(el);
    const r = ratio(fg.rgb, bg);
    const large = isLargeText(cs);
    const required = large ? 3.0 : 4.5; // WCAG 2.1 SC 1.4.3 (AA)

    if (r < required) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      results.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        id: el.id || '',
        text: text.slice(0, 80),
        fg: cs.color,
        bg: 'rgb(' + bg.join(',') + ')',
        ratio: +r.toFixed(2),
        size: cs.fontSize,
        weight: cs.fontWeight,
        large,
        required,
      });
    }
  }

  // Dedupe: same selector + text + ratio — e.g. repeated rows.
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const k = `${r.tag}|${r.cls}|${r.id}|${r.text}|${r.ratio}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }
  return unique;
}

// ---------- Scenarios ----------
// Each scenario gets a fresh page so earlier state (drawer open, collapsed
// panel) can't leak into the next assertion.
const scenarios = [
  {
    name: 'default',
    setup: async (page) => {
      if (await page.locator('#panelToggle').getAttribute('aria-expanded') === 'false') await page.click('#panelToggle');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'panel-collapsed',
    setup: async (page) => {
      if (await page.locator('#panelToggle').getAttribute('aria-expanded') === 'true') await page.click('#panelToggle');
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'eli15-drawer-open',
    setup: async (page) => {
      await page.locator('.studio-header [data-action="learn"], .eli15-fab').filter({visible:true}).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'tour-card-open',
    setup: async (page) => {
      // Drawer auto-opens on a fresh load in some builds; tour fab is
      // independent but we make sure the drawer isn't on top of it.
      const drawer = await page.$('.eli15-drawer.open, .eli15-drawer[aria-hidden="false"]');
      if (drawer) {
        const closeBtn = await page.$('.eli15-drawer-close, .eli15-close');
        if (closeBtn) await closeBtn.click().catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);
      }
      if (await page.locator('#studio-ui').isVisible()) {
        await page.locator('[data-action="settings"]').first().click();
        await page.locator('[data-action="tour"]').click();
      } else await page.click('.eli15-tour-fab');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'phase1-track-edit',
    setup: async (page) => {
      if (await page.locator('#panelToggle').getAttribute('aria-expanded') === 'false') await page.click('#panelToggle');
      await page.waitForTimeout(300);
      // Open the existing Customize Track control in the training panel.
      const btn = await page.$('.controlButton.secondary');
      if (btn) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    },
  },
  {
    name: 'studio-options',
    setup: async (page) => {
      await page.locator('[data-action="night"]').click();
      await page.locator('[data-action="vision"]').click();
      await page.locator('[data-action="settings"]').first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'classic-controls',
    setup: async (page) => {
      await page.keyboard.press('3');
      if (await page.locator('#panelToggle').getAttribute('aria-expanded') === 'false') await page.click('#panelToggle');
      await page.waitForTimeout(300);
    },
  },
];

const themes = [
  { name: 'light', colorScheme: 'light' },
  { name: 'dark', colorScheme: 'dark' },
];

// ---------- Runner ----------
async function main() {
  const browser = await chromium.launch({ headless: true });
  let totalFail = 0;
  const detailBlocks = [];

  try {
    for (const theme of themes) {
      for (const scenario of scenarios) {
        const label = `${theme.name} / ${scenario.name}`;
        const context = await browser.newContext({
          colorScheme: theme.colorScheme,
          viewport: { width: 1280, height: 900 },
        });
        const page = await context.newPage();
        try {
          await page.emulateMedia({ colorScheme: theme.colorScheme });
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
          // Give the app a moment to finish its own async boot (wasm, panels).
          await page.waitForTimeout(500);
          await page.waitForFunction(() => window.CircuitStudio?.active || window.CircuitStudio?.failed, {}, {timeout: 60000});
          await scenario.setup(page);
          const fails = await page.evaluate(pageAudit);
          const passCount = '(audited)';
          if (fails.length === 0) {
            console.log(`PASS  ${label.padEnd(32)} ${passCount}`);
          } else {
            totalFail += fails.length;
            console.log(`FAIL  ${label.padEnd(32)} ${fails.length} issue(s)`);
            const lines = [`\n--- ${label} (${fails.length} issue${fails.length === 1 ? '' : 's'}) ---`];
            for (const f of fails) {
              const sel = [f.tag, f.id && `#${f.id}`, f.cls && `.${f.cls.trim().split(/\s+/).join('.')}`]
                .filter(Boolean)
                .join('');
              lines.push(
                `  ${f.ratio.toFixed(2)} (need ${f.required}${f.large ? ' large' : ''}) ` +
                `fg=${f.fg} bg=${f.bg} ${sel}\n    "${f.text}"`
              );
            }
            detailBlocks.push(lines.join('\n'));
          }
        } catch (err) {
          totalFail += 1;
          console.log(`ERROR ${label.padEnd(32)} ${err.message}`);
          detailBlocks.push(`\n--- ${label} ---\n  ${err.stack || err.message}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (detailBlocks.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('DETAILS');
    console.log('='.repeat(60));
    for (const block of detailBlocks) console.log(block);
  }

  console.log('\n' + (totalFail === 0
    ? 'a11y-contrast: all scenarios passed'
    : `a11y-contrast: ${totalFail} failure(s) across ${detailBlocks.length} scenario(s)`));

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
