import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverPublicProducts, validatePublicProductDiscoverySelection,
  type PublicProductDiscoverySelection, type PublicProductDiscoveryOptions, type PublicProductRetentionMeasurement,
} from '../src/server/product-discovery.mts';
import type { ExchangeRestResponse, ExchangeRestRequest } from '../src/server/rest-transport.mts';
import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';

const NOW = 1_790_896_923_525;
const filters = [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.0001' }];
const binance = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', filters };
const bybit = { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { qtyStep: '0.0001', basePrecision: '0.00001' } };
const okx = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', baseCcy: '', quoteCcy: '', ctType: 'linear', ctVal: '0.01', ctValCcy: 'BTC', settleCcy: 'USDT', state: 'live', tickSz: '0.1', lotSz: '1' };
const bitget = { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', category: 'USDT-FUTURES', type: 'perpetual', status: 'online', pricePrecision: '1', quantityPrecision: '4', quotePrecision: '', priceMultiplier: '0.1', quantityMultiplier: '0.0001' };
function responseText(wire: string, declaredBytes?: number) {
  const bytes = new TextEncoder().encode(wire);
  const observations = { reads: 0, canceled: 0, released: 0, bodyCanceled: 0 };
  const response: ExchangeRestResponse = { ok: true, status: 200,
    headers: { get: key => key === 'content-length' && declaredBytes !== undefined ? String(declaredBytes) : null },
    body: { cancel() { observations.bodyCanceled += 1; }, getReader() { let read = false; return {
      read() { observations.reads += 1; if (read) return { done: true }; read = true; return { done: false, value: bytes }; },
      cancel() { observations.canceled += 1; }, releaseLock() { observations.released += 1; },
    }; } },
  };
  return { response, observations, bytes: bytes.byteLength };
}
function response(payload: unknown) { return responseText(JSON.stringify(payload)); }
function bybitPage(rows: unknown[], cursor: unknown = '', category = 'linear') { return { retCode: 0, result: { category, list: rows, nextPageCursor: cursor }, time: NOW }; }
function options(selection: PublicProductDiscoverySelection, payload: unknown, changes: Partial<PublicProductDiscoveryOptions> = {}): PublicProductDiscoveryOptions {
  return { ...selection, request: () => response(payload).response, now: () => NOW, ...changes } as PublicProductDiscoveryOptions;
}
const cases: { selection: PublicProductDiscoverySelection; payload: unknown; id: string; unit: string; face?: number; tick?: number | null }[] = [
  { selection: { venue: 'hyperliquid', family: 'base-perpetual' }, payload: { universe: [{ name: 'BTC', szDecimals: 5 }] }, id: 'hyperliquid:BTC-PERP', unit: 'base', tick: null },
  { selection: { venue: 'binance', family: 'spot' }, payload: { symbols: [{ ...binance, marginAsset: undefined, contractType: undefined }] }, id: 'binance:BTCUSDT:spot', unit: 'base' },
  { selection: { venue: 'binance', family: 'usdm' }, payload: { symbols: [binance] }, id: 'binance:BTCUSDT', unit: 'base' },
  { selection: { venue: 'binance', family: 'coinm' }, payload: { symbols: [{ ...binance, symbol: 'BTCUSD_PERP', pair: 'BTCUSD', quoteAsset: 'USD', marginAsset: 'BTC', contractSize: 100 }] }, id: 'binance:BTCUSD_PERP', unit: 'contract', face: 100 },
  { selection: { venue: 'bybit', family: 'spot' }, payload: bybitPage([{ ...bybit, settleCoin: undefined, contractType: undefined }], '', 'spot'), id: 'bybit:BTCUSDT:spot', unit: 'base' },
  { selection: { venue: 'bybit', family: 'linear' }, payload: bybitPage([bybit]), id: 'bybit:BTCUSDT', unit: 'base' },
  { selection: { venue: 'bybit', family: 'inverse' }, payload: bybitPage([{ ...bybit, symbol: 'BTCUSD', quoteCoin: 'USD', settleCoin: 'BTC', contractType: 'InversePerpetual' }], '', 'inverse'), id: 'bybit:BTCUSD', unit: 'quote' },
  { selection: { venue: 'okx', family: 'spot' }, payload: { code: '0', data: [{ ...okx, instId: 'BTC-USDT', instType: 'SPOT', baseCcy: 'BTC', quoteCcy: 'USDT' }] }, id: 'okx:BTC-USDT', unit: 'base' },
  { selection: { venue: 'okx', family: 'swap' }, payload: { code: '0', data: [okx] }, id: 'okx:BTC-USDT-SWAP', unit: 'contract', face: 0.01 },
  { selection: { venue: 'bitget', family: 'spot' }, payload: { code: '00000', data: [{ ...bitget, category: 'SPOT' }] }, id: 'bitget:BTCUSDT:spot', unit: 'base' },
  { selection: { venue: 'bitget', family: 'usdt-futures' }, payload: { code: '00000', data: [bitget] }, id: 'bitget:BTCUSDT', unit: 'base' },
];
for (const fixture of cases) test('public native catalog metadata: ' + fixture.selection.venue + '/' + fixture.selection.family, async () => {
  const phases: PublicProductRetentionMeasurement[] = [], requests: ExchangeRestRequest[] = [];
  const source = response(fixture.payload);
  const result = await discoverPublicProducts(options(fixture.selection, fixture.payload, { onRetention: measurement => { phases.push(measurement); },
    request: (request, context) => { requests.push(request); assert.equal(context.page, 1); assert.ok(context.signal instanceof AbortSignal); return source.response; } }));
  assert.equal(result.products.length, 1); const product = result.products[0];
  assert.equal(product.discoveryFamily, fixture.selection.family); assert.equal(product.instrumentId, fixture.id);
  assert.equal(product.id, fixture.id); assert.equal(product.quantityUnit, fixture.unit); assert.equal(product.contractValue, fixture.face ?? null);
  assert.equal(product.isDelisted, false); assert.ok(product.lotSize > 0); assert.equal(product.lotSize, product.qtyStep);
  if (fixture.tick === null) { assert.equal(product.tickSize, null); assert.deepEqual(product.pricePrecisionRule, { maxSignificantFigures: 5, maxDecimals: 1, integerPricesAllowed: true }); }
  else assert.ok(typeof product.tickSize === 'number' && product.tickSize > 0);
  assert.equal(result.bytesRead, source.bytes); assert.equal(result.rowsSeen, 1); assert.equal(result.pages, 1);
  assert.equal(result.complete, true); assert.equal(result.nextCursor, null); assert.equal(result.memoryAdmission, 'retention-callback');
  assert.deepEqual(phases.map(item => item.phase), ['read', 'parse', 'accumulate', 'complete']);
  const complete = phases.at(-1)!; assert.equal(complete.logicalBytes, Buffer.byteLength(JSON.stringify(result.products)));
  assert.equal(complete.temporaryBytes, 0); assert.ok(phases[0].temporaryBytes > 16_777_216);
  assert.ok(phases.every(item => Number.isSafeInteger(item.logicalBytes) && Number.isSafeInteger(item.temporaryBytes)));
  const request = requests[0]; assert.equal(new URL(request.url).protocol, 'https:'); assert.equal(request.responseClass, 'catalog');
  if (fixture.selection.venue === 'hyperliquid') { assert.equal(request.method, 'POST'); assert.equal(request.body, '{"type":"meta"}'); }
  else assert.equal(request.method, 'GET');
  if (fixture.selection.venue === 'bybit' && fixture.selection.family === 'spot') assert.equal(new URL(request.url).searchParams.has('limit'), false);
  result.releaseRetention(); result.releaseRetention();
  assert.equal(phases.filter(item => item.phase === 'release').length, 1); assert.equal(phases.at(-1)!.logicalBytes, 0);
  assert.equal(result.products.length, 1); // Transferred graph remains useful to its new state owner.
});

test('explicit unsupported categories reject before constructing a public request', async () => {
  for (const [venue, family] of [['hypertracker','spot'], ['coinbase','spot'], ['hyperliquid','spot'], ['bybit','option'], ['okx','futures'], ['bitget','coin-futures'], ['binance','margin']]) {
    assert.throws(() => validatePublicProductDiscoverySelection(venue, family), /Unsupported public product/);
  }
  let requests = 0;
  await assert.rejects(() => discoverPublicProducts({ venue: 'bybit', family: 'option', request: () => { requests += 1; return response({}).response; } } as unknown as PublicProductDiscoveryOptions), /Unsupported public product/);
  assert.equal(requests, 0);
});

test('inactive and explicitly unsupported rows are excluded before active supported precision parsing', async () => {
  const result = await discoverPublicProducts(options({ venue:'okx',family:'swap' }, { code:'0', data:[okx,
    { instType:'FUTURES', state:'live', tickSz:'invalid' }, { instType:'SWAP', ctType:'quanto', state:'live', tickSz:'invalid' },
    { instType:'SWAP', ctType:'linear', state:'suspend', tickSz:'invalid' }, { ...okx, expTime:String(NOW - 1) },
  ] }));
  assert.equal(result.products.length,1); assert.equal(result.excludedUnsupported,2); assert.equal(result.excludedInactive,2); assert.equal(result.rowsSeen,5);
  result.releaseRetention();
  const dated = await discoverPublicProducts(options({venue:'binance',family:'coinm'}, {symbols:[
    { ...binance, symbol:'BTCUSD_PERP', pair:'BTCUSD', quoteAsset:'USD', marginAsset:'BTC', contractSize:100 },
    { contractType:'CURRENT_QUARTER', filters:'malformed' },
  ]}));
  assert.equal(dated.products.length,1); assert.equal(dated.excludedUnsupported,1); dated.releaseRetention();
});

test('Hyperliquid dynamic ticks and exact native case survive while HIP-3 and delisted products are explicit exclusions', async () => {
  const result = await discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'}, {universe:[
    {name:'kPEPE',szDecimals:0}, {name:'xyz:BTC',szDecimals:'invalid'}, {name:'OLD',isDelisted:true,szDecimals:'invalid'},
  ]}));
  assert.equal(result.products[0].nativeSymbol,'kPEPE'); assert.equal(result.products[0].instrumentId,'hyperliquid:KPEPE-PERP');
  assert.equal(result.products[0].qtyStep,1); assert.equal(result.excludedUnsupported,1); assert.equal(result.excludedInactive,1); result.releaseRetention();
});

