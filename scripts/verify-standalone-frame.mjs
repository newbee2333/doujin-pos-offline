import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['scripts/serve-static.mjs','dist'],{env:{...process.env,PORT:'5197',HOST:'127.0.0.1'},stdio:'ignore'});
let browser;
try {
 for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:5197')).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.launch({channel:'msedge'});
 for(const standalone of [false,true]){
 const context=await browser.newContext();context.on('dialog',d=>d.accept());
 if(standalone)await context.addInitScript(()=>{
  const supports=CSS.supports.bind(CSS);CSS.supports=(...args)=>args[0]==='-webkit-touch-callout'?true:supports(...args);
  Object.defineProperty(navigator,'standalone',{value:true});
 });
 const page=await context.newPage();await page.goto('http://127.0.0.1:5197');
 await page.getByRole('button',{name:'建立新的空数据库'}).click();
 await page.locator('.sidebar').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('standalone-safe-frame')),standalone);
 for(const [width,height] of [[1180,820],[820,1180],[390,844]]){
 await page.setViewportSize({width,height});
 const top=await page.locator('#root').evaluate(e=>e.getBoundingClientRect().top);
 assert.equal(top,standalone?72:0);
 assert.ok(await page.locator('.sidebar').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight+1));
 if(standalone){
  await page.evaluate(()=>{const marker=document.createElement('div');marker.id='scroll-probe';marker.style.height='2000px';document.querySelector('.main').append(marker);document.querySelector('#root').scrollTop=500;});
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.sidebar').evaluate(e=>Math.round(e.getBoundingClientRect().top)),72);
  assert.equal(await page.evaluate(()=>scrollY),0);
  assert.equal(await page.evaluate(()=>document.elementFromPoint(100,40)?.closest('#root')===null),true);
  await page.evaluate(()=>{document.querySelector('#scroll-probe').remove();document.querySelector('#root').scrollTop=0;});
 }
 console.log('PASS',standalone?'simulated Apple standalone':'ordinary browser',width,height);
 }
 if(standalone){
 await page.evaluate(()=>{const modal=document.createElement('div');modal.className='modal-backdrop';modal.innerHTML='<div class="modal"><input placeholder="test"></div>';document.querySelector('#root').append(modal);});
 assert.equal(await page.locator('.modal-backdrop').evaluate(e=>Math.round(e.getBoundingClientRect().top)),72);
 await page.locator('.modal input').fill('输入正常');
 console.log('PASS modal bounded below protected strip; input editable');
 }
 await context.close();
 }
}finally{await browser?.close();server.kill();}
