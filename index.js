#!/usr/bin/env node

const { program } = require('commander');
const lhModule = require('lighthouse');
const lighthouse = lhModule.default;
const ChromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

program
  .name('lh-report')
  .description('Lighthouse audit CLI: JSON/HTML/PDF reports - Batch mode!')
  .argument('[input...]', 'URL(s) or @urls.txt')
  .option('-f, --format <type>', 'json|html|pdf (default: json)', 'json')
  .option('-l, --license <key>', 'Pro license for HTML/PDF')
  .option('-o, --output <dir>', 'output directory', '.')
  .option('--categories <list>', 'comma sep: performance,accessibility,best-practices,seo,pwa (default all)', 'performance,accessibility,best-practices,seo')
  .option('--compare <path>', 'Previous LHR JSON for trends comparison')
  .action(async (inputs, cmd) => {
    let urls = inputs;
    if (inputs.length === 1 && inputs[0].startsWith('@')) {
      const filePath = inputs[0].slice(1);
      urls = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    }
    if (!urls.length) {
      console.log('No URLs provided.');
      program.help();
      return;
    }
    const format = cmd.format.toLowerCase();
    const license = cmd.license;
    const isValidLicense = license === 'DEMO-PRO' || (license && license.startsWith('pro-') && license.length > 10);
    if (['html', 'pdf'].includes(format) && !isValidLicense) {
      console.error('Pro formats (html/pdf) require license key. Demo: --license DEMO-PRO');
      process.exit(1);
    }
    const outDir = cmd.output;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive: true});
    const categories = cmd.categories.split(',').map(c => c.trim());
    const flags = {
      logLevel: 'info',
      output: format === 'html' ? 'html' : 'json',
      onlyCategories: categories,
      port: 9222
    };
    let hasCompare = !!cmd.compare;
    if (hasCompare && urls.length > 1) {
      console.warn('Compare mode for batch uses same previous file for all URLs.');
    }

    // Launch Chrome for Lighthouse
    let chrome;
    try {
      chrome = await ChromeLauncher.launch({
        chromeFlags: [
          '--headless=new',
          '--remote-debugging-port=9222',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });
      console.log(`Chrome debugging on ${chrome.port}`);
    } catch (err) {
      console.error('Failed to launch Chrome:', err.message);
      process.exit(1);
    }

    try {
      for (const url of urls) {
        try {
          console.log(`\n⚡ Auditing ${url}...`);
          const { lhr, report } = await lighthouse(url, flags);
          let enhancedLhr = { ...lhr };
          let enhancedReport = report;
          let fileSuffix = '';

          if (hasCompare) {
            const prevPath = cmd.compare;
            if (!fs.existsSync(prevPath)) {
              console.error(`Previous LHR not found: ${prevPath}`);
              continue;
            }
            const prevLhr = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
            const deltas = {};
            const catKeys = Object.keys(lhr.categories);
            for (const cat of catKeys) {
              if (prevLhr.categories && prevLhr.categories[cat]) {
                const currScore = lhr.categories[cat].score;
                const prevScore = prevLhr.categories[cat].score;
                deltas[cat] = {
                  current: currScore,
                  previous: prevScore,
                  delta: currScore - prevScore
                };
              }
            }
            enhancedLhr.deltas = deltas;

            // HTML table for report
            const tableHtml = `
<div style="margin-top: 20px; padding: 20px; border: 1px solid #ddd; border-radius: 8px; background: #f9f9f9;">
  <h2 style="color: #333;">📈 Trends Comparison</h2>
  <table style="width:100%; border-collapse: collapse; font-size: 14px;">
    <thead style="background: #e9ecef;">
      <tr>
        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Category</th>
        <th style="padding: 12px; text-align: center; border-bottom: 2px solid #dee2e6;">Current</th>
        <th style="padding: 12px; text-align: center; border-bottom: 2px solid #dee2e6;">Previous</th>
        <th style="padding: 12px; text-align: center; border-bottom: 2px solid #dee2e6;">Δ</th>
      </tr>
    </thead>
    <tbody>
      ${Object.entries(deltas).map(([cat, d]) => `
      <tr style="border-bottom: 1px solid #dee2e6;">
        <td style="padding: 12px; font-weight: 500;">${cat.replace(/([A-Z])/g, ' $1').trim()}</td>
        <td style="padding: 12px; text-align: center; font-weight: bold; color: ${d.current >= 0.9 ? '#28a745' : d.current >= 0.5 ? '#ffc107' : '#dc3545'};">${(d.current * 100).toFixed(0)}%</td>
        <td style="padding: 12px; text-align: center;">${(d.previous * 100).toFixed(0)}%</td>
        <td style="padding: 12px; text-align: center; font-weight: bold; color: ${d.delta >= 0 ? '#28a745' : '#dc3545'};">${(d.delta * 100).toFixed(1)}%</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`;
            fileSuffix = `-vs-${path.basename(prevPath, '.json').slice(0,10)}`;
            if (format !== 'json') {
              enhancedReport = enhancedReport.replace(/<\/body>/i, tableHtml + '</body>');
            }
          }

          const safeName = url.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0,50) + '-lh' + fileSuffix;
          const outputBase = path.join(outDir, safeName);
          const ext = format;
          const filename = `${outputBase}.${ext}`;

          if (format === 'json') {
            fs.writeFileSync(filename, JSON.stringify(enhancedLhr, null, 2));
            console.log(`✅ JSON (with deltas): ${filename}`);
          } else if (format === 'html') {
            fs.writeFileSync(filename, enhancedReport);
            console.log(`✅ HTML (with compare): ${filename}`);
          } else if (format === 'pdf') {
            console.log('🖨️  PDF...');
            const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
            const page = await browser.newPage();
            const customCSS = `
<style>
  body { font-family: -apple-system, sans-serif; margin: 0; }
  .lh-container { max-width: 100%; }
  .lh-metric { border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .lh-metric--pass { border-left: 4px solid #28a745; }
  .lh-metric--average { border-left: 4px solid #ffc107; }
  .lh-metric--fail { border-left: 4px solid #dc3545; }
</style>`;
            const finalReport = enhancedReport.replace('</head>', customCSS + '</head>');
            await page.setContent(finalReport, { waitUntil: 'networkidle0' });
            const pdf = await page.pdf({
              format: 'A4',
              printBackground: true,
              margin: { top: '10mm', bottom: '10mm' }
            });
            await browser.close();
            fs.writeFileSync(filename, pdf);
            console.log(`✅ PDF (with compare): ${filename}`);
          }
        } catch (err) {
          console.error(`❌ ${url}: ${err.message}`);
        }
      }
    } finally {
      if (chrome) {
        await chrome.kill();
      }
    }
  });

program.parse();