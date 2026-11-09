import { strict as assert } from 'node:assert';
import { validateHatches, applyHatchAttributes, hatchEnvironment, refuseMissingHatchSecrets, type EdgeHatchSpec } from './edge-hatches.ts';
const hatch:EdgeHatchSpec={name:'orders',edge:{src:'commerce/dist/edge.js',route:'/commerce',publicAttributes:{'data-commerce-mode':'live'},email:{name:'MAIL',recipients:['davi@example.test']}}};
Deno.test('edge hatch routes cannot shadow privileged routes or escape app sources',()=>{
 validateHatches([hatch]);
 for(const route of ['/crud','/import','/auth','/commerce/child','/rtc-ice','/']) assert.throws(()=>validateHatches([{...hatch,edge:{...hatch.edge,route}}]));
 for(const src of ['../edge.js','commerce/../edge.js','/edge.js']) assert.throws(()=>validateHatches([{...hatch,edge:{...hatch.edge,src}}]));
 assert.throws(()=>validateHatches([hatch,hatch]),/Duplicate hatch route/);
 assert.throws(()=>validateHatches([{...hatch,edge:{...hatch.edge,publicAttributes:{'data-commerce-mode':'"><script>'}}}]));
});
Deno.test('only edge output receives explicit live attributes; authored Pages demo stays unchanged',async()=>{
 const root=await Deno.makeTempDir();
 try {
  await Deno.mkdir(`${root}/edge`);
  const html='<section data-commerce-mode="mock"><p>demo</p></section>';
  await Deno.writeTextFile(`${root}/page.html`,html);
  await Deno.writeTextFile(`${root}/edge/print.html`,html);
  await applyHatchAttributes(`${root}/edge`,[hatch]);
  assert.equal(await Deno.readTextFile(`${root}/page.html`),html);
  assert.equal(await Deno.readTextFile(`${root}/edge/print.html`),html.replace('"mock"','"live"'));
  await assert.rejects(() => applyHatchAttributes(`${root}/edge`, [{...hatch, edge: {...hatch.edge, publicAttributes: {'data-missing': 'live'}}}]), /Missing public hatch attribute/);
 } finally {await Deno.remove(root,{recursive:true});}
});

Deno.test('publish requires declared hatch settings without baking their values into artifacts', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/edge-environment.json`, JSON.stringify(['PAYMENT_KEY']));
    await assert.rejects(() => hatchEnvironment(root, () => undefined), /Missing required.*PAYMENT_KEY/);
    assert.deepEqual(await hatchEnvironment(root, () => 'test-secret'), {PAYMENT_KEY: 'test-secret'});
    assert.equal((await Deno.readTextFile(`${root}/edge-environment.json`)).includes('test-secret'), false);
    assert.throws(() => validateHatches([{...hatch, edge: {...hatch.edge, environment: ['JWT_SECRET']}}]));
    assert.throws(() => validateHatches([{...hatch, edge: {...hatch.edge, environment: ['MAIL']}}]));
  } finally {await Deno.remove(root, {recursive:true});}
});
Deno.test('a declared secret is neither required nor uploaded, even when the environment holds it; a setting still is', async () => {
 const root = await Deno.makeTempDir();
 try {
  await Deno.writeTextFile(`${root}/edge-environment.json`, JSON.stringify(['PRICE']));
  await Deno.writeTextFile(`${root}/edge-secrets.json`, JSON.stringify(['PAYMENT_KEY']));
  const asked: string[] = [];
  const held: Record<string, string> = {PRICE: '100', PAYMENT_KEY: 'live-value'};
  assert.deepEqual(await hatchEnvironment(root, name => { asked.push(name); return held[name]; }), {PRICE: '100'});
  assert.deepEqual(asked, ['PRICE'], 'the publisher does not read a declared secret');
  await assert.rejects(() => hatchEnvironment(root, () => undefined), /Missing required edge hatch setting: PRICE/);
 } finally { await Deno.remove(root, {recursive: true}); }
});
Deno.test('a binding cannot be both a setting and a secret, or use a reserved name', () => {
 assert.throws(() => validateHatches([{...hatch, edge: {...hatch.edge, environment: ['KEY'], secrets: ['KEY']}}]), /both a setting and a secret/);
 assert.throws(() => validateHatches([{...hatch, edge: {...hatch.edge, secrets: ['JWT_SECRET']}}]), /Invalid hatch environment binding/);
});
Deno.test('an existing Worker missing a declared secret refuses the publish; a first deploy and a temporary one have nothing to list', async () => {
 const root = await Deno.makeTempDir();
 try {
  await Deno.writeTextFile(`${root}/edge-secrets.json`, JSON.stringify(['PAYMENT_KEY', 'ORDER_SECRET']));
  const listed: string[][] = [];
  const check = (names: string[], deployed: boolean, temporary = false) => refuseMissingHatchSecrets({
   directory: root, configs: ['worker.jsonc'], temporary,
   deployedBefore: () => Promise.resolve(deployed),
   wrangler: args => { listed.push(args); return Promise.resolve(JSON.stringify(names.map(name => ({name, type: 'secret_text'})))); },
  });
  await assert.rejects(() => check(['PAYMENT_KEY'], true), /Worker secrets missing for worker.jsonc: ORDER_SECRET/);
  assert.deepEqual(listed[0], ['secret', 'list', '--config', 'worker.jsonc', '--format', 'json']);
  await check(['PAYMENT_KEY', 'ORDER_SECRET'], true);
  listed.length = 0;
  await check([], false);
  await check([], true, true);
  assert.equal(listed.length, 0);
 } finally { await Deno.remove(root, {recursive: true}); }
});
