import test from 'node:test';
import assert from 'node:assert/strict';
import {createSdkExchange} from '../scripts/automatic-sdk.js';
import {RequestRejectedError} from '@polymarket/client';
const wallet='0x1111111111111111111111111111111111111111';
const state={conditionId:'condition',market:{slug:'btc-updown-5m-0',end:300,up_token:'up',down_token:'down',fee_taker_only:true},config:{capital:10,order_dollars:3,allow_taker:false}};
const intent={localId:'1',side:'Up',price:'0.44',shares:'5'};
function mock() {
 const posted=[];
 const client={account:{wallet},fetchPortfolioValue:async()=>({wallet,value:'0'}),listOpenOrders:async function*(){yield {items:[]};},listPositions:async function*(){yield {items:[]};},
  fetchOrderBook:async()=>({assetId:'up',conditionId:'condition',negRisk:false,tickSize:'0.01',minOrderSize:'5'}),
  createLimitOrder:async order=>{posted.push(order);return {signed:true};},
  postOrder:async()=>({ok:true,orderId:'order'}),
  cancelOrder:async()=>({canceled:['order']}),fetchOrder:async()=>({id:'order',makerAddress:wallet,assetId:'up',side:'BUY',sizeMatched:'5',originalSize:'5',status:'MATCHED'}),
  listAccountTrades:async function*(){yield {items:[{id:'trade',conditionId:'condition',bucketIndex:0,status:'TRADE_STATUS_CONFIRMED',makerOrders:[{orderId:'order',makerAddress:wallet,assetId:'up',side:'BUY',matchedAmount:'5',price:'0.44',feeRateBps:'0'}]}]};}};
 return {client,posted};
}
test('SDK reconciliation uses own confirmed maker execution and exact amounts',async()=>{
 const {client}=mock();const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},now:()=>101});
 assert.deepEqual(await exchange.fills('order'),[{orderId:'order',id:'trade:0',status:'CONFIRMED',shares:'5',price:'0.44',fee:'0'}]);
});
test('missing matched fills return pending marker',async()=>{
 const {client}=mock();client.listAccountTrades=async function*(){yield {items:[]};};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 assert.equal((await exchange.fills('order'))[0].status,'PENDING');
});

