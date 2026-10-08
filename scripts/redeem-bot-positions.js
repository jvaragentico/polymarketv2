import {appendFileSync, existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const runName=/^automatic-[a-f0-9]{12}$/;
const cryptoSlug=/^(btc|eth|xrp|sol)-updown-5m-\d+$/;
const conditionId=/^0x[0-9a-fA-F]{64}$/;
const txHash=/^0x[0-9a-fA-F]{64}$/;

export function confirmedBotMarkets(runsDirectory) {
  if(!existsSync(runsDirectory))return new Set();
  const markets=new Set();
  for(const entry of readdirSync(runsDirectory,{withFileTypes:true})) {
    if(!entry.isDirectory() || !runName.test(entry.name))continue;
    try {
      const report=JSON.parse(readFileSync(join(runsDirectory,entry.name,'report.json'),'utf8'));
      if(report.execution_mode==='exchange_confirmed' && cryptoSlug.test(report.market?.slug) &&
          report.actions?.some(a=>a.action==='confirmed_fill' && typeof a.fill_id==='string' && a.fill_id.length>4))
        markets.add(report.market.slug);
    } catch { /* An active or incomplete journal is not evidence of a bot fill. */ }
  }
  return markets;
}

function appendDurable(path,record) {
  // The intent is persisted before calling the relayer. An unknown result must
  // never be automatically resubmitted in a later continuous session.
  appendFileSync(path,JSON.stringify(record)+'\n',{encoding:'utf8',flush:true});
}

export async function redeemBotPositions({client,runsDirectory=join(process.cwd(),'runs'),onStatus=()=>{}}) {
  const markets=confirmedBotMarkets(runsDirectory);
  if(!markets.size)return {confirmed:0,pending:0};
  const journal=join(runsDirectory,'redemptions.jsonl');
  const attempted=new Set();
  if(existsSync(journal))for(const line of readFileSync(journal,'utf8').split(/\r?\n/)) {
    if(!line)continue;
    try {const row=JSON.parse(line);if(row.kind==='attempt' && conditionId.test(row.conditionId))attempted.add(row.conditionId.toLowerCase());}
    catch {throw new Error('Redemption journal is invalid; inspect it before continuing.');}
  }
  const wallet=String(client.account.wallet).toLowerCase();
  let confirmed=0,pending=0;
  for await(const page of client.listPositions({user:client.account.wallet,status:'REDEEMABLE'})) {
    for(const position of page.items) {
      if(!markets.has(position.slug) || !position.redeemable || position.status!=='REDEEMABLE' ||
          String(position.wallet).toLowerCase()!==wallet || !conditionId.test(position.conditionId) ||
          !(Number(position.currentSize)>0))continue;
      const id=position.conditionId.toLowerCase();
      if(attempted.has(id))continue;
      attempted.add(id);
      appendDurable(journal,{kind:'attempt',time:new Date().toISOString(),conditionId:id,slug:position.slug});
      try {
        const handle=await client.redeemPositions({conditionId:id});
        const result=await handle.wait();
        if(!txHash.test(String(result?.transactionHash)))throw new Error('Redemption receipt missing transaction hash.');
        appendDurable(journal,{kind:'confirmed',time:new Date().toISOString(),conditionId:id,slug:position.slug,transactionHash:result.transactionHash});
        confirmed++;
        onStatus('Winning position redeemed: '+position.slug+'; transaction '+result.transactionHash+'.');
      } catch {
        pending++;
        onStatus('Redemption for '+position.slug+' needs review; it will not be resubmitted automatically.');
      }
    }
  }
  return {confirmed,pending};
}

