"""Local read-only dashboard for simulated runs. No trading endpoints or keys."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import time
from .context import ResearchCache

HTML = r'''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Crypto paper lab</title>
<style>
*{box-sizing:border-box}body{font:15px system-ui;background:radial-gradient(circle at 15% 0%,#153041 0,#0a1220 46%,#060b12 100%);color:#e6f3f8;max-width:1400px;margin:25px auto;padding:0 20px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.eyebrow{color:#35e0c3;letter-spacing:.2em;text-transform:uppercase;font-size:11px;font-weight:700}h1{font-size:38px;line-height:1.1;margin:6px 0}h2{font-size:19px;margin-top:34px;color:#bcebf2}p{color:#92aeb9}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px}
.card,table,.panel{background:#0f1e2b;border:1px solid #244153;border-radius:14px;padding:16px;box-shadow:0 8px 30px #0004}.card{border-top:2px solid #19cba9}.big{font-size:27px;font-weight:720;margin-top:9px;font-variant-numeric:tabular-nums}.muted{color:#a1bcc5;font-size:13px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #25404d;font-variant-numeric:tabular-nums}th{color:#b2c7ce;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.green{color:#3be0b6}.red{color:#ff7188}.amber{color:#f7c66b}button,select{background:#136e79;border:1px solid #2ddbb8;border-radius:9px;color:white;padding:10px 14px;cursor:pointer}button:hover{background:#188e92}a{color:#6ce8d2}.bar{height:12px;border-radius:99px;background:#2a4350;overflow:hidden;margin:12px 0}.bar>span{display:block;height:100%;background:linear-gradient(90deg,#189cb8,#3defbb)}.pill{display:inline-block;border:1px solid #2ddbb8;border-radius:99px;padding:4px 9px;color:#69ead0;font-size:12px}.feeditem{padding:9px 0;border-bottom:1px solid #25404d}.feeditem:last-child{border:0}#notice{min-height:24px;color:#f7c66b}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin:14px 0;background:#101f2d;border:1px solid #294858;border-radius:12px}.scroll{overflow-x:auto}.scroll table{min-width:560px}.section-note{font-size:13px;margin-top:-12px}.chart{width:100%;height:105px;background:#081722;border-radius:8px;margin-top:10px}.chart polyline{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}.chart line{stroke:#31505e;stroke-width:1}@media(max-width:700px){body{padding:0 12px}header{display:block}h1{font-size:30px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.big{font-size:22px}}
</style><header><div><div class="eyebrow">V2 · Public data · paper and live telemetry</div><h1>Crypto trading lab</h1><p>BTC · ETH · XRP · SOL | $50 starting virtual cash in Paper mode</p></div><div><span class="pill">VIEW ONLY</span><p><button id="notify">Enable browser notifications</button></p></div></header><div class="toolbar"><label for="mode">View</label><select id="mode"><option value="paper">Paper simulation</option><option value="live">Live account</option></select><label for="variant">Compare paper strategies</label><select id="variant"><option value="five_dollar">$5 · research on</option><option value="one_dollar">$1 · research on</option><option value="five_dollar_baseline">$5 · baseline</option><option value="one_dollar_baseline">$1 · baseline</option></select><span class="muted">Changing views never starts trading. Paper fills are estimates.</span></div><p id="notice"></p><div id="cards" class="cards"></div>
<div id="paperView"><h2>Active simulated market</h2><p class="section-note">Actions are provisional until official resolution. No exchange order is placed by this dashboard.</p><div id="current" class="scroll"></div></div><div id="liveView" hidden><h2>Live account session</h2><p class="section-note">Real-funds trading is off by default. This view cannot start it. A separate PowerShell launcher requires the explicit -EnableLive switch and a wallet key entered in that terminal. Only confirmed exchange fills count as real trades.</p><div id="liveAccount" class="scroll"></div></div><h2>Live public-data charts</h2><div id="charts" class="columns"></div><h2>Live model signals</h2><div id="signals" class="columns"></div><div id="paperDetails"><h2>Closed paper markets</h2><div id="closed" class="scroll"></div><h2>Performance by asset</h2><div id="assets" class="scroll"></div><h2>Recent simulated actions</h2><div id="actions" class="scroll"></div></div><h2>External research <span class="muted">experimental, bounded model adjustment when fresh and directional</span></h2><div id="research" class="columns"></div>
<script>
const $=id=>document.getElementById(id);let seen=new Set(),closedSeen=new Set();let primed=false,lastStatus=null;let choices=['five_dollar','one_dollar','five_dollar_baseline','one_dollar_baseline'];let saved=localStorage.getItem('paperVariant');let variant=choices.includes(saved)?saved:'five_dollar';let mode=localStorage.getItem('dashboardMode')==='live'?'live':'paper';$('variant').value=variant;$('mode').value=mode;$('mode').onchange=()=>{mode=$('mode').value;localStorage.setItem('dashboardMode',mode);if(lastStatus)draw(lastStatus)};$('variant').onchange=()=>{variant=$('variant').value;localStorage.setItem('paperVariant',variant);if(lastStatus)draw(lastStatus)};
$('notify').onclick=async()=>{if('Notification' in window){let p=await Notification.requestPermission();$('notice').textContent='Browser notifications: '+p}else $('notice').textContent='This browser does not support notifications.'};
function esc(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function table(headers,rows){return '<table><thead><tr>'+headers.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
function money(v){let n=Number(v);return Number.isFinite(n)?'$'+n.toFixed(2):'—'}
function num(v,d=2){let n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
function link(x){return typeof x==='string'&&x.startsWith('https://')?x:'#'}
function chart(rows,key,color,title){let values=(rows||[]).map(x=>x[key]).filter(x=>x!==null&&x!==undefined).map(Number).filter(v=>Number.isFinite(v)&&(key!=='up_bid'||v>0));if(values.length<2)return '<div class="panel"><div class="eyebrow">'+esc(title)+'</div><p>Chart appears during the next public-data capture.</p></div>';let lo=Math.min(...values),hi=Math.max(...values),span=Math.max(hi-lo,Math.abs(hi)*.000001,0.000001);let points=values.map((v,i)=>(10+i*280/Math.max(1,values.length-1)).toFixed(1)+','+(95-(v-lo)*80/span).toFixed(1)).join(' ');return '<div class="panel"><div class="eyebrow">'+esc(title)+'</div><div class="big">'+esc(num(values.at(-1),key==='probability_up'?3:4))+'</div><svg class="chart" viewBox="0 0 300 105" role="img" aria-label="'+esc(title)+' recent trend"><line x1="10" y1="94" x2="290" y2="94"/><polyline points="'+points+'" stroke="'+color+'"/></svg><div class="muted">Recent public observations · min '+esc(num(lo,4))+' · max '+esc(num(hi,4))+'</div></div>'}
function feed(name,source,status,items){return '<div class="panel"><div class="eyebrow">'+esc(name)+'</div><p>'+esc(status||'loading')+'</p>'+(items||[]).map(x=>'<div class="feeditem"><a href="'+esc(link(x.url))+'" target="_blank" rel="noopener noreferrer">'+esc(x.title||'Untitled')+'</a><div class="muted">'+esc(typeof x.published_at==='number'?new Date(x.published_at*1000).toISOString():x.published_at||'')+(x.asset_match===false?' · general crypto':'')+'</div></div>').join('')+'<p class="muted">'+esc(source||'')+'</p></div>'}
function draw(s){lastStatus=s;let v=s.summary?.variants?.[variant]||{};let l=s.live||{};let active=Date.now()/1000-(l.updated_at||0)<10;let p=l.variants?.[variant]||{};let pf=p.portfolio||{};let account=s.live_account||{},accountActive=Date.now()/1000-(account.updated_at||0)<10,accountReport=account.variants?.live||{};
$('paperView').hidden=mode!=='paper';$('paperDetails').hidden=mode!=='paper';$('liveView').hidden=mode!=='live';$('variant').disabled=mode!=='paper';
let cards=mode==='paper'?[['Status',active?'Capturing':'Waiting / stopped'],['Virtual balance',money(v.virtual_balance??50)],['Settled paper markets',v.settled_markets??0],['Gross paper gains',money(v.gross_profit??0)],['Gross paper losses',money(v.gross_loss??0)],['Net realized paper P&L',money(v.realized_pnl??0)],['Current est. paper fills',active?pf.fills??0:'—']]:[['Live status',accountActive?'Session active':'Off / no active session'],['Market',accountActive?account.market:'—'],['Confirmed fills',accountActive?accountReport.portfolio?.fills??0:'—'],['Session marked P&L',accountActive?money(accountReport.portfolio?.conservative_mark_pnl??0):'—']];$('cards').innerHTML=cards.map(([k,x])=>'<div class="card"><div class="muted">'+esc(k)+'</div><div class="big">'+esc(x)+'</div></div>').join('');
$('current').innerHTML=active?table(['Market','Open simulated orders','Estimated fills','Marked P&L','Feed age'],[[l.market,p.open_orders||0,pf.fills||0,money(pf.conservative_mark_pnl||0),Math.max(0,Math.round(Date.now()/1000-l.updated_at))+'s']]):'<p>No active capture. Start the paper recorder in another PowerShell window.</p>';
let chartState=mode==='live'?(accountActive?account:null):(active?l:null);$('charts').innerHTML=chartState?chart(chartState.chart,'twap','#39dfc5','Asset TWAP')+chart(chartState.chart,'probability_up','#f6c368','Model Up probability')+chart(chartState.chart,'up_bid','#71a9ff','Polymarket Up bid')+chart(chartState.chart,'marked_pnl','#ff788f','Session marked P&L'):'<p>Charts appear during a fresh '+(mode==='live'?'live session':'paper capture')+'.</p>';
$('liveAccount').innerHTML=accountActive?table(['Market','Status','Confirmed fills','Session marked P&L'],[[account.market,accountReport.halted||'running',accountReport.portfolio?.fills??0,money(accountReport.portfolio?.conservative_mark_pnl??0)]]):'<p>Live trading is off or no live session is active.</p>';
let sig=l.signals||{},book=sig.books||{},q=sig.probability_up;
$('signals').innerHTML=chartState?(()=>{sig=chartState.signals||{};book=sig.books||{};q=sig.probability_up;return '<div class="panel"><div class="eyebrow">Chainlink 60-second TWAP · model input</div><div class="big">'+esc(num(sig.twap_price,4))+'</div><p>Opening reference '+esc(num(sig.opening_reference,4))+' · feed age '+esc(num(sig.twap_age_seconds,1))+'s</p><div class="muted">'+esc(sig.model_source||'')+'</div></div><div class="panel"><div class="eyebrow">Model probability · untrained</div><div class="big">Up '+esc(q==null?'—':num(q*100,1)+'%')+'</div><div class="bar"><span style="width:'+esc(q==null?0:Math.max(0,Math.min(100,q*100)))+'%"></span></div><p>Without research '+esc(sig.probability_up_without_research==null?'—':num(sig.probability_up_without_research*100,1)+'%')+' · research adjustment '+esc(num((sig.research?.probability_adjustment||0)*100,2))+' pp from '+esc(sig.research?.items||0)+' fresh items</p><p>Raw maker edge: Up '+esc(sig.raw_maker_edge?.Up==null?'—':num(sig.raw_maker_edge.Up*100,1)+' pp')+' · Down '+esc(sig.raw_maker_edge?.Down==null?'—':num(sig.raw_maker_edge.Down*100,1)+' pp')+'</p><div class="muted">Experimental headline polarity; before queue risk and fees</div></div><div class="panel"><div class="eyebrow">Polymarket order books · model input</div>'+table(['Side','Bid','Ask','Fresh'],[['Up',book.Up?.fresh?book.Up.bid:'—',book.Up?.fresh?book.Up.ask:'—',book.Up?.fresh?'yes':'no'],['Down',book.Down?.fresh?book.Down.bid:'—',book.Down?.fresh?book.Down.ask:'—',book.Down?.fresh?'yes':'no']])+'<div class="muted">'+esc(sig.public_trade_updates||0)+' trade updates · max book delay '+esc(num(sig.max_book_delay_seconds,2))+'s</div></div>'})():'<p>Signals appear during a fresh '+(mode==='live'?'live session':'paper capture')+'.</p>';
let r=s.research||{};$('research').innerHTML=feed('CoinDesk news',r.news_source,r.news_status,r.news)+feed('Reddit new posts',r.social_source,r.social_status,r.social);
$('closed').innerHTML=table(['Market','Winner','Estimated fills','Paired P&L','Realized P&L'],(v.recent_markets||[]).slice().reverse().map(x=>[x.market,x.winner,x.simulated_fills,money(x.paired_terminal_pnl),money(x.realized_pnl)]));
$('assets').innerHTML=table(['Asset','Settled','Est. fills','Wins','Losses','Gross gains','Gross losses','Net realized P&L'],Object.entries(v.by_asset||{}).map(([a,x])=>[a.toUpperCase(),x.settled_markets,x.simulated_fills,x.wins,x.losses,money(x.gross_profit??0),money(x.gross_loss??0),money(x.realized_pnl)]));
let actions=(p.actions||[]).filter(x=>['order_created','quote_active','fill','cancel_requested','post_only_rejected','settled'].includes(x.action)).slice(-12).reverse();
$('actions').innerHTML=table(['UTC','Action','Side','Shares','Price'],actions.map(x=>[new Date(x.ts*1000).toISOString().slice(11,19),x.action,x.side||'—',x.shares||'—',x.price||'—']));
if(active){for(let a of actions){let id=[l.market,a.ts,a.action,a.side,a.shares,a.price].join('|');if(primed&&!seen.has(id)){let msg='Paper '+a.action+' '+(a.side||'')+' '+(a.shares||'')+' @ '+(a.price||'');$('notice').textContent=msg;if('Notification' in window&&Notification.permission==='granted')new Notification(msg)}seen.add(id)}}
for(let x of v.recent_markets||[]){if(primed&&!closedSeen.has(x.market)){let msg='Paper market closed: '+x.market+' · P&L '+money(x.realized_pnl);$('notice').textContent=msg;if('Notification' in window&&Notification.permission==='granted')new Notification(msg)}closedSeen.add(x.market)}primed=true;
}
async function refresh(){try{let r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error(r.status);draw(await r.json())}catch(e){$('notice').textContent='Dashboard read error: '+e}setTimeout(refresh,2000)}refresh();
</script></html>'''


def status(root, research_cache=None):
    root = Path(root)
    summary_path = root / "paper-summary.json"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        summary = {"variants": {}}
    directories = [p for p in root.glob("paper-*") if p.is_dir()] if root.exists() else []
    directories.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    live = None
    for directory in directories[:3]:
        try:
            candidate = json.loads((directory / "live-state.json").read_text(encoding="utf-8"))
            if live is None or candidate["updated_at"] > live["updated_at"]:
                live = candidate
        except (OSError, ValueError, KeyError):
            continue
    live_account = None
    for directory in sorted(root.glob("automatic-*"), key=lambda p: p.stat().st_mtime, reverse=True)[:3]:
        try:
            candidate = json.loads((directory / "public" / "live-state.json").read_text(encoding="utf-8"))
            if live_account is None or candidate["updated_at"] > live_account["updated_at"]:
                live_account = candidate
        except (OSError, ValueError, KeyError):
            continue
    newest = live_account if (live_account and
                              (live is None or live_account["updated_at"] > live["updated_at"])) else live
    asset = newest["market"].split("-", 1)[0] if newest and "market" in newest else "btc"
    research = research_cache.get(asset) if research_cache is not None else None
    return {"summary": summary, "live": live, "live_account": live_account,
            "research": research, "server_time": time.time()}


def serve(root, host="127.0.0.1", port=8792):
    research_cache = ResearchCache()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Two-second dashboard polling should not flood the terminal.

        def do_GET(self):
            if self.path == "/api/status":
                body = json.dumps(status(root, research_cache)).encode()
                kind = "application/json"
            elif self.path == "/":
                body = HTML.encode()
                kind = "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Paper dashboard: http://{host}:{port}/", flush=True)
    server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local read-only paper dashboard")
    parser.add_argument("--runs", default="runs")
    parser.add_argument("--port", type=int, default=8792)
    args = parser.parse_args(argv)
    serve(args.runs, port=args.port)


if __name__ == "__main__":
    main()