test('overlapping trade pages cannot hide missing account fills',async()=>{
 const {client}=mock();const pages=client.listAccountTrades;
 client.listAccountTrades=async function*(){for await(const page of pages()){yield page;yield structuredClone(page);}};
 client.fetchOrder=async()=>({id:'order',makerAddress:wallet,assetId:'up',side:'BUY',sizeMatched:'10'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 const fills=await exchange.fills('order');
 assert.equal(fills.filter(f=>f.status==='CONFIRMED').length,1);
 assert.equal(fills.at(-1).status,'PENDING');
});

test('a match arriving during history pagination holds new submissions',async()=>{
 const {client}=mock();let reads=0;
 client.fetchOrder=async()=>({id:'order',makerAddress:wallet,assetId:'up',side:'BUY',sizeMatched:++reads===1?'5':'8'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 assert.equal((await exchange.fills('order')).at(-1).status,'PENDING');
});

test('changed payload across overlapping pages is rejected',async()=>{
 const {client}=mock();const pages=client.listAccountTrades;
 client.listAccountTrades=async function*(){for await(const page of pages()){
   yield page;const changed=structuredClone(page);changed.items[0].makerOrders[0].matchedAmount='4';yield changed;
 }};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 await assert.rejects(exchange.fills('order'),/changed across pages/);
});

test('duplicate trade confirmation advances status without double counting',async()=>{
 const {client}=mock();const pages=client.listAccountTrades;
 client.listAccountTrades=async function*(){for await(const page of pages()){
   const pending=structuredClone(page);pending.items[0].status='TRADE_STATUS_MINED';yield pending;yield page;
 }};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 assert.equal((await exchange.fills('order')).length,1);
 assert.equal((await exchange.fills('order'))[0].status,'CONFIRMED');
});
test('ownership mismatch stops reconciliation',async()=>{
 const {client}=mock();client.fetchOrder=async()=>({id:'order',makerAddress:'other',side:'BUY'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 await assert.rejects(exchange.fills('order'),/ownership/);
});
test('placement without reviewed preflight is rejected',async()=>{
 const {client,posted}=mock();const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 await assert.rejects(exchange.place(intent),/reviewed/);assert.equal(posted.length,0);
});
test('preflighted automatic cycle uses post-only SDK BUY and caps',async()=>{
 const {client,posted}=mock();const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},now:()=>101,readBalance:async()=>({balance:10000000n})});
 await exchange.startup(state);await exchange.preflight(intent,state);await exchange.place(intent);
 assert.deepEqual(posted,[{tokenId:'up',side:'BUY',price:'0.44',size:'5',postOnly:true}]);
});
test('live price ceiling rejects a 90-cent order before signing',async()=>{
 const {client,posted}=mock();
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  now:()=>101,readBalance:async()=>({balance:10000000n})});
 const guarded={...state,config:{...state.config,order_dollars:5,max_entry_price:0.75}};
 await assert.rejects(exchange.preflight({...intent,price:'0.90'},guarded),
  /Entry price exceeds the live safety ceiling/);
 assert.equal(posted.length,0);
});
test('SDK-wrapped signing failure remains a safe rejected intent before posting',async()=>{
 const {client}=mock();const signGuard={intent:null};let posts=0;
 client.createLimitOrder=async()=>{throw Error('SDK-wrapped signing error');};
 client.postOrder=async()=>{posts++;};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  signGuard,now:()=>101,readBalance:async()=>({balance:10000000n})});
 await exchange.startup(state);await exchange.preflight(intent,state);
 await assert.rejects(exchange.place(intent),{code:'LOCAL_GUARD_REJECTED'});
 assert.equal(signGuard.intent,null);
 assert.equal(posts,0);
});
test('transport failure after posting remains ambiguous',async()=>{
 const {client}=mock();const signGuard={intent:null};
 client.postOrder=async()=>{throw Error('transport timeout');};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  signGuard,now:()=>101,readBalance:async()=>({balance:10000000n})});
 await exchange.startup(state);await exchange.preflight(intent,state);
 await assert.rejects(exchange.place(intent),/transport timeout/);
 assert.equal(signGuard.intent,null);
});
test('explicit 400 exchange rejection can be skipped without ambiguous submission',async()=>{
 const {client}=mock();
 client.postOrder=async()=>{throw new RequestRejectedError('order rejected',{status:400});};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  now:()=>101,readBalance:async()=>({balance:10000000n})});
 await exchange.startup(state);await exchange.preflight(intent,state);
 await assert.rejects(exchange.place(intent),{code:'DEFINITE_ORDER_REJECTED'});
});
test('startup stops on insufficient capital or preexisting orders',async()=>{
 const {client}=mock();const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},readBalance:async()=>({balance:1n})});
 await assert.rejects(exchange.startup(state),/capital/);
 const funded=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},readBalance:async()=>({balance:10000000n})});
 client.listOpenOrders=async function*(){yield {items:[{id:'unrelated'}]};};
 await assert.rejects(funded.startup(state),/Existing orders/);
});
test('a failed cancel request is reconciled only when the owned order is terminal',async()=>{
 const {client}=mock();client.cancelOrder=async()=>{throw Error('Already closed');};
 client.fetchOrder=async()=>({id:'order',makerAddress:wallet,assetId:'up',side:'BUY',
   sizeMatched:'1.2',originalSize:'5.24',status:'CANCELED'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 assert.deepEqual(await exchange.cancel('order'),{canceled:['order']});
 client.fetchOrder=async()=>({id:'order',makerAddress:wallet,assetId:'up',side:'BUY',
   sizeMatched:'1.2',originalSize:'5.24',status:'LIVE'});
 await assert.rejects(exchange.cancel('order'),/Already closed/);
 client.fetchOrder=async()=>({id:'order',makerAddress:'other',assetId:'up',side:'BUY',
   sizeMatched:'1.2',originalSize:'5.24',status:'CANCELED'});
 await assert.rejects(exchange.cancel('order'),/ownership/);
});

test('multi-asset automatic mode accepts ETH and rejects unsupported assets',async()=>{
 const {client}=mock();
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  now:()=>101,readBalance:async()=>({balance:10000000n})});
 await exchange.startup(state);
 await exchange.preflight(intent,state);
 const eth=structuredClone(state);eth.market.slug='eth-updown-5m-0';
 await exchange.startup(eth);
 const wrong=structuredClone(state);wrong.market.slug='doge-updown-5m-0';
 await assert.rejects(exchange.startup(wrong),/crypto Up\/Down 5m/);
});
test('an order exceeding available collateral is rejected before signing',async()=>{
 const {client}=mock();client.fetchPortfolioValue=async()=>({wallet,value:'1'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  now:()=>101,readBalance:async()=>({balance:2000000n})});
 await assert.rejects(exchange.preflight(intent,state),{code:'LOCAL_PREFLIGHT_REJECTED'});
});

test('startup checks normalized currentSize rather than historical size',async()=>{
 const {client}=mock();client.listPositions=async function*(){yield {items:[{conditionId:'condition',currentSize:'5',totalSize:'10'}]};};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{},
  readBalance:async()=>({balance:10000000n})});
 await assert.rejects(exchange.startup(state),/Existing market inventory/);
 client.listPositions=async function*(){yield {items:[{conditionId:'condition',currentSize:'0',totalSize:'10'}]};};
 await exchange.startup(state);
});

