// UI end-to-end check: loads a sample, opens every tab, fails on console/page errors.
//   npm start (or any PRISM server) → node apps/web/test/e2e.mjs http://127.0.0.1:7777/ ironbrew2_1.lua
//   needs playwright-core + a Chromium (CHROMIUM_PATH=/path/to/chromium if not bundled)
import { chromium } from 'playwright-core';
const URL = process.argv[2] ?? 'http://127.0.0.1:7777/';
const SAMPLE = process.argv[3] ?? 'ironbrew2_1.lua';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 300)));
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1200);
await page.selectOption('.panel-head select', SAMPLE);
await page.waitForFunction(() => [...document.querySelectorAll('.pill')].some(e => /parsed clean|parse errors/.test(e.textContent)), null, { timeout: 60000 });
await page.waitForTimeout(800);
const shot = async n => page.screenshot({ path: `scratch/shots/${n}.png` });
const tab = async label => { await page.locator('.tabbar .tab', { hasText: new RegExp('^' + label + '$') }).first().click(); await page.waitForTimeout(1500); };
await shot('01-overview');
const report = {};
for (const [label, wait] of [['Deobfuscate', 800], ['Call Graph', 1500], ['Strings', 500], ['Tokens', 800], ['VM', 1500], ['Opcode Map', 3000], ['Disassembly', 1200], ['Constants', 2500], ['Search & Xrefs', 500], ['Python', 1000], ['Blob Lab', 500], ['All Tools', 1500], ['Workspace', 1000]]) {
  await tab(label); await page.waitForTimeout(wait);
  const txt = await page.locator('.panel-body').last().innerText().catch(() => '');
  report[label] = txt.replace(/\s+/g, ' ').slice(0, 160);
  await shot('tab-' + label.replace(/\W+/g, '_'));
}
for (const [k, v] of Object.entries(report)) console.log(k.padEnd(16), '|', v);
console.log('errors:', errors.length ? '\n' + errors.slice(0, 15).join('\n') : 'none');
await browser.close();
