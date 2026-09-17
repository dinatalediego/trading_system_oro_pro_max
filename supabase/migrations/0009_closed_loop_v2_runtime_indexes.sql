create unique index if not exists ux_paper_orders_prediction_once on public.paper_orders(prediction_id) where prediction_id is not null;
create index if not exists ix_prediction_outcomes_prediction_horizon on public.prediction_outcomes(prediction_id,horizon_minutes);
