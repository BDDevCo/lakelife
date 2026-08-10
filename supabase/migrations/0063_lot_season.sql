-- ============================================================================
-- 0063 — A SEASON THAT BELONGS TO THE LOT, NOT ONLY THE PARK.
--
-- THE THING THAT COULD NOT BE SAID. The Haven's lots run year-round; its 20
-- boat slips run April to October. The season was a single park-level window,
-- so the park could be seasonal or year-round but not both — and since the
-- park is year-round, a slip could be sold in January. Twenty slips at $100 a
-- month is $14,000 a year that the model had no way to describe correctly.
--
-- INHERITANCE, NOT DUPLICATION. A lot with no season of its own inherits the
-- park's. NULL therefore means "same as the park", and the park's own NULL
-- means year-round. That ordering matters: it keeps every existing lot in
-- every existing park behaving exactly as it did, and makes the slip the
-- exception it actually is rather than forcing 21 pads to restate a window
-- they do not have.
--
-- WHY NOT A DATE RANGE. A season recurs. Storing 2027-04-01..2027-10-31 would
-- be right once and then wrong every year after, and somebody would have to
-- remember to roll it. Month and day recur by construction.
-- ============================================================================

alter table public.park_lots add column if not exists season_open_month  smallint;
alter table public.park_lots add column if not exists season_open_day    smallint;
alter table public.park_lots add column if not exists season_close_month smallint;
alter table public.park_lots add column if not exists season_close_day   smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_season_months_check') then
    alter table public.park_lots add constraint park_lots_season_months_check
      check (
        (season_open_month  is null or season_open_month  between 1 and 12) and
        (season_close_month is null or season_close_month between 1 and 12) and
        (season_open_day    is null or season_open_day    between 1 and 31) and
        (season_close_day   is null or season_close_day   between 1 and 31)
      );
  end if;
end $$;

-- HALF A SEASON IS WORSE THAN NONE. An open month with no close date is not a
-- window, it is a bug that reads as year-round and quietly sells a slip in
-- February. Either all four are set or none are.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'park_lots_season_all_or_nothing') then
    alter table public.park_lots add constraint park_lots_season_all_or_nothing
      check (
        (season_open_month is null and season_open_day is null
         and season_close_month is null and season_close_day is null)
        or
        (season_open_month is not null and season_open_day is not null
         and season_close_month is not null and season_close_day is not null)
      );
  end if;
end $$;

comment on column public.park_lots.season_open_month is
  'This lot''s own season. NULL on all four = inherit the park''s window, and '
  'a park with none is year-round. The Haven''s slips are Apr-Oct while its '
  'pads are year-round, which a park-level season alone cannot express.';


-- ------------------------------------------------------ post-conditions -----
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='park_lots'
     and column_name in ('season_open_month','season_open_day','season_close_month','season_close_day');
  if n <> 4 then
    raise exception '0063: expected 4 lot season columns, found %', n;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'park_lots_season_all_or_nothing') then
    raise exception '0063: a lot could carry half a season and read as year-round';
  end if;

  -- Nothing existing may have acquired a season by accident.
  if exists (select 1 from public.park_lots where season_open_month is not null) then
    raise exception '0063: an existing lot gained a season it never had';
  end if;

  raise notice '0063: a lot can hold its own season; NULL still means the park''s.';
end $$;
