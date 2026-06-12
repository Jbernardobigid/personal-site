import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe';
const url = process.argv[2] || 'http://localhost:3000';
const width = parseInt(process.argv[3] || '375', 10);

if (!Number.isInteger(width) || width < 1) {
  console.error(`Invalid viewport width "${process.argv[3]}" — expected a positive integer, e.g. 375`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800, isMobile: true, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });

  const report = await page.evaluate((vw) => {
    const docW = document.documentElement.scrollWidth;
    // Clipped by a NON-root ancestor (e.g. .marquee-strip). We ignore body/html
    // because their clip is exactly what we're auditing and Chrome still reports
    // escaping fixed elements in documentElement.scrollWidth.
    const isClipped = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true;
        p = p.parentElement;
      }
      return false;
    };

    const offenders = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5 || r.left < -0.5) {
        if (isClipped(el)) continue; // clipped: doesn't contribute to page scroll
        const style = getComputedStyle(el);
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: (el.className && el.className.toString) ? el.className.toString().slice(0, 70) : '',
          left: Math.round(r.left * 10) / 10,
          right: Math.round(r.right * 10) / 10,
          width: Math.round(r.width),
          overflowX: style.overflowX,
          position: style.position,
        });
      }
    }
    // Rank by worst overflow in either direction (right past vw, or left past 0)
    const severity = (o) => Math.max(o.right - vw, -o.left);
    offenders.sort((a, b) => severity(b) - severity(a));
    return { vw, docW, bodyScrollW: document.body.scrollWidth, count: offenders.length, offenders: offenders.slice(0, 30) };
  }, width);

  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(`Overflow check failed for ${url}: ${err.message}`);
  console.error('Is the dev server running? Start it with: node serve.mjs');
  process.exitCode = 1;
} finally {
  await browser.close();
}
