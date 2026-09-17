import { createClient } from "jsr:@supabase/supabase-js@2";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const SYMBOL="XAUUSD_PROXY_GC";
async function setting(key:string,fallback:string){const{data}=await db.from("runtime_settings").select("value").eq("key",key).limit(1).maybeSingle();return data?.value??fallback}
async function auth(req:Request){const supplied=req.headers.get("x-refresh-token"),expected=await setting("public_refresh_token","");return Boolean(expected&&supplied===expected)}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST"&&req.method!=="GET")return new Response("method not allowed",{status:405});
  if(!(await auth(req)))return Response.json({ok:false,error:"unauthorized"},{status:401});
  const{data:loop}=await db.from("closed_loop_runs").insert({run_type:"paper_execute",status:"running",symbol:SYMBOL}).select("id").single();
  try{
    const executionMode=await setting("execution_mode","paper"),horizon=Number(await setting("paper_horizon_minutes","15")),costRate=Number(await setting("paper_cost_rate","0.00015"));
    const{data:riskRow}=await db.from("risk_limits").select("config").eq("name","global").limit(1).maybeSingle(),risk:any=riskRow?.config??{},minP=Number(risk.min_probability??.62),maxDaily=Number(risk.max_trades_per_day??2),maxOpen=Number(risk.max_open_positions??1),cooldown=Number(risk.cooldown_minutes??15),liveEnabled=Boolean(risk.live_enabled??false),paperOnly=Boolean(risk.paper_only??true);
    const{data:breaker}=await db.from("circuit_breaker_events").select("state,reason,created_at").order("created_at",{ascending:false}).limit(1).maybeSingle();
    let closed=0,opened=0,vetoed=0,skipped=0;

    const{data:openOrders}=await db.from("paper_orders").select("id,prediction_id,side,filled_at,fill_price,quantity").eq("symbol",SYMBOL).eq("status","filled");
    for(const o of openOrders??[]){
      const{data:p}=await db.from("model_predictions").select("horizon_minutes").eq("id",o.prediction_id).limit(1).maybeSingle();
      const h=Number(p?.horizon_minutes??horizon);if(!o.filled_at||Date.now()-new Date(o.filled_at).getTime()<h*60000)continue;
      const target=new Date(new Date(o.filled_at).getTime()+h*60000),latest=new Date(target.getTime()+10*60000);
      const{data:bar}=await db.from("gold_market_features").select("ts,close").eq("symbol",SYMBOL).gte("ts",target.toISOString()).lte("ts",latest.toISOString()).order("ts",{ascending:true}).limit(1).maybeSingle();
      if(!bar)continue;
      const entry=Number(o.fill_price),qty=Number(o.quantity),exit=Number(bar.close),gross=(exit-entry)*(o.side==="BUY"?1:-1)*qty,costs=Math.abs(entry*qty)*costRate,net=gross-costs;
      const{error}=await db.from("execution_outcomes").upsert({paper_order_id:o.id,closed_at:bar.ts,close_price:exit,gross_pnl:gross,costs,net_pnl:net,outcome_label:net>0?"WIN":net<0?"LOSS":"FLAT",metadata:{proxy:true,cost_rate:costRate,costs_provisional:true,horizon_minutes:h}});if(error)throw error;
      await db.from("paper_orders").update({status:"closed"}).eq("id",o.id);closed++;
    }

    const since=new Date(Date.now()-24*3600000).toISOString();
    const{data:candidates,error:ce}=await db.from("model_predictions").select("id,action,probability,model_version,risk_state,features_ts,created_at,horizon_minutes").eq("symbol",SYMBOL).neq("action","NO_TRADE").gte("created_at",since).order("created_at",{ascending:true}).limit(50);if(ce)throw ce;
    for(const p of candidates??[]){
      const{count:orderExists}=await db.from("paper_orders").select("id",{head:true,count:"exact"}).eq("prediction_id",p.id);if((orderExists??0)>0){skipped++;continue}
      const{count:decisionExists}=await db.from("paper_risk_decisions").select("id",{head:true,count:"exact"}).eq("prediction_id",p.id);if((decisionExists??0)>0){skipped++;continue}
      const snapshot:any={execution_mode:executionMode,live_enabled:liveEnabled,paper_only:paperOnly,min_probability:minP,max_trades_per_day:maxDaily,max_open_positions:maxOpen,cooldown_minutes:cooldown,breaker:breaker?.state??null,probability:p.probability,action:p.action};
      let decision:"ALLOW"|"VETO"|"SKIP"="ALLOW",reason="risk gates passed";
      if(executionMode!=="paper"){decision="VETO";reason="execution_mode_not_paper"}
      else if(liveEnabled||!paperOnly){decision="VETO";reason="paper_only_safety_gate_not_active"}
      else if(breaker?.state==="OPEN"){decision="VETO";reason=`circuit_breaker_open:${breaker.reason}`}
      else if(Date.now()-new Date(p.created_at).getTime()>45*60000){decision="SKIP";reason="stale_prediction"}
      else if(p.action==="BUY"&&Number(p.probability)<minP){decision="VETO";reason="buy_probability_below_threshold"}
      else if(p.action==="SELL"&&Number(p.probability)>1-minP){decision="VETO";reason="sell_probability_above_threshold"}
      if(decision==="ALLOW"){
        const day=new Date();day.setUTCHours(0,0,0,0);
        const{count:daily}=await db.from("paper_orders").select("id",{head:true,count:"exact"}).eq("symbol",SYMBOL).gte("requested_at",day.toISOString()),{count:open}=await db.from("paper_orders").select("id",{head:true,count:"exact"}).eq("symbol",SYMBOL).eq("status","filled"),{data:lastOrder}=await db.from("paper_orders").select("requested_at").eq("symbol",SYMBOL).order("requested_at",{ascending:false}).limit(1).maybeSingle();
        if((daily??0)>=maxDaily){decision="VETO";reason="max_trades_per_day"}
        else if((open??0)>=maxOpen){decision="VETO";reason="max_open_positions"}
        else if(lastOrder&&Date.now()-new Date(lastOrder.requested_at).getTime()<cooldown*60000){decision="VETO";reason="cooldown"}
      }
      await db.from("paper_risk_decisions").insert({prediction_id:p.id,decision,reason,risk_snapshot:snapshot});
      if(decision!=="ALLOW"){if(decision==="VETO")vetoed++;else skipped++;continue}
      const{data:feature}=await db.from("gold_market_features").select("close,ts").eq("symbol",SYMBOL).eq("ts",p.features_ts).limit(1).maybeSingle();if(!feature){skipped++;continue}
      const{error:oe}=await db.from("paper_orders").insert({prediction_id:p.id,symbol:SYMBOL,side:p.action,requested_at:p.features_ts,requested_price:feature.close,filled_at:p.features_ts,fill_price:feature.close,quantity:1,status:"filled",metadata:{mode:"paper",proxy:true,horizon_minutes:Number(p.horizon_minutes??horizon),model_version:p.model_version,live_enabled:false}});if(oe&&!(String(oe.message).includes("duplicate")||String(oe.code)==="23505"))throw oe;if(!oe)opened++;
    }
    if(loop?.id)await db.from("closed_loop_runs").update({status:"success",finished_at:new Date().toISOString(),counts:{opened,closed,vetoed,skipped},metadata:{execution_mode:executionMode,live_enabled:false,cost_rate:costRate}}).eq("id",loop.id);
    return Response.json({ok:true,opened,closed,vetoed,skipped,executionMode,liveEnabled:false});
  }catch(e){if(loop?.id)await db.from("closed_loop_runs").update({status:"failed",finished_at:new Date().toISOString(),error:String(e)}).eq("id",loop.id);return Response.json({ok:false,error:String(e)},{status:500})}
});
