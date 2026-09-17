import { createClient } from "jsr:@supabase/supabase-js@2";

const url=Deno.env.get("SUPABASE_URL")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db=createClient(url,key,{auth:{persistSession:false}});
const SYMBOL="XAUUSD_PROXY_GC";

async function authorized(req:Request){const supplied=req.headers.get("x-refresh-token");const{data}=await db.from("runtime_settings").select("value").eq("key","public_refresh_token").limit(1).maybeSingle();return Boolean(data?.value&&supplied===data.value);}
async function setting(k:string,d:string){const{data}=await db.from("runtime_settings").select("value").eq("key",k).limit(1).maybeSingle();return data?.value??d;}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST"&&req.method!=="GET")return new Response("method not allowed",{status:405});
  if(!(await authorized(req)))return Response.json({ok:false,error:"unauthorized"},{status:401});

  const{data:run}=await db.from("closed_loop_runs").insert({run_type:"paper_execute",status:"running",symbol:SYMBOL}).select("id").single();
  const finish=async(status:string,patch:any={})=>{if(run?.id)await db.from("closed_loop_runs").update({status,finished_at:new Date().toISOString(),...patch}).eq("id",run.id);};
  try{
    const mode=await setting("execution_mode","paper"),horizon=Math.max(1,Number(await setting("paper_horizon_minutes","15"))),costRate=Math.max(0,Number(await setting("paper_cost_rate","0.00015")));
    const{data:riskRow}=await db.from("risk_limits").select("config").eq("name","global").limit(1).maybeSingle();
    const risk:any=riskRow?.config??{};
    const liveEnabled=Boolean(risk.live_enabled),maxTrades=Number(risk.max_trades_per_day??2),maxOpen=Number(risk.max_open_positions??1),minProb=Number(risk.min_probability??.62);
    const{data:breaker}=await db.from("circuit_breaker_events").select("state,reason,created_at").order("created_at",{ascending:false}).limit(1).maybeSingle();

    if(mode!=="paper"||liveEnabled){
      await db.from("circuit_breaker_events").insert({breaker:"execution_mode_guard",state:"OPEN",reason:"Paper worker refused to run because execution_mode was not paper or live_enabled was true",metrics:{mode,liveEnabled}});
      await finish("skipped",{metadata:{mode,liveEnabled}});
      return Response.json({ok:true,skipped:"execution_mode_guard"});
    }

    let closed=0,opened=0,vetoed=0;
    const now=new Date();
    const{data:openOrders,error:oe}=await db.from("paper_orders").select("id,prediction_id,side,filled_at,fill_price,quantity").eq("symbol",SYMBOL).eq("status","filled");
    if(oe)throw oe;
    for(const o of openOrders??[]){
      if(!o.filled_at||o.fill_price==null)continue;
      const target=new Date(new Date(o.filled_at).getTime()+horizon*60000).toISOString();
      if(now.getTime()<new Date(target).getTime())continue;
      const{data:exit}=await db.from("market_bars").select("ts,close").eq("symbol",SYMBOL).gte("ts",target).order("ts",{ascending:true}).limit(1).maybeSingle();
      if(!exit)continue;
      const{data:path}=await db.from("market_bars").select("close").eq("symbol",SYMBOL).gte("ts",o.filled_at).lte("ts",exit.ts).order("ts",{ascending:true}).limit(1000);
      const entry=Number(o.fill_price),qty=Number(o.quantity),side=o.side==="BUY"?1:-1,exitPrice=Number(exit.close);
      const returns=(path??[]).map((x:any)=>(Number(x.close)/entry-1)*side),mfe=returns.length?Math.max(...returns):null,mae=returns.length?Math.min(...returns):null;
      const gross=(exitPrice-entry)*side*qty,costs=Math.abs(entry*qty)*costRate,net=gross-costs;
      const{error:ue}=await db.from("execution_outcomes").upsert({paper_order_id:o.id,closed_at:exit.ts,close_price:exitPrice,gross_pnl:gross,costs,net_pnl:net,mfe,mae,outcome_label:net>0?"WIN":net<0?"LOSS":"FLAT",metadata:{mode:"paper",proxy:true,horizon_minutes:horizon,cost_rate:costRate}});
      if(ue)throw ue;
      await db.from("paper_orders").update({status:"closed"}).eq("id",o.id);closed++;
    }

    const dayStart=new Date(now);dayStart.setUTCHours(0,0,0,0);
    const{count:todayCount}=await db.from("paper_orders").select("id",{head:true,count:"exact"}).eq("symbol",SYMBOL).gte("requested_at",dayStart.toISOString());
    const{count:openCount}=await db.from("paper_orders").select("id",{head:true,count:"exact"}).eq("symbol",SYMBOL).eq("status","filled");
    const{data:preds}=await db.from("model_predictions").select("id,action,probability,model_version,risk_state,features_ts,created_at").eq("symbol",SYMBOL).in("action",["BUY","SELL"]).gte("created_at",new Date(now.getTime()-24*3600000).toISOString()).order("created_at",{ascending:false}).limit(50);

    let tradesToday=todayCount??0,currentlyOpen=openCount??0;
    for(const p of preds??[]){
      const{count:already}=await db.from("paper_risk_decisions").select("id",{head:true,count:"exact"}).eq("prediction_id",p.id);
      if((already??0)>0)continue;
      const ageMin=(now.getTime()-new Date(p.created_at).getTime())/60000,confidence=p.action==="BUY"?Number(p.probability):1-Number(p.probability);
      let allow=true,reason="risk gates passed";
      if(breaker?.state==="OPEN"){allow=false;reason=`circuit breaker open: ${breaker.reason}`;}
      else if(ageMin>10){allow=false;reason="signal stale (>10m)";}
      else if(confidence<minProb){allow=false;reason="model confidence below minimum";}
      else if(tradesToday>=maxTrades){allow=false;reason="max trades per day reached";}
      else if(currentlyOpen>=maxOpen){allow=false;reason="max open positions reached";}

      const snapshot={confidence,min_probability:minProb,signal_age_minutes:ageMin,trades_today:tradesToday,max_trades_per_day:maxTrades,open_positions:currentlyOpen,max_open_positions:maxOpen,breaker_state:breaker?.state??"NONE",execution_mode:mode,live_enabled:liveEnabled};
      await db.from("paper_risk_decisions").insert({prediction_id:p.id,decision:allow?"ALLOW":"VETO",reason,risk_snapshot:snapshot});
      if(!allow){vetoed++;continue;}

      const{data:feature}=await db.from("gold_market_features").select("close").eq("symbol",SYMBOL).eq("ts",p.features_ts).order("feature_set_version",{ascending:false}).limit(1).maybeSingle();
      if(!feature){vetoed++;await db.from("paper_risk_decisions").insert({prediction_id:p.id,decision:"VETO",reason:"feature entry price unavailable",risk_snapshot:snapshot});continue;}
      const price=Number(feature.close);
      const{error}=await db.from("paper_orders").insert({prediction_id:p.id,symbol:SYMBOL,side:p.action,requested_at:p.created_at,requested_price:price,filled_at:p.created_at,fill_price:price,quantity:1,status:"filled",metadata:{mode:"paper",proxy:true,horizon_minutes:horizon,cost_rate:costRate,model_version:p.model_version}});
      if(error){if(!String(error.message).includes("duplicate"))throw error;}else{opened++;tradesToday++;currentlyOpen++;break;}
    }

    await finish("success",{counts:{opened,closed,vetoed},metrics:{trades_today:tradesToday,open_positions:currentlyOpen,cost_rate:costRate,horizon_minutes:horizon}});
    return Response.json({ok:true,opened,closed,vetoed,tradesToday,openPositions:currentlyOpen});
  }catch(e){const error=String(e);await finish("failed",{error});return Response.json({ok:false,error},{status:500});}
});