test('Bybit opaque cursor pagination is exact, encoded and bounded through final empty cursor', async () => {
  const token = 'BTCUSDT,ETHUSDT=a+b/%?';
  const pages = [bybitPage([bybit], token), bybitPage([{...bybit,symbol:'ETHUSDT',baseCoin:'ETH'}])];
  const urls: URL[] = [], phases: PublicProductRetentionMeasurement[] = [];
  const result = await discoverPublicProducts({venue:'bybit',family:'linear',now:()=>NOW,
    request: descriptor => { const url = new URL(descriptor.url); urls.push(url); return response(pages[urls.length-1]).response; },
    onRetention: measurement=>{phases.push(measurement);},limits:{bybitPageSize:500,maxPages:2},
  });
  assert.equal(urls[0].searchParams.get('limit'),'500'); assert.equal(urls[0].searchParams.get('status'),'Trading');
  assert.equal(urls[0].searchParams.has('cursor'),false); assert.equal(urls[1].searchParams.get('cursor'),token);
  assert.deepEqual(result.products.map(product=>product.instrumentId),['bybit:BTCUSDT','bybit:ETHUSDT']);
  assert.equal(result.pages,2); assert.equal(result.rowsSeen,2);
  assert.equal(result.bytesRead,pages.reduce((total,page)=>total+Buffer.byteLength(JSON.stringify(page)),0));
  assert.equal(phases.at(-1)!.logicalBytes,Buffer.byteLength(JSON.stringify(result.products)));
  assert.ok(phases.some(item=>item.phase==='accumulate'&&item.cursorBytes>0)); result.releaseRetention();
});

