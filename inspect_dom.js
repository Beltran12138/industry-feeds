const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
puppeteerExtra.use(StealthPlugin());

async function inspect() {
  const browser = await puppeteerExtra.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.goto('https://www.theblockbeats.info/newsflash', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 8000));
  const bbItems = await page.evaluate(() => {
     return Array.from(document.querySelectorAll('.news-flash-item')).map(el => {
       return {
         html: el.innerHTML.substring(0, 300),
         text: el.innerText.replace(/\n/g, ' ')
       };
     }).slice(0, 3);
  });
  fs.writeFileSync('bb_debug.json', JSON.stringify(bbItems, null, 2));

  await page.goto('https://www.gate.com/zh/announcements', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 8000));
  const gateItems = await page.evaluate(() => {
     return Array.from(document.querySelectorAll('a[href*="/announcements/"], a[href*="/article/"]')).map(a => {
       const container = a.closest('.item, .article-item, li, tr') || a.parentElement;
       return {
         href: a.href,
         text: a.innerText.replace(/\n/g, ' '),
         containerText: container ? container.innerText.replace(/\n/g, ' ') : ''
       };
     }).slice(0, 5);
  });
  fs.writeFileSync('gate_debug.json', JSON.stringify(gateItems, null, 2));

  await browser.close();
}
inspect().catch(console.error);