test('unconfirmed official trade status never credits account inventory',async()=>{
 const {client}=mock();const pages=client.listAccountTrades;
 client.listAccountTrades=async function*(){for await(const page of pages()){
  page.items[0].status='TRADE_STATUS_MINED';yield page;
 }};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 assert.equal((await exchange.fills('order'))[0].status,'PENDING');
});

test('trade reconciliation rejects another market and a nonzero maker fee',async()=>{
 const {client}=mock();const original=client.listAccountTrades;
 client.listAccountTrades=async function*(){for await(const page of original()){
  page.items[0].conditionId='other';yield page;
 }};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 await assert.rejects(exchange.fills('order'),/market mismatch/);
 client.listAccountTrades=async function*(){for await(const page of original()){
  page.items[0].makerOrders[0].feeRateBps='1';yield page;
 }};
 await assert.rejects(exchange.fills('order'),/maker fee/);
});

test('bounded exit submits FOK sells for session-owned BTC inventory only',async()=>{
 const {client}=mock();const sells=[];
 client.listPositions=async function*(){yield {items:[
  {wallet,conditionId:'condition',assetId:'up',currentSize:'5'},
  {wallet,conditionId:'condition',assetId:'down',currentSize:'3'}]};};
 client.estimateMarketPrice=async request=>{assert.equal(request.side,'SELL');assert.equal(request.orderType,'FOK');return .41;};
 client.placeMarketOrder=async request=>{sells.push(request);return {ok:true,orderId:'exit-'+sells.length,status:'matched',tradeIds:['trade-'+sells.length]};};
 client.waitForOrderFillSettlement=async()=>['0xsettled'];
 client.fetchOrder=async({orderId})=>({id:orderId,makerAddress:wallet,assetId:sells[Number(orderId.slice(-1))-1].tokenId,
  side:'SELL',sizeMatched:sells[Number(orderId.slice(-1))-1].shares});
 const engine={state:async()=>state};
 const exchange=createSdkExchange({client,engine,eligible:async()=>{}});
 const exitState=structuredClone(state);exitState.portfolio={paired_shares:'3',residual_up:'2',residual_down:'0'};
 const recorded=[];await exchange.liquidateOwnPositions(exitState,r=>recorded.push(r));
 assert.deepEqual(sells,[
  {tokenId:'up',side:'SELL',shares:'5',minPrice:.41,orderType:'FOK'},
  {tokenId:'down',side:'SELL',shares:'3',minPrice:.41,orderType:'FOK'}]);
 assert.equal(recorded.length,4);
 assert.equal(recorded.at(-1).confirmed,true);
});

test('bounded exit refuses inventory not attributable to this session',async()=>{
 const {client}=mock();client.listPositions=async function*(){yield {items:[{wallet,conditionId:'condition',assetId:'up',currentSize:'6'}]};};
 client.placeMarketOrder=async()=>{throw Error('should not sell');};
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 const exitState=structuredClone(state);exitState.portfolio={paired_shares:'0',residual_up:'5',residual_down:'0'};
 await assert.rejects(exchange.liquidateOwnPositions(exitState),/exceeds this session/);
});

test('take-profit sells only confirmed single-side BTC inventory above cost and fee buffer',async()=>{
 const {client}=mock();const sells=[];let quote=.45;
 client.listPositions=async function*(){yield {items:[{wallet,conditionId:'condition',assetId:'up',currentSize:'10'}]};};
 client.estimateMarketPrice=async()=>quote;
 client.placeMarketOrder=async request=>{sells.push(request);return {ok:true,orderId:'exit',status:'matched',tradeIds:['trade']};};
 client.waitForOrderFillSettlement=async()=>['0xsettled'];
 client.fetchOrder=async()=>({id:'exit',makerAddress:wallet,assetId:'up',side:'SELL',sizeMatched:'10'});
 const exchange=createSdkExchange({client,engine:{state:async()=>state},eligible:async()=>{}});
 const held=structuredClone(state);held.portfolio={paired_shares:'0',residual_up:'10',residual_down:'0',total_cost:'4.00'};
 assert.equal(await exchange.profitOpportunity(held),false);
 assert.deepEqual(await exchange.liquidateOwnPositions(held,async()=>{},true),[]);
 quote=.55;
 assert.equal(await exchange.profitOpportunity(held),true);
 const exits=await exchange.liquidateOwnPositions(held,async()=>{},true);
 assert.equal(exits.length,1);assert.equal(exits[0].confirmed,true);
 assert.equal(sells.length,1);assert.equal(sells[0].minPrice,.55);
 held.portfolio.paired_shares='1';
 assert.equal(await exchange.profitOpportunity(held),false);
});

