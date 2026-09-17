import { createClient } from "jsr:@supabase/supabase-js@2";

const url=Deno.env.get("SUPABASE_URL")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db=createClient(url,key,{auth:{persistSession:false}});
const SYMBOL="XAUUSD_PROXY_GC",MODEL="logistic_direction_15m_proxy";

type P={id:number;action:"BUY"|"SELL"|"NO_TRADE";probability:number;model_version:string;features_ts:string;created_at:string};
type B={ts:string;close:number};
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
async function authorized(req:Request){const supplied=req.headers.get("x-refresh-token");const{data}=await db.from("runtime_settings").select("value").eq("key","public_refresh_token").limit(1).maybeSingle();return Boolean(data?.value&&supplied===data.value);}
async function setting(k:string,d:string){const{data}=await db.from("runtime_settings").select("value").eq("key",k).limit(1).maybeSingle();return data?.value??d;}
function lowerBound(bars:B[],targetMs:number){let lo=0,hi=bars.length;while(lo<hi){const m=(lo+hi)>>1;if(new Date(bars[m].ts).getTime()<targetMs)lo=m+1;else hi=m;}return lo;}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST"&&req.method!=="GET")return new Response("method not allowed",{status:405});
  if(!(await authorized(req)))return Response.json({ok:false,error:"unauthorized"},{status:401});

  const{data:run}=await db.from("closed_loop_runs").insert({run_type:"outcome_monitor",status:"running",symbol:SYMBOL}).select("id").single();
  const finish=async(status:string,patch:any={})=>{if(run?.id)await db.from("closed_loop_runs").update({status,finished_at:new Date().toISOString(),...patch}).eq("id",run.id);};
  try{
    const horizons=(await setting("evaluation_horizons","5,15,30")).split(",").map(x=>Number(x.trim())).filter(x=>Number.isFinite(x)&&x>0);
    const primary=15,now=new Date(),lookback=new Date(now.getTime()-48*3600000).toISOString();
    const{data:barRows,error:be}=await db.from("market_bars").select("ts,close").eq("symbol",SYMBOL).gte("ts",lookback).order("ts",{ascending:true}).limit(5000);if(be)throw be;
    const bars:B[]=(barRows??[]).map((x:any)=>({ts:x.ts,close:Number(x.close)}));
    if(bars.length<30){await finish("skipped",{metadata:{reason:"insufficient recent bars",bars:bars.length}});return Response.json({ok:true,skipped:"insufficient recent bars",bars:bars.length});}

    const{data:predRows,error:pe}=await db.from("model_predictions").select("id,action,probability,model_version,features_ts,created_at").eq("symbol",SYMBOL).gte("created_at",lookback).order("created_at",{ascending:true}).limit(1000);if(pe)throw pe;
    const preds:P[]=(predRows??[]).map((x:any)=>({...x,probability:Number(x.probability)}));
    const ids=preds.map(x=>x.id);
    const existing=new Set<string>();
    if(ids.length){const{data:eo}=await db.from("prediction_outcomes").select("prediction_id,horizon_minutes").in("prediction_id",ids).limit(5000);for(const x of eo??[])existing.add(`${x.prediction_id}:${x.horizon_minutes}`);}

    const inserts:any[]=[];let evaluated=0;
    for(const p of preds){
      const entryMs=new Date(p.features_ts).getTime(),entryIdx=lowerBound(bars,entryMs);if(entryIdx>=bars.length)continue;const entry=bars[entryIdx].close;
      for(const h of horizons){
        const k=`${p.id}:${h}`;if(existing.has(k))continue;
        const targetMs=entryMs+h*60000,targetIdx=lowerBound(bars,targetMs);if(targetIdx>=bars.length)continue;
        const target=bars[targetIdx],ret=target.close/entry-1,side=p.action==="BUY"?1:p.action==="SELL"?-1:0,signed=side?ret*side:null;
        const path=bars.slice(entryIdx,targetIdx+1).map(x=>(x.close/entry-1)*(side||1));
        inserts.push({prediction_id:p.id,horizon_minutes:h,symbol:SYMBOL,feature_ts:p.features_ts,entry_price:entry,target_ts:target.ts,target_price:target.close,realized_return:ret,signed_return:signed,label_up:ret>0,action_correct:side?Boolean((signed??0)>0):null,mfe_return:path.length?Math.max(...path):null,mae_return:path.length?Math.min(...path):null,provider:"yahoo_gc_futures",metadata:{proxy:true,directional_excursions:Boolean(side)}});evaluated++;
      }
    }
    for(let i=0;i<inserts.length;i+=300){const{error}=await db.from("prediction_outcomes").upsert(inserts.slice(i,i+300),{onConflict:"prediction_id,horizon_minutes"});if(error)throw error;}

    const windowHours=Math.max(1,Number(await setting("monitor_window_hours","24"))),windowStart=new Date(now.getTime()-windowHours*3600000);
    const bucketMs=5*60000,windowEnd=new Date(Math.floor(now.getTime()/bucketMs)*bucketMs),monitorStart=new Date(windowEnd.getTime()-windowHours*3600000);
    const{data:outcomes,error:oe}=await db.from("prediction_outcomes").select("prediction_id,label_up,signed_return,action_correct,evaluated_at").eq("symbol",SYMBOL).eq("horizon_minutes",primary).gte("evaluated_at",monitorStart.toISOString()).limit(5000);if(oe)throw oe;
    const outMap=new Map<number,any>((outcomes??[]).map((x:any)=>[Number(x.prediction_id),x]));
    const obs=preds.filter(p=>new Date(p.created_at)>=monitorStart&&outMap.has(p.id));
    const probs=obs.map(p=>p.probability),ys=obs.map(p=>outMap.get(p.id).label_up?1:0),trades=obs.filter(p=>p.action!=="NO_TRADE");
    const brier=obs.length?mean(probs.map((p,i)=>(p-ys[i])**2)):null,accuracy=obs.length?mean(probs.map((p,i)=>(p>=.5?1:0)===ys[i]?1:0)):null,coverage=obs.length?trades.length/obs.length:0;
    const tradeWins=trades.filter(p=>outMap.get(p.id).action_correct===true).length,tradeWin=trades.length?tradeWins/trades.length:0,meanSigned=trades.length?mean(trades.map(p=>Number(outMap.get(p.id).signed_return??0))):0,calBias=obs.length?mean(probs.map((p,i)=>p-ys[i])):null;
    const latestBar=bars.at(-1)!,dataAge=(now.getTime()-new Date(latestBar.ts).getTime())/60000;
    const{data:champ}=await db.from("model_runs").select("model_version,metrics,train_end,created_at").eq("model_name",MODEL).eq("status","champion").order("created_at",{ascending:false}).limit(1).maybeSingle();
    const baselineBrier=Number((champ?.metrics as any)?.brier??brier??0),drift=brier==null?null:Math.abs(brier-baselineBrier),minOutcomes=Math.max(20,Number(await setting("retrain_min_outcomes","80"))),brierWarn=Number(await setting("brier_warn_threshold","0.27")),driftWarn=Number(await setting("drift_warn_threshold","0.18"));
    let status:"healthy"|"warn"|"fail"|"insufficient_data"=obs.length<20?"insufficient_data":"healthy";
    if(obs.length>=20&&(dataAge>180||(brier??0)>brierWarn||meanSigned<0||(drift??0)>driftWarn))status="warn";
    if(obs.length>=minOutcomes&&((brier??0)>brierWarn+.05||(drift??0)>driftWarn+.10))status="fail";
    const modelVersion=champ?.model_version??(obs.at(-1)?.model_version??"untrained");
    const monitor={symbol:SYMBOL,model_version:modelVersion,horizon_minutes:primary,window_start:monitorStart.toISOString(),window_end:windowEnd.toISOString(),observations:obs.length,brier,accuracy,coverage,trade_win_rate:tradeWin,mean_signed_return:meanSigned,calibration_bias:calBias,drift_score:drift,data_age_minutes:dataAge,status,metrics:{baseline_brier:baselineBrier,trades:trades.length,proxy:true}};
    await db.from("model_monitoring_windows").upsert(monitor,{onConflict:"symbol,model_version,horizon_minutes,window_start,window_end"});

    const{data:lastBreaker}=await db.from("circuit_breaker_events").select("state").eq("breaker","model_health").order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(status==="fail"&&lastBreaker?.state!=="OPEN")await db.from("circuit_breaker_events").insert({breaker:"model_health",state:"OPEN",reason:"Model monitoring entered fail state; paper entries are paused until recovery",metrics:monitor});
    if(status==="healthy"&&lastBreaker?.state==="OPEN")await db.from("circuit_breaker_events").insert({breaker:"model_health",state:"CLOSED",reason:"Model monitoring recovered to healthy state",metrics:monitor});

    let requested=false,trigger:string|null=null;
    if(obs.length>=minOutcomes&&(status==="warn"||status==="fail")){trigger=status==="fail"?"drift":"performance";const day=now.toISOString().slice(0,10),idempotency=`${modelVersion}:${day}:${trigger}`;const{error}=await db.from("retraining_requests").upsert({idempotency_key:idempotency,trigger_type:trigger,symbol:SYMBOL,model_name:MODEL,model_version_before:modelVersion,status:"pending",reason:{monitoring:monitor}},{onConflict:"idempotency_key",ignoreDuplicates:true});if(error)throw error;requested=true;}
    if(champ?.train_end){const{count:newRows}=await db.from("gold_market_features").select("ts",{head:true,count:"exact"}).eq("symbol",SYMBOL).gt("ts",champ.train_end);if((newRows??0)>=1000){const key=`${modelVersion}:${Math.floor((newRows??0)/1000)}k:data_growth`;await db.from("retraining_requests").upsert({idempotency_key:key,trigger_type:"data_growth",symbol:SYMBOL,model_name:MODEL,model_version_before:modelVersion,status:"pending",reason:{new_feature_rows:newRows,train_end:champ.train_end}},{onConflict:"idempotency_key",ignoreDuplicates:true});requested=true;}}

    let retrained:any=null;
    const{data:pending}=await db.from("retraining_requests").select("id,requested_at").eq("symbol",SYMBOL).eq("status","pending").order("requested_at",{ascending:true}).limit(1).maybeSingle();
    const lastTrainAt=champ?.created_at?new Date(champ.created_at).getTime():0;
    if(pending&&now.getTime()-lastTrainAt>=6*3600000){
      const base=await setting("edge_function_base_url","");const token=await setting("public_refresh_token","");
      if(base&&token){await db.from("retraining_requests").update({status:"running",started_at:new Date().toISOString()}).eq("id",pending.id);try{const rr=await fetch(`${base.replace(/\/$/,"")}/train-baseline`,{method:"POST",headers:{"x-refresh-token":token,"Content-Type":"application/json"},body:JSON.stringify({request_id:pending.id})});const body=await rr.json();if(!rr.ok||!body.ok)throw new Error(body.error||`train ${rr.status}`);await db.from("retraining_requests").update({status:"succeeded",finished_at:new Date().toISOString(),model_version_after:body.modelVersion}).eq("id",pending.id);retrained=body;}catch(e){await db.from("retraining_requests").update({status:"failed",finished_at:new Date().toISOString(),error:String(e)}).eq("id",pending.id);}}
    }

    await finish("success",{model_version:modelVersion,output_watermark:latestBar.ts,counts:{predictions:preds.length,outcomes_written:evaluated,monitor_observations:obs.length,retraining_requested:requested?1:0},metrics:{status,brier,accuracy,coverage,trade_win_rate:tradeWin,mean_signed_return:meanSigned,drift_score:drift,data_age_minutes:dataAge,retrained:Boolean(retrained)}});
    return Response.json({ok:true,outcomesWritten:evaluated,monitoring:monitor,retrainingRequested:requested,retrained});
  }catch(e){const error=String(e);await finish("failed",{error});return Response.json({ok:false,error},{status:500});}
});
