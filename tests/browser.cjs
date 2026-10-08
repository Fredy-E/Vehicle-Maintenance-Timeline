'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'test-results');
const results = [];
async function eqText(page, selector, text) {
  await page.waitForFunction(({s,t}) => document.querySelector(s)?.textContent.trim() === t, {s:selector,t:text}, {timeout:5000});
}
async function count(page, selector, n) {
  await page.waitForFunction(({s,n}) => document.querySelectorAll(s).length === n, {s:selector,n}, {timeout:5000});
}
async function download(page, selector, name) {
  const event = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await event;
  assert.equal(await file.failure(), null);
  const dest = path.join(ART, name);
  await file.saveAs(dest);
  return fs.readFile(dest,'utf8');
}
async function mobile(page) {
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    const overflow=await page.evaluate(() => Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth);
    assert.ok(overflow<=1, 'Mobile body overflow at '+width+' px: '+overflow+' px');
  }
  await page.setViewportSize({width:1440,height:1000});
}
async function execute(browser, name, callback, storageBlocked=false) {
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  if(storageBlocked) await context.addInitScript(() => Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked for test','SecurityError');}}));
  const page=await context.newPage();
  const errors=[]; const requests=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request', r=>{if(/^https?:/i.test(r.url())) requests.push(r.url());});
  try {
    await callback(page);
    assert.deepEqual(errors,[],'Unexpected page/console errors');
    assert.deepEqual(requests,[],'Unexpected network requests');
    results.push({name,status:'pass',errors,externalRequests:requests});
    console.log('PASS '+name);
  } catch(error) {
    results.push({name,status:'fail',message:error.message,stack:error.stack,errors,externalRequests:requests});
    console.error('FAIL '+name+'\n'+error.stack);
    await page.screenshot({path:path.join(ART,name.replace(/\W+/g,'-')+'-failure.png'),fullPage:true});
  } finally {await context.close();}
}
async function open(page, repo) {
  await page.goto(pathToFileURL(path.join(ROOT,'index.html')).href,{waitUntil:'load'});
}
async function addService(page, desc='Fictional oil change') {
  await page.locator('#entry-date').fill('2026-10-01');
  await page.locator('#entry-mileage').fill('60000');
  await page.locator('#entry-category').fill('Oil');
  await page.locator('#entry-description').fill(desc);
  await page.locator('#entry-cost').fill('50.25');
  await page.locator('#entry-next-mileage').fill('65000');
  await page.locator('#entry-submit').click();
}
async function maintenance(page) {
  await open(page,'Vehicle-Maintenance-Timeline');
  await page.waitForFunction(()=>!!window.MaintenanceApp);
  const layout=await page.evaluate(()=>({panelRight:document.querySelector('#vehicle-panel').getBoundingClientRect().right,timelineLeft:document.querySelector('#timeline-panel').getBoundingClientRect().left}));
  assert.ok(layout.panelRight<=layout.timelineLeft, 'Desktop form overlaps timeline by '+(layout.panelRight-layout.timelineLeft)+' px');
  await page.locator('#vehicle-nickname').fill('Fictional Blue Wagon');
  await page.locator('#vehicle-odometer').fill('70000');
  await page.locator('#vehicle-save').click();
  await addService(page);
  await count(page,'.entry-card',1);
  assert.equal(await page.locator('.entry-schedule').getAttribute('data-status'),'overdue');
  await page.locator('.entry-edit').click();
  await page.locator('#entry-description').fill('Changed <img src=x onerror=alert(1)> safely');
  await page.locator('#entry-submit').click();
  assert.match(await page.locator('.entry-description').textContent(),/<img/);
  assert.equal(await page.locator('.entry-description img').count(),0);
  await page.locator('#filter-search').fill('does-not-exist');
  await count(page,'.entry-card',0);
  await page.locator('#filter-reset').click();
  await count(page,'.entry-card',1);
  await page.locator('.entry-delete').click();
  await page.locator('#confirm-cancel').click();
  await count(page,'.entry-card',1);
  await page.locator('#btn-load-sample').click();
  await page.locator('#confirm-cancel').click();
  await count(page,'.entry-card',1);
  const backup=await download(page,'#btn-export-json','maintenance-backup.json');
  assert.equal(JSON.parse(backup).entries.length,1);
  await page.locator('#import-text').fill('{broken');
  await page.locator('#btn-import').click();
  assert.equal(await page.locator('#import-errors').isVisible(),true);
  await count(page,'.entry-card',1);
  await page.locator('#import-file').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await page.waitForFunction(text => document.querySelector('#import-text').value === text, backup);
  await page.locator('#btn-import').click();
  await page.locator('#confirm-accept').click();
  await count(page,'.entry-card',1);
  await page.reload();
  await count(page,'.entry-card',1);
  assert.equal(await page.locator('#storage-status').getAttribute('data-mode'),'storage');
  assert.equal(await page.locator('#storage-banner').isVisible(),false);
  const beforeDuplicateImport=await page.evaluate(()=>JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])));
  const duplicateDoc=JSON.parse(backup);
  duplicateDoc.entries.push({...duplicateDoc.entries[0],description:'Fictional duplicate-id record'});
  await page.locator('#import-text').fill(JSON.stringify(duplicateDoc));
  await page.locator('#btn-import').click();
  assert.equal(await page.locator('#import-errors').isVisible(),true,'Duplicate-id import did not show errors');
  assert.equal(await page.locator('#confirm-dialog').isVisible(),false,'Invalid import opened a destructive confirmation');
  await count(page,'.entry-card',1);
  assert.equal(await page.evaluate(()=>JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))),beforeDuplicateImport,'Invalid import changed saved bytes');
  await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
  await page.locator('#btn-print').click();
  assert.equal(await page.evaluate(()=>window.__printed),true);
  assert.match(await page.locator('#print-root').textContent(),/Fictional Blue Wagon/);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#print-root').isVisible(),true);
  await page.emulateMedia({media:'screen'});
  await mobile(page);
  // Exercise real sample button: its combined date+mileage badges are longer.
  await page.locator('#btn-load-sample').click();
  await page.locator('#confirm-accept').click();
  await page.locator('.entry-schedule').first().waitFor();
  await mobile(page);
  await page.screenshot({path:path.join(ART,'maintenance.png'),fullPage:true});
}
async function blockedMaintenance(page) {
  await open(page,'Vehicle-Maintenance-Timeline');
  await addService(page);
  await count(page,'.entry-card',1);
  assert.equal(await page.locator('#storage-status').getAttribute('data-mode'),'memory');
  assert.match(await page.locator('#storage-status').textContent(),/memory/i);
  const backup=await download(page,'#btn-export-json','maintenance-memory-backup.json');
  assert.equal(JSON.parse(backup).entries.length,1);
}

