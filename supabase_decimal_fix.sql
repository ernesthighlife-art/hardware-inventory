-- 我的庫存：小數數量修正
-- 重要：截圖顯示前端已能輸入 7.3，但 Supabase 的確認入庫流程仍把數量當 integer。
-- 這份 SQL 先把「數量/庫存」欄位改成 numeric(18,4)。
-- 執行方式：Supabase → SQL Editor → 貼上 → Run。

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='purchase_document_items'
      and column_name='quantity'
  ) then
    execute 'alter table public.purchase_document_items
             alter column quantity type numeric(18,4)
             using quantity::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products'
      and column_name='stock'
  ) then
    execute 'alter table public.products
             alter column stock type numeric(18,4)
             using stock::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products'
      and column_name='min_stock'
  ) then
    execute 'alter table public.products
             alter column min_stock type numeric(18,4)
             using min_stock::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products'
      and column_name='purchase_to_sale_qty'
  ) then
    execute 'alter table public.products
             alter column purchase_to_sale_qty type numeric(18,4)
             using purchase_to_sale_qty::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='inventory_transactions'
      and column_name='quantity'
  ) then
    execute 'alter table public.inventory_transactions
             alter column quantity type numeric(18,4)
             using quantity::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='inventory_transactions'
      and column_name='delta'
  ) then
    execute 'alter table public.inventory_transactions
             alter column delta type numeric(18,4)
             using delta::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='inventory_transactions'
      and column_name='before_stock'
  ) then
    execute 'alter table public.inventory_transactions
             alter column before_stock type numeric(18,4)
             using before_stock::numeric';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='inventory_transactions'
      and column_name='after_stock'
  ) then
    execute 'alter table public.inventory_transactions
             alter column after_stock type numeric(18,4)
             using after_stock::numeric';
  end if;
end $$;

commit;

-- ============================================================
-- 如果「確認入庫」仍出現：
-- invalid input syntax for type integer: "7.3"
-- 代表 RPC 函式 confirm_purchase_document() 本身還有 integer
-- 型別轉換（例如 jsonb_to_recordset(... quantity integer)）。
--
-- 下面這行用來取得你目前資料庫的「完整函式原始碼」。
-- 把查詢結果貼給 ChatGPT，就能精準重建該 RPC，不需要猜。
-- ============================================================

select pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'confirm_purchase_document';

-- 同時檢查目前相關欄位型別：
select table_name, column_name, data_type, numeric_precision, numeric_scale
from information_schema.columns
where table_schema='public'
  and (
    (table_name='purchase_document_items' and column_name='quantity')
    or (table_name='products' and column_name in ('stock','min_stock','purchase_to_sale_qty'))
    or (table_name='inventory_transactions' and column_name in ('quantity','delta','before_stock','after_stock'))
  )
order by table_name, column_name;
