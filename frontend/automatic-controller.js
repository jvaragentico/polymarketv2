// Transport-independent lifecycle controller for a user-launched executor.
// No SDK connection, key, process startup or live transaction runs on import.
export class AutomaticController {
  constructor({engine, exchange, now = () => Date.now()/1000}) {
    this.engine=engine; this.exchange=exchange; this.now=now;
    this.halted=null; this.busy=false; this.submitted=new Map();this.canceled=new Set();
  }
  async cancelKnown() {
    const failures=[];
    for(const [localId,exchangeId] of this.submitted) {
      if(this.canceled.has(exchangeId))continue;
      try {
        const result=await this.exchange.cancel(exchangeId);
        if(!result.canceled?.includes(exchangeId)) throw new Error('Cancellation not acknowledged.');
        await this.engine.canceled(localId);
        this.canceled.add(exchangeId);
      } catch {failures.push(exchangeId);}
    }
    return failures;
  }
  async stop(reason='user_stop') {
    this.halted=reason;
    // Cancel only IDs created by this session; never unrelated account orders.
    return this.cancelKnown();
  }
  async step() {
    if(this.busy || this.halted) return;
    this.busy=true;
    try {
      let pendingSettlement=false;
      // Reconcile every accepted order, including one already canceled locally.
      // Until CONFIRMED, reservations remain held and no imaginary hedge exists.
      for(const [localId,exchangeId] of this.submitted) {
        this.phase='fill_history';
        const updates=await this.exchange.fills(exchangeId);
        for(const fill of updates) {
          if(fill.orderId!==exchangeId) throw new Error('Execution identity mismatch.');
          if(fill.status==='FAILED') throw new Error('Account fill failed settlement.');
          if(fill.status!=='CONFIRMED') {pendingSettlement=true;continue;}
          await this.engine.fill(localId,fill);
        }
      }
      this.phase='worker_state';
      const state=await this.engine.state();
      if(state.halted) {await this.stop(state.halted);return;}
      const checkedAt=this.now();
      if(!Number.isFinite(state.receivedAt) || !Number.isFinite(state.maxAge) || state.maxAge<=0 || checkedAt-state.receivedAt>state.maxAge || checkedAt<state.receivedAt-0.5) {
        this.staleDiagnostic={checkedAt,receivedAt:state.receivedAt,maxAge:state.maxAge};
        await this.stop('stale_execution_state');return;
      }
      for(const intent of state.intents) {
        if(this.halted) break;
        const accepted=this.submitted.get(intent.localId);
        if(intent.cancel) {
          if(!accepted) {await this.engine.rejected(intent.localId);continue;}
          if(this.canceled.has(accepted))continue;
          this.phase='cancel';
          const result=await this.exchange.cancel(accepted);
          if(!result.canceled?.includes(accepted)) throw new Error('Cancellation not acknowledged.');
          await this.engine.canceled(intent.localId);
          this.canceled.add(accepted);
          continue;
        }
        if(accepted) continue;
        if(pendingSettlement) continue;
        this.phase='preflight';
        try {await this.exchange.preflight(intent,state);}
        catch(error) {
          if(error?.code==='LOCAL_PREFLIGHT_REJECTED') {await this.engine.rejected(intent.localId);continue;}
          throw error;
        }
        // Signals can change while funding, eligibility or metadata is fetched.
        this.phase='pre_submit_state';
        const latest=await this.engine.state();
        const current=latest.intents.find(i=>i.localId===intent.localId);
        if(latest.halted || !current || current.cancel || this.halted) continue;
        const latestCheckedAt=this.now();
        if(latestCheckedAt-latest.receivedAt>latest.maxAge || latestCheckedAt<latest.receivedAt-0.5) {
          this.staleDiagnostic={checkedAt:latestCheckedAt,receivedAt:latest.receivedAt,maxAge:latest.maxAge};
          await this.stop('stale_execution_state');break;
        }
        if(current.price!==intent.price || current.shares!==intent.shares || current.side!==intent.side) throw new Error('Intent mutated during preflight.');
        // Transport failure is ambiguous: NEVER retry a possibly accepted order.
        let response;
        this.phase='submit';
        try {response=await this.exchange.place(current,latest);}
        catch(error) {
          if(error?.code==='LOCAL_GUARD_REJECTED' || error?.code==='DEFINITE_ORDER_REJECTED') {
            await this.engine.rejected(current.localId);continue;
          }
          this.halted='ambiguous_submission_requires_reconciliation';await this.cancelKnown();return;
        }
        if(!response.ok) {await this.engine.rejected(current.localId);continue;}
        if(!response.orderId || [...this.submitted.values()].includes(response.orderId)) throw new Error('Invalid exchange acknowledgement.');
        this.submitted.set(current.localId,response.orderId);
        this.phase='acknowledge';
        await this.engine.acknowledge(current.localId,response.orderId);
        if(this.halted) {await this.cancelKnown();return;}
      }
    } catch {
      this.failureStage=this.phase||'unknown';
      await this.stop('execution_reconciliation_failed');
    } finally {this.busy=false;}
  }
}