test('duplicate cursors and duplicate products reject partial catalogs and release the accumulator', async () => {
  for (const kind of ['cursor','product']) {
    let calls=0; const phases:PublicProductRetentionMeasurement[]=[];
    const pages=[bybitPage([bybit],'same'),bybitPage([kind==='cursor'?{...bybit,symbol:'ETHUSDT',baseCoin:'ETH'}:bybit],kind==='cursor'?'same':'')];
    await assert.rejects(()=>discoverPublicProducts({venue:'bybit',family:'linear',now:()=>NOW,
      request:()=>response(pages[calls++]).response,onRetention:measurement=>{phases.push(measurement);},
    }),kind==='cursor'?/cursor was repeated/:/identity is duplicated/);
    assert.equal(calls,2); assert.equal(phases.at(-1)!.phase,'release'); assert.equal(phases.at(-1)!.logicalBytes,0);
    assert.equal(phases.at(-1)!.products,0);
  }
});

test('page, total-row and product limits never return a truncated successful catalog', async () => {
  const cases: {payload:unknown;limits:PublicProductDiscoveryOptions['limits'];pattern:RegExp}[]=[
    {payload:bybitPage([bybit],'next'),limits:{maxPages:1},pattern:/page limit/},
    {payload:bybitPage([bybit,{...bybit,symbol:'OLDUSDT',baseCoin:'OLD',status:'Settling'}]),limits:{maxRows:1},pattern:/row limit/},
    {payload:bybitPage([bybit,{...bybit,symbol:'ETHUSDT',baseCoin:'ETH'}]),limits:{maxProducts:1},pattern:/product limit/},
    {payload:bybitPage([bybit,{...bybit,symbol:'ETHUSDT',baseCoin:'ETH'}]),limits:{bybitPageSize:1},pattern:/requested row limit/},
  ];
  for(const fixture of cases){let calls=0;const phases:PublicProductRetentionMeasurement[]=[];
    await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'linear'},fixture.payload,{limits:fixture.limits,
      request:()=>{calls+=1;return response(fixture.payload).response;},onRetention:m=>{phases.push(m);}})),fixture.pattern);
    assert.equal(calls,1);assert.equal(phases.at(-1)!.phase,'release');assert.equal(phases.at(-1)!.temporaryBytes,0);
  }
});

