import { createClient } from "jsr:@supabase/supabase-js@2";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const SYMBOL="XAUUSD_PROXY_GC";
async function setting(key:string,fallback:string){const{data}=await db.from("runtime_settings").select("value").eq("key",key).limit(1).maybeSingle();return data?.value??fallback}
async function auth(req:Request){const supplied=req.headers.get("x-refresh-token"),expected=await setting("public_refresh_token","");return Boolean(expected&&supplied===expected)}
const avg=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST"&&req.method!=="GET")return new Response("method not allowed",{status:405});
  if(!(await auth(req)))return Response.json({ok:false,error:"unauthorized"},{status:401});
  const{data:loop}=await db.from("closed_loop_runs").insert({run_type:"outcome_monitor",status:"running",symbol:SYMBOL}).select("id").single();
  try{
    const horizons=(await setting("evaluation_horizons","5,15,30")).split(",").map(x=>Number(x.trim())).filter(x=>x>0),windowHours=Number(await setting("monitor_window_hours","24")),brierWarn=Number(await setting("brier_warn_threshold","0.27")),driftWarn=Number(await setting("drift_warn_threshold","0.18")),minOutcomes=Number(await setting("retrain_min_outcomes","80"));
    const since=new Date(Date.now()-72*3600000).toISOString(),{data:preds,error:pe}=await db.from("model_predictions").select("id,symbol,prediction_ts,features_ts,action,probability,model_version").eq("symbol",SYMBOL).gte("prediction_ts",since).order("prediction_ts",{ascending:true}).limit(600);if(pe)throw pe;
    let inserted=0;
    for(const p of preds??[]){
      const{data:entry}=await db.from("gold_market_features").select("close,ts").eq("symbol",SYMBOL).eq("ts",p.features_ts).limit(1).maybeSingle();if(!entry)continue;
      for(const h of horizons){
        if(Date.now()-new Date(p.prediction_ts).getTime()<h*60000)continue;
        const{count}=await db.from("prediction_outcomes").select("prediction_id",{head:true,count:"exact"}).eq("prediction_id",p.id).eq("horizon_minutes",h);if((count??0)>0)continue;
        const target=new Date(new Date(p.prediction_ts).getTime()+h*60000),maxTarget=new Date(target.getTime()+10*60000),{data:exit}=await db.from("gold_market_features").select("close,ts").eq("symbol",SYMBOL).gte("ts",target.toISOString()).lte("ts",maxTarget.toISOString()).order("ts",{ascending:true}).limit(1).maybeSingle();if(!exit)continue;
        const{data:path}=await db.from("gold_market_features").select("close").eq("symbol",SYMBOL).gte("ts",p.features_ts).lte("ts",exit.ts).order("ts",{ascending:true});
        const ep=Number(entry.close),xp=Number(exit.close),ret=Math.log(xp/ep),returns=(path??[]).map((x:any)=>Math.log(Number(x.close)/ep)),mfe=returns.length?Math.max(...returns):ret,mae=returns.length?Math.min(...returns):ret,signed=p.action==="BUY"?ret:p.action==="SELL"?-ret:null,correct=p.action==="BUY"?ret>0:p.action==="SELL"?ret<0:null;
        const{error}=await db.from("prediction_outcomes").insert({prediction_id:p.id,horizon_minutes:h,symbol:SYMBOL,feature_ts:p.features_ts,entry_price:ep,target_ts:exit.ts,target_price:xp,realized_return:ret,signed_return:signed,label_up:ret>0.00010,action_correct:correct,mfe_return:mfe,mae_return:mae,provider:"gold_market_features",metadata:{model_version:p.model_version,probability:p.probability,action:p.action,proxy:true}});if(error&&String(error.code)!=="23505")throw error;if(!error)inserted++;
      }
    }

    const{data:champ}=await db.from("model_runs").select("model_version").eq("model_name","logistic_direction_15m_proxy").eq("status","champion").order("created_at",{ascending:false}).limit(1).maybeSingle(),modelVersion=champ?.model_version??"rules_bootstrap_v1",windowEnd=new Date(Math.floor(Date.now()/300000)*300000),windowStart=new Date(windowEnd.getTime()-windowHours*3600000);
    const{data:outs}=await db.from("prediction_outcomes").select("prediction_id,label_up,action_correct,signed_return,evaluated_at").eq("symbol",SYMBOL).eq("horizon_minutes",15).gte("evaluated_at",windowStart.toISOString()).lte("evaluated_at",windowEnd.toISOString()).limit(2000);
    const ids=(outs??[]).map((x:any)=>x.prediction_id),predMap=new Map<number,any>();
    if(ids.length){const{data:ps}=await db.from("model_predictions").select("id,probability,action,model_version").in("id",ids);for(const x of ps??[])if(x.model_version===modelVersion)predMap.set(x.id,x)}
    const matched=(outs??[]).filter((o:any)=>predMap.has(o.prediction_id)),probs=matched.map((o:any)=>Number(predMap.get(o.prediction_id).probability)),labels=matched.map((o:any)=>o.label_up?1:0),acted=matched.filter((o:any)=>predMap.get(o.prediction_id).action!=="NO_TRADE"),brier=matched.length?avg(matched.map((o:any,i:number)=>(probs[i]-labels[i])**2)):null,accuracy=matched.length?avg(matched.map((o:any,i:number)=>((probs[i]>=.5?1:0)===labels[i]?1:0))):null,coverage=matched.length?acted.length/matched.length:0,tradeWin=acted.length?avg(acted.map((o:any)=>o.action_correct?1:0)):0,meanSigned=acted.length?avg(acted.map((o:any)=>Number(o.signed_return??0))):0,calibrationBias=matched.length?avg(probs)-avg(labels):null,drift=calibrationBias==null?null:Math.abs(calibrationBias);
    const{data:lastFeature}=await db.from("gold_market_features").select("ts").eq("symbol",SYMBOL).order("ts",{ascending:false}).limit(1).maybeSingle(),dataAge=lastFeature?(Date.now()-new Date(lastFeature.ts).getTime())/60000:null;
    let status:"healthy"|"warn"|"fail"|"insufficient_data"=matched.length<30?"insufficient_data":"healthy";
    if(status!=="insufficient_data"&&((dataAge??999)>60||(brier??0)>brierWarn+.05||(drift??0)>driftWarn+.10))status="fail";else if(status!=="insufficient_data"&&((dataAge??999)>30||(brier??0)>brierWarn||(drift??0)>driftWarn))status="warn";
    const metrics={proxy:true,calibration_drift_proxy:true,brier_warn_threshold:brierWarn,drift_warn_threshold:driftWarn};
    await db.from("model_monitoring_windows").upsert({symbol:SYMBOL,model_version:modelVersion,horizon_minutes:15,window_start:windowStart.toISOString(),window_end:windowEnd.toISOString(),observations:matched.length,brier,accuracy,coverage,trade_win_rate:tradeWin,mean_signed_return:meanSigned,calibration_bias:calibrationBias,drift_score:drift,data_age_minutes:dataAge,status,metrics},{onConflict:"symbol,model_version,horizon_minutes,window_start,window_end"});

    const{data:lastBreaker}=await db.from("circuit_breaker_events").select("state").eq("breaker","model_health").order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(status==="fail"&&lastBreaker?.state!=="OPEN")await db.from("circuit_breaker_events").insert({breaker:"model_health",state:"OPEN",reason:"monitoring_fail",metrics:{brier,drift,dataAge,observations:matched.length}});
    if(status==="healthy"&&lastBreaker?.state==="OPEN")await db.from("circuit_breaker_events").insert({breaker:"model_health",state:"CLOSED",reason:"monitoring_recovered",metrics:{brier,drift,dataAge,observations:matched.length}});

    let retrainRequested=false;
    if(matched.length>=minOutcomes&&(status==="warn"||status==="fail")){
      const day=new Date().toISOString().slice(0,10),key=`performance:${modelVersion}:${day}:${status}`;
      const{error}=await db.from("retraining_requests").insert({idempotency_key:key,trigger_type:status==="fail"?"drift":"performance",symbol:SYMBOL,model_name:"logistic_direction_15m_proxy",model_version_before:modelVersion,status:"pending",reason:{status,brier,drift_score:drift,data_age_minutes:dataAge,observations:matched.length}});if(!error){retrainRequested=true;await db.rpc("invoke_baseline_training")}
    }
    if(loop?.id)await db.from("closed_loop_runs").update({status:"success",finished_at:new Date().toISOString(),model_version:modelVersion,counts:{outcomes_inserted:inserted,monitoring_observations:matched.length},metrics:{status,brier,accuracy,coverage,trade_win_rate:tradeWin,mean_signed_return:meanSigned,calibration_bias:calibrationBias,drift_score:drift,data_age_minutes:dataAge},metadata:{retrain_requested:retrainRequested,proxy:true}}).eq("id",loop.id);
    return Response.json({ok:true,outcomesInserted:inserted,modelVersion,monitoring:{status,observations:matched.length,brier,accuracy,coverage,tradeWinRate:tradeWin,meanSignedReturn:meanSigned,calibrationBias,driftScore:drift,dataAgeMinutes:dataAge},retrainRequested,liveEnabled:false});
  }catch(e){if(loop?.id)await db.from("closed_loop_runs").update({status:"failed",finished_at:new Date().toISOString(),error:String(e)}).eq("id",loop.id);return Response.json({ok:false,error:String(e)},{status:500})}
});
