-- The first logged reading is the earliest reliable timestamp available for
-- existing SD files. Keep modified_at for compatibility with older loggers.
alter table public.device_files add column if not exists created_at timestamptz;
