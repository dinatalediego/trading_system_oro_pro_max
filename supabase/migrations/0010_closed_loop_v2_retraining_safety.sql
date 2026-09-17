update public.risk_limits
set config = config || jsonb_build_object('live_enabled',false,'paper_only',true)
where name='global';