test('cursors reject wrong types, overlong/control tokens, empty progress and unsupported spot pagination', async () => {
  for(const cursor of [123,true,'x'.repeat(1025),'bad\ntoken'])
    await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'linear'},bybitPage([bybit],cursor))),/cursor/i);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'linear'},bybitPage([],'next'))),/row progress/);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'spot'},bybitPage([{...bybit,contractType:'',settleCoin:''}],'next','spot'))),/Pagination is unsupported/);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'binance',family:'spot'},{symbols:[binance],nextPageCursor:'next'})),/Pagination is unsupported/);
});

test('declared and streamed response limits reject before metadata parsing and cancel the reader', async () => {
  const declared=responseText('this is not JSON',65);const phases:PublicProductRetentionMeasurement[]=[];
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{
    limits:{maxBytesPerPage:64},request:()=>declared.response,onRetention:m=>{phases.push(m);},
  })),/exceeds 64 bytes/);
  assert.equal(declared.observations.reads,0);assert.ok(declared.observations.canceled>=1);assert.equal(declared.observations.released,1);
  assert.deepEqual(phases.map(m=>m.phase),['read','release']);
  const streamed=responseText('x'.repeat(65));
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{limits:{maxBytesPerPage:64},request:()=>streamed.response})),/exceeds 64 bytes/);
  assert.ok(streamed.observations.canceled>=1);assert.equal(streamed.observations.released,1);
});

test('total wire-byte cap survives multiple pages without confusing logical product bytes with wire bytes', async () => {
  const a=response(bybitPage([bybit],'next')),b=response(bybitPage([{...bybit,symbol:'ETHUSDT',baseCoin:'ETH'}]));let calls=0;
  await assert.rejects(()=>discoverPublicProducts({venue:'bybit',family:'linear',now:()=>NOW,
    limits:{maxTotalBytes:a.bytes+b.bytes-1},request:()=>calls++===0?a.response:b.response,
  }),/bytes/);
  assert.equal(calls,2);assert.ok(b.observations.canceled>=1);
});

test('pre-read and exact pre-parse retention denials release all flight accounting', async () => {
  for(const phase of ['read','parse','accumulate','complete']){
    let calls=0;const phases:PublicProductRetentionMeasurement[]=[];const wire=response({universe:[{name:'BTC',szDecimals:3}]});
    await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{
      request:()=>{calls+=1;return wire.response;},onRetention:m=>{phases.push(m);return m.phase!==phase;},
    })),phase==='parse'?/body could not be read/:/retention admission rejected/);
    assert.equal(calls,phase==='read'?0:1);assert.equal(phases.at(-1)!.phase,'release');assert.equal(phases.at(-1)!.logicalBytes,0);
    if(phase==='parse')assert.ok(wire.observations.canceled>=1);
  }
});

