import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {AutomaticController} from '../frontend/automatic-controller.js';
import {createSdkExchange} from './automatic-sdk.js';
import {units} from '../frontend/wallet-policy.js';

export async function runAutomatic({client,options,eligible,signGuard}) {
  if(options.confirmed!==true)throw new Error('Automatic execution requires explicit local confirmation.');
  const capital=String(options.maxSpend);
  if(!/^(btc|eth|xrp|sol)-updown-5m-\d+$/.test(options.slug))throw new Error('Use a supported crypto Up/Down 5m market.');
  if(!Number.isFinite(Number(capital)) || Number(capital)<=0 || !Number.isFinite(Number(options.maxLoss)) ||
      Number(options.maxLoss)<=0 || Number(options.maxLoss)>Number(capital) || !Number.isFinite(Number(options.seconds)) ||
      Number(options.seconds)<5 || Number(options.seconds)>900 || !Number.isFinite(Number(options.orderDollars)) ||
      Number(options.orderDollars)<=0 || Number(options.orderDollars)>Math.min(5,Number(capital)))throw new Error('Invalid automatic execution caps.');
  await eligible();
  const python=join(process.cwd(),'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  if(!existsSync(python))throw new Error('Install the project virtual environment first.');
  const child=spawn(python,['-m','polymarket_bot.automatic_worker'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  const ready=new Promise((resolve,reject)=>{
    const lines=createInterface({input:child.stdout});
    const timer=setTimeout(()=>reject(new Error('Worker startup timed out.')),25000);
    lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line));}catch{reject(new Error('Invalid worker response.'));}});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Worker process failed.'));});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Worker exited.'));});
  });
  // The child receives public settings only, never the private key or SDK credentials.
  child.stdin.end(JSON.stringify({...options,capital})+'\n');
  child.stderr.resume(); // Never echo transport diagnostics or sensitive payloads.
  let controller,engine,stopping=false,profitTriggered=false,targetTriggered=false,info,finalReason;
  const stoppingSignal=()=>{stopping=true;};
  process.on('SIGINT',stoppingSignal);process.on('SIGTERM',stoppingSignal);
  try {
    info=await ready;
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) || typeof info.token!=='string')throw new Error('Invalid worker endpoint.');
    async function request(path,body) {
      const response=await fetch(info.url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+info.token,
        ...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Worker rejected an execution update.');
      return response.json();
    }
    engine={state:()=>request('/state'),acknowledge:(local_id,exchange_id)=>request('/update',{kind:'execution_ack',local_id,exchange_id}),
      rejected:local_id=>request('/update',{kind:'execution_reject',local_id}),canceled:local_id=>request('/update',{kind:'execution_cancel',local_id}),
      fill:(local_id,f)=>request('/update',{kind:'execution_fill',local_id,fill_id:f.id,shares:f.shares,price:f.price,fee:f.fee,status:f.status})};
    engine.stop=()=>request('/update',{kind:'execution_stop'});
    const exchange=createSdkExchange({client,engine,eligible,signGuard});
    let account;
    try {account=await exchange.accountValue();}
    catch {throw new Error('Account valuation unavailable during automatic startup. Check collateral and portfolio in Polymarket before retrying.');}
    const dollars=value=>(value/1000000n).toString()+'.'+(value%1000000n).toString().padStart(6,'0');
    console.log('Account collateral $'+dollars(account.cashUnits)+', positions $'+dollars(account.positionUnits)+
      ', total marked value $'+dollars(account.totalUnits)+'.');
    await exchange.startup(await engine.state());
    if(account.totalUnits>=units('100')){
      targetTriggered=true;
      console.log('$100 marked account value reached. Continuing within the per-market limits.');
    }
    controller=new AutomaticController({engine,exchange});
    signGuard.check=async()=>{
      if(signGuard.exit) {
        await eligible();
        const state=await engine.state();
        if(!/^(btc|eth|xrp|sol)-updown-5m-\d+$/.test(state.market.slug))throw new Error('Exit market changed.');
        return;
      }
      if(stopping || controller.halted)throw new Error('Automatic session stopped.');
      const state=await engine.state();
      if(state.halted || Date.now()/1000-state.receivedAt>state.maxAge || Date.now()/1000>=state.market.end-60)throw new Error('Crypto entry window closed with less than 60 seconds remaining.');
      const intent=signGuard.intent;
      if(intent) {
        if(units(intent.price)>units(state.config.max_entry_price ?? '1'))throw new Error('Entry price exceeds the live safety ceiling.');
      }
      const current=intent && state.intents.find(i=>i.localId===intent.localId);
      if(intent && (!current || current.cancel || current.price!==intent.price || current.shares!==intent.shares))throw new Error('Order signal changed before signing.');
    };
    console.log('Automatic session started. Maker-only, one market, maximum spend '+capital+', maximum loss '+options.maxLoss+'.');
    console.log('Recording: '+info.run+' | Ctrl+C stops new orders and requests cancellation of session orders.');
    const end=Date.now()+Number(options.seconds)*1000;
    let nextProfitCheck=0;
    while(!stopping && !controller.halted && Date.now()<end && child.exitCode===null) {
      let account;
      try {account=await exchange.accountValue();}
      catch {throw new Error('Account valuation unavailable during automatic execution. Check open orders and positions before retrying.');}
      if(!targetTriggered && account.totalUnits>=units('100')){
        targetTriggered=true;
        console.log('$100 marked account value reached. Continuing within the per-market limits.');
      }
      await controller.step();
      if(!controller.halted && Date.now()>=nextProfitCheck) {
        nextProfitCheck=Date.now()+3000;
        const state=await engine.state();
        if(state.portfolio?.fills>0 && Date.now()/1000<state.market.end-8 &&
            await exchange.profitOpportunity(state)) {
          profitTriggered=true;
          await controller.stop('take_profit');
          break;
        }
      }
      if(!controller.halted)await new Promise(resolve=>setTimeout(resolve,500));
    }
    finalReason=controller.halted || (stopping?'user_stop':'session_finished');
    if(finalReason==='execution_reconciliation_failed')
      console.log('Reconciliation stopped during: '+(controller.failureStage||'unknown')+'. No new orders will be submitted.');
    if(finalReason==='stale_execution_state' && controller.staleDiagnostic) {
      const timing=controller.staleDiagnostic;
      console.log('State age at stop: '+(timing.checkedAt-timing.receivedAt).toFixed(3)+
        ' seconds; maximum allowed: '+timing.maxAge+' seconds.');
    }
    if(finalReason==='ambiguous_submission_requires_reconciliation')console.log('A submission may have been accepted. Inspect open orders in Polymarket before restarting.');
  } finally {
    if(engine) {try{await engine.stop();}catch{} }
    if(controller) {
      const failures=await controller.stop(controller.halted||'session_finished');
      if(failures.length)console.log('Cancellation not confirmed for: '+failures.join(', ')+'. Check Polymarket open orders.');
      // A match can race a cancellation. Retain the worker while reconciling
      // confirmed fills, including fills of orders already canceled locally.
      const deadline=Date.now()+15000;
      let unresolved=false;
      do {
        unresolved=false;
        for(const [localId,orderId] of controller.submitted) {
          try {
            const updates=await controller.exchange.fills(orderId);
            for(const fill of updates) {
              if(fill.orderId!==orderId || fill.status==='FAILED')throw new Error('Invalid final execution.');
              if(fill.status!=='CONFIRMED'){unresolved=true;continue;}
              await engine.fill(localId,fill);
            }
          } catch {unresolved=true;}
        }
        if(unresolved && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
      } while(unresolved && Date.now()<deadline);
      if(unresolved)console.log('Final account fills are not fully reconciled. Check Polymarket trades before restarting; this journal may be incomplete.');
      if(unresolved || failures.length)finalReason='incomplete_final_reconciliation';
      if(profitTriggered && (unresolved || failures.length))
        console.log('Take-profit sale skipped because order cancellation or fills were not confirmed. Inspect account positions and open orders.');
      if(profitTriggered && !unresolved && failures.length===0) {
        try {
          if(!/^runs[\\/]automatic-[a-f0-9]{12}$/.test(info.run))throw new Error('Invalid journal directory.');
          const state=await engine.state();
          const output=join(process.cwd(),info.run,'exit-attempts.jsonl');
          const exits=await controller.exchange.liquidateOwnPositions(state,async record=>{
            appendFileSync(output,JSON.stringify({time:new Date().toISOString(),reason:'take_profit',...record})+'\n');
          },true);
          console.log(exits.length===1 && exits[0].confirmed ?
            'Take-profit sale settled for session-owned shares.' :
            'Profit quote was no longer executable; shares remain in the account. Inspect positions.');
        } catch {
          console.log('Take-profit sale could not be confirmed. Inspect account positions and open orders immediately.');
        }
      }
      try {
        const finalState=await engine.state();
        const fills=Number(finalState.portfolio?.fills);
        const posted=controller.submitted.size;
        console.log('Session result: '+posted+' exchange-accepted order'+(posted===1?'':'s')+'; '+
          (unresolved?'confirmed fill count still needs account reconciliation':
            Number.isFinite(fills)?fills+' confirmed fill'+(fills===1?'':'s'):'confirmed fill count unavailable')+'.');
      } catch {console.log('Session result unavailable. Inspect the journal and Polymarket account.');}
    }
    if(finalReason)console.log('Automatic session stopped: '+finalReason);
    signGuard.check=null;
    process.removeListener('SIGINT',stoppingSignal);process.removeListener('SIGTERM',stoppingSignal);
    child.kill();
  }
}

