import fs from 'node:fs/promises';
import { buildBinanceRequest } from '../src/adapters/binance.mts';
import { buildBybitRequest } from '../src/adapters/bybit.mts';
import { buildBitgetRequest } from '../src/adapters/bitget.mts';
import { readBoundedJsonResponse } from '../src/core/bounded-json-response.mts';
const fields=(v:unknown):Record<string,unknown>=>v!=null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const profiles=[['binance-usdm',buildBinanceRequest('exchangeInfo')],['bybit-linear',buildBybitRequest('instruments',{category:'linear',limit:1000})],
 ['bitget-spot',buildBitgetRequest('instruments',{category:'spot'})],['bitget-usdt-futures',buildBitgetRequest('instruments',{category:'usdt-futures'})]] as const;
const results:Record<string,unknown>[]=[];
for(const [profile,descriptor]of profiles){
 const payload=fields(await readBoundedJsonResponse(await fetch(descriptor.url,{signal:AbortSignal.timeout(12000)}),{maxBytes:16*1024*1024}));
 const nested=fields(payload.result);const data=payload.symbols??nested.list??payload.data;
 if(!Array.isArray(data))throw new Error('Catalog rows missing:'+profile);
 const rows=data.map(fields);let unusual:Record<string,unknown>[]=[];
 if(profile==='binance-usdm')unusual=rows.filter(r=>r.contractType==='PERPETUAL'&&r.status==='TRADING'&&(r.marginAsset!==r.quoteAsset||!['USDT','USDC'].includes(String(r.quoteAsset))));
 if(profile==='bybit-linear')unusual=rows.filter(r=>r.contractType==='LinearPerpetual'&&r.status==='Trading'&&(r.symbol!==String(r.baseCoin)+String(r.quoteCoin)||r.settleCoin!==r.quoteCoin||!['USDT','USDC'].includes(String(r.quoteCoin))));
 if(profile.startsWith('bitget'))unusual=rows.filter(r=>r.status==='online'&&(!/^[A-Z0-9][A-Z0-9._-]*$/.test(String(r.symbol))||!/^[A-Z0-9][A-Z0-9._-]*$/.test(String(r.baseCoin))));
 results.push({profile,url:descriptor.url,count:rows.length,unusual:unusual.slice(0,12).map(r=>Object.fromEntries(['symbol','status','symbolStatus','baseAsset','quoteAsset','marginAsset','baseCoin','quoteCoin','settleCoin','contractType','quantityMultiplier','pricePrecision'].map(key=>[key,r[key]??null])))});
}
const report={kind:'public-native-product-schema-diagnostic',checkedAt:new Date().toISOString(),readOnly:true,results};
await fs.writeFile('docs/acceptance/visual-parity/m9-venues/public-products-native-diagnostic-2026-10-02.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