// Regression: on a fresh load the browser's own print flow (Ctrl+P fires
// `beforeprint`) must build the report — it used to print the empty shell.
async function printBeforePrint(page) {
  await open(page,'Vehicle-Maintenance-Timeline');
  await page.waitForFunction(()=>!!window.MaintenanceApp);
  assert.equal(await page.evaluate(()=>document.querySelector('#print-root').children.length),0,'fresh load: the print shell starts empty');
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
  await page.waitForFunction(()=>document.querySelector('#print-root').children.length>0);
  const emptyText=await page.locator('#print-root').textContent();
  assert.match(emptyText,/Vehicle Maintenance Timeline/);
  assert.match(emptyText,/\(unnamed\)/,'vehicle line must be present');
  assert.match(emptyText,/Records: 0/,'record count line must be present');
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.evaluate(()=>document.querySelector('#print-root').hidden),true,'afterprint must re-hide the shell');
  // With a record loaded, the next beforeprint must rebuild with fresh data.
  await addService(page,'Fictional beforeprint record');
  await count(page,'.entry-card',1);
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
  await page.waitForFunction(()=>document.querySelector('#print-root').textContent.includes('Fictional beforeprint record'));
  // The Print-button path keeps working on top of the same builder.
  await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
  await page.locator('#btn-print').click();
  assert.equal(await page.evaluate(()=>window.__printed),true);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#print-root').isVisible(),true);
  await page.emulateMedia({media:'screen'});
  await page.screenshot({path:path.join(ART,'beforeprint-report.png'),fullPage:true});
}