test('malformed active native currency, precision, contract face and settlement fail closed', async () => {
  for(const change of [{contractSize:0},{contractSize:true},{contractSize:'Infinity'},{quoteAsset:'USDT'},{marginAsset:'ETH'},{pair:'ETHUSD'},{symbol:'BTCUSD_FAKE'}])
    await assert.rejects(()=>discoverPublicProducts(options({venue:'binance',family:'coinm'},{symbols:[{...binance,symbol:'BTCUSD_PERP',pair:'BTCUSD',quoteAsset:'USD',marginAsset:'BTC',contractSize:100,...change}]})),/COIN-M/);
  for(const change of [{ctVal:0},{ctValCcy:'BTC'},{settleCcy:'USD'},{quoteCcy:'USDT'},{instId:'ETH-USD-SWAP',baseCcy:'BTC'}])
    await assert.rejects(()=>discoverPublicProducts(options({venue:'okx',family:'swap'},{code:'0',data:[{...okx,instId:'BTC-USD-SWAP',ctType:'inverse',ctVal:'100',ctValCcy:'USD',settleCcy:'BTC',...change}]})),/OKX/);
  for(const change of [{quoteCoin:'USD'},{symbol:'ETHUSDT'},{priceMultiplier:'0'},{quantityMultiplier:false},{pricePrecision:'19'}])
    await assert.rejects(()=>discoverPublicProducts(options({venue:'bitget',family:'usdt-futures'},{code:'00000',data:[{...bitget,...change}]})),/Bitget/);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'inverse'},bybitPage([{...bybit,symbol:'BTCUSD',quoteCoin:'USD',settleCoin:'USDT',contractType:'InversePerpetual'}],'','inverse'))),/Bybit/);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{universe:[{name:'BTC',szDecimals:7}]})),/szDecimals/);
  await assert.rejects(()=>discoverPublicProducts(options({venue:'binance',family:'spot'},{symbols:[{...binance,filters:[...filters,filters[0]]}]})),/duplicated/);
});

test('provider errors, wrong envelopes and category mismatch cannot create a complete catalog', async () => {
  const bad:{selection:PublicProductDiscoverySelection;payload:unknown}[]=[
    {selection:{venue:'bybit',family:'linear'},payload:bybitPage([bybit],'','inverse')},
    {selection:{venue:'bybit',family:'linear'},payload:{retCode:10001,result:{category:'linear',list:[bybit]}}},
    {selection:{venue:'bitget',family:'spot'},payload:{code:'401',data:[]}},
    {selection:{venue:'okx',family:'spot'},payload:{code:'0',data:{}}},
    {selection:{venue:'binance',family:'usdm'},payload:{code:-1003,msg:'Too many requests'}},
    {selection:{venue:'hyperliquid',family:'base-perpetual'},payload:[]},
  ];
  for(const fixture of bad)await assert.rejects(()=>discoverPublicProducts(options(fixture.selection,fixture.payload)));
  const rejected=response({});rejected.response.ok=false;rejected.response.status=429;
  await assert.rejects(()=>discoverPublicProducts(options({venue:'okx',family:'spot'},{},{request:()=>rejected.response})),/HTTP response failed/);
  assert.equal(rejected.observations.bodyCanceled,1);assert.equal(rejected.observations.reads,0);
});

test('an inverse OKX catalog preserves quote face currency independently of price', async () => {
  const result=await discoverPublicProducts(options({venue:'okx',family:'swap'},{code:'0',data:[{...okx,
    instId:'BTC-USD-SWAP',ctType:'inverse',ctVal:'100',ctValCcy:'USD',settleCcy:'BTC',
  }]}));
  const product=result.products[0];assert.equal(product.inverse,true);assert.equal(product.contractType,'inverse');
  assert.equal(product.contractValue,100);assert.equal(product.contractValueCurrency,'USD');assert.equal(product.settleCoin,'BTC');
  assert.equal(product.quantityUnit,'contract');result.releaseRetention();
});

test('invalid limits and clock are rejected before request; defaults cannot be raised', async () => {
  for(const limits of [{maxBytesPerPage:16_777_217},{maxTotalBytes:16_777_217},{maxPages:33},{maxRows:10_001},
    {maxProducts:10_001},{maxCursorBytes:1025},{bybitPageSize:1001},{timeoutMs:12001},{maxPages:0},{maxRows:1.5}]){
    let calls=0;await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{universe:[]},{limits,
      request:()=>{calls+=1;return response({universe:[]}).response;}})),/positive bounded integer/);assert.equal(calls,0);
  }
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{universe:[]},{now:()=>Number.NaN})),/clock/);
});

