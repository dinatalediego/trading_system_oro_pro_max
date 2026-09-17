create index if not exists ix_model_predictions_symbol_features on public.model_predictions(symbol,features_ts desc);
create index if not exists ix_market_bars_symbol_provider_ts on public.market_bars(symbol,provider,ts desc);