// Regression: "__proto__"/"constructor"-named categories must behave like any
// other category in the filter dropdown, the datalist and the record counts.
async function prototypeCategories(page) {
  await open(page,'Vehicle-Maintenance-Timeline');
  await page.waitForFunction(()=>!!window.MaintenanceApp);
  const doc={format:'vehicle-maintenance-timeline',version:1,updatedAt:'2026-10-08T00:00:00.000Z',vehicle:{nickname:'Fictional Proto Wagon',odometer:70000,unit:'km'},entries:[
    {id:'e-proto-1',createdAt:'2026-10-08T00:00:00.000Z',date:'2026-06-01',mileage:68000,category:'__proto__',description:'Fictional proto-named category',parts:'',cost:null,receipt:'',notes:'',nextDate:null,nextMileage:null},
    {id:'e-ctor-1',createdAt:'2026-10-08T00:00:00.000Z',date:'2026-06-02',mileage:68500,category:'constructor',description:'Fictional constructor-named category',parts:'',cost:null,receipt:'',notes:'',nextDate:null,nextMileage:null},
  ]};
  await page.locator('#import-text').fill(JSON.stringify(doc));
  await page.locator('#btn-import').click();
  await page.locator('#confirm-accept').click();
  await count(page,'.entry-card',2);
  const optionValues=()=>page.evaluate(()=>[...document.querySelectorAll('#filter-category option')].map(o=>o.value));
  assert.ok((await optionValues()).includes('__proto__'),'the "__proto__" category must appear in the filter dropdown');
  assert.ok((await optionValues()).includes('constructor'),'"constructor" must appear in the filter dropdown');
  const datalist=await page.evaluate(()=>[...document.querySelectorAll('#category-options option')].map(o=>o.value));
  assert.ok(datalist.includes('__proto__'),'the "__proto__" category must appear in the category datalist');
  assert.ok(datalist.includes('constructor'),'"constructor" must appear in the category datalist');
  await page.locator('#filter-category').selectOption('__proto__');
  await count(page,'.entry-card',1);
  assert.equal(await page.locator('.entry-category').textContent(),'__proto__');
  assert.match(await page.locator('#list-summary').textContent(),/showing 1 of 2/);
  await page.locator('#filter-category').selectOption('constructor');
  await count(page,'.entry-card',1);
  assert.equal(await page.locator('.entry-category').textContent(),'constructor');
  await page.locator('#filter-reset').click();
  await count(page,'.entry-card',2);
  await page.screenshot({path:path.join(ART,'prototype-categories.png'),fullPage:true});
}

(async()=>{
  await fs.mkdir(ART,{recursive:true});
  const launch={headless:true};
  const channel=process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32' ? 'chrome' : '');
  if(channel) launch.channel=channel;
  let browser;
  try {
    browser=await chromium.launch(launch);
  } catch(error) {
    if(!launch.channel) throw error;
    console.log('[browser] channel "'+launch.channel+'" unavailable ('+String(error.message).split('\n')[0]+'); using bundled chromium');
    delete launch.channel;
    browser=await chromium.launch(launch);
  }
  try {
    await execute(browser,"maintenance-main",maintenance,false);
    await execute(browser,"maintenance-ctrl-print",printBeforePrint,false);
    await execute(browser,"maintenance-prototype-categories",prototypeCategories,false);
    await execute(browser,"maintenance-blocked-storage",blockedMaintenance,true);
  } finally {await browser.close();}
  await fs.writeFile(path.join(ART,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
  const failed=results.filter(x=>x.status==='fail');
  console.log(JSON.stringify({cases:results.length,pass:results.length-failed.length,fail:failed.length}));
  if(!results.length || failed.length)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