test('aborting a sleeping raw request cleans retention and cancels a late response', async () => {
  const controller=new AbortController(),phases:PublicProductRetentionMeasurement[]=[];
  let resolveResponse:((value:ExchangeRestResponse)=>void)|undefined;
  const pending=new Promise<ExchangeRestResponse>(resolve=>{resolveResponse=resolve;});
  const promise=discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{signal:controller.signal,
    onRetention:m=>{phases.push(m);},request:()=>pending}));
  controller.abort(new Error('test abort'));
  await assert.rejects(()=>promise,/test abort/);assert.equal(phases.at(-1)!.phase,'release');
  const late=response({universe:[]});assert.ok(resolveResponse);resolveResponse(late.response);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(late.observations.bodyCanceled,1);
});

test('a noncompliant loader ignoring its abort signal still observes the bounded request timeout', async () => {
  const phases:PublicProductRetentionMeasurement[]=[];
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{limits:{timeoutMs:20},
    request:()=>new Promise<ExchangeRestResponse>(()=>{}),onRetention:m=>{phases.push(m);}})),/timed out/);
  assert.equal(phases.at(-1)!.logicalBytes,0);
});

test('bounded JSON complexity is checked before catalog parsing', async () => {
  const wire=responseText('['.repeat(65)+'0'+']'.repeat(65));const phases:PublicProductRetentionMeasurement[]=[];
  await assert.rejects(()=>discoverPublicProducts(options({venue:'hyperliquid',family:'base-perpetual'},{},{request:()=>wire.response,onRetention:m=>{phases.push(m);}})),/nested JSON levels/);
  assert.deepEqual(phases.map(m=>m.phase),['read','release']);assert.ok(wire.observations.canceled>=1);
});


test('Binance spot uses the official permission-set projection without narrowing active market identities or raising byte caps', async () => {
  let observed = '';
  const result = await discoverPublicProducts(options({venue:'binance',family:'spot'}, {symbols:[{...binance,contractType:undefined,marginAsset:undefined}]},
    {request: descriptor => { observed=descriptor.url; return response({symbols:[{...binance,contractType:undefined,marginAsset:undefined}]}).response; }}));
  const url=new URL(observed);assert.equal(url.searchParams.get('permissions'),'SPOT');assert.equal(url.searchParams.get('showPermissionSets'),'false');
  assert.equal(url.searchParams.has('symbolStatus'),false);assert.equal(result.products.length,1);result.releaseRetention();
});
test('unsupported Binance margin quotes are counted without poisoning verified USD-M products', async () => {
  const result=await discoverPublicProducts(options({venue:'binance',family:'usdm'}, {symbols:[binance,
    {...binance,symbol:'ETHBTC',baseAsset:'ETH',quoteAsset:'BTC',marginAsset:'BTC'},
    {...binance,symbol:'BTCUSD1',quoteAsset:'USD1',marginAsset:'USD1'},
  ]}));
  assert.equal(result.products.length,1);assert.equal(result.excludedUnsupported,2);result.releaseRetention();
});
test('Bybit native USDC perpetual catalog identity is base plus PERP with a verified USDC settlement', async () => {
  const result=await discoverPublicProducts(options({venue:'bybit',family:'linear'},bybitPage([{...bybit,symbol:'BTCPERP',quoteCoin:'USDC',settleCoin:'USDC'}])));
  assert.equal(result.products[0].instrumentId,'bybit:BTCPERP');assert.equal(result.products[0].quote,'USDC');assert.equal(result.products[0].settleCoin,'USDC');result.releaseRetention();
  await assert.rejects(()=>discoverPublicProducts(options({venue:'bybit',family:'linear'},bybitPage([{...bybit,symbol:'BTCPERP',quoteCoin:'USDC',settleCoin:'USDT'}]))),/settlement mismatch/);
});

test('Bitget mixed-case asset names keep native identity and unsupported Unicode products remain explicit', async () => {
  const spot=await discoverPublicProducts(options({venue:'bitget',family:'spot'}, {code:'00000',data:[{...bitget,category:'SPOT',symbol:'RTSLAUSDT',baseCoin:'rTSLA'}]}));
  assert.equal(spot.products[0].instrumentId,'bitget:RTSLAUSDT:spot');assert.equal(spot.products[0].base,'RTSLA');assert.equal(spot.products[0].nativeBase,'rTSLA');spot.releaseRetention();
  const futures=await discoverPublicProducts(options({venue:'bitget',family:'usdt-futures'},{code:'00000',data:[bitget,{...bitget,symbol:'龙虾USDT',baseCoin:'龙虾'}]}));
  assert.equal(futures.products.length,1);assert.equal(futures.excludedUnsupported,1);futures.releaseRetention();
});
