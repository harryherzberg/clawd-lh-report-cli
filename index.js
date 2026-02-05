#!/usr/bin/env node

const { program } = require('commander');
const lighthouse = require('lighthouse');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

program
  .name('lh-report')
  .description('Lighthouse audit CLI: JSON/HTML/PDF reports - Batch mode!')
  .argument('[input...]', 'URL(s) or @urls.txt')
  .option('-f, --format &lt;type&gt;', 'json|html|pdf (default: json)', 'json')
  .option('-l, --license &lt;key&gt;', 'Pro license for HTML/PDF')
  .option('-o, --output &lt;dir&gt;', 'output directory', '.')
  .option('--categories &lt;list&gt;', 'comma sep: performance,accessibility,best-practices,seo (default all)', 'performance,accessibility,best-practices,seo')
  .action(async (inputs, cmd) =&gt; {
    let urls = inputs;
    if (inputs.length === 1 &amp;&amp; inputs[0].startsWith('@')) {
      const filePath = inputs[0].slice(1);
      urls = fs.readFileSync(filePath, 'utf8').split(/\\r?\\n/).map(l =&gt; l.trim()).filter(Boolean);
    }
    if (!urls.length) {
      console.log('No URLs provided.');
      program.help();
      return;
    }
    const format = cmd.format.toLowerCase();
    const license = cmd.license;
    const isValidLicense = license === 'DEMO-PRO' || (license &amp;&amp; license.startsWith('pro-') &amp;&amp; license.length &gt; 10);
    if (['html', 'pdf'].includes(format) &amp;&amp; !isValidLicense) {
      console.error('Pro formats (html/pdf) require license key. Demo: --license DEMO-PRO');
      process.exit(1);
    }
    const outDir = cmd.output;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive: true});
    const categories = cmd.categories.split(',').map(c =&gt; c.trim());
    const flags = {
      logLevel: 'info',
      output: format === 'html' ? 'html' : 'json',
      onlyCategories: categories,
    };
    for (const url of urls) {
      try {
        console.log(`\\n⚡ Auditing ${url}...`);
        const { lhr, report } = await lighthouse(url, flags, null);
        const safeName = url.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0,50) + '-lh';
        const outputBase = path.join(outDir, safeName);
        const ext = format;
        const filename = `${outputBase}.${ext}`;
        if (format === 'json') {
          fs.writeFileSync(filename, JSON.stringify(lhr, null, 2));
          console.log(`✅ JSON: ${filename}`);
        } else if (format === 'html') {
          fs.writeFileSync(filename, report);
          console.log(`✅ HTML: ${filename}`);
        } else if (format === 'pdf') {
          console.log('🖨️  PDF...');
          const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
          const page = await browser.newPage();
          // Prettier: add custom CSS to LH report
          const customCSS = `
&lt;style&gt;
  body { font-family: -apple-system, sans-serif; margin: 0; }
  .lh-container { max-width: 100%; }
  .lh-metric { border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .lh-metric--pass { border-left: 4px solid #28a745; }
  .lh-metric--average { border-left: 4px solid #ffc107; }
  .lh-metric--fail { border-left: 4px solid #dc3545; }
&lt;/style&gt;`;
          const enhancedReport = report.replace('&lt;/head&gt;', customCSS + '&lt;/head&gt;');
          await page.setContent(enhancedReport, { waitUntil: 'networkidle0' });
          const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', bottom: '10mm' }
          });
          await browser.close();
          fs.writeFileSync(filename, pdf);
          console.log(`✅ PDF: ${filename}`);
        }
      } catch (err) {
        console.error(`❌ ${url}: ${err.message}`);
      }
    }
  });

program.parse();