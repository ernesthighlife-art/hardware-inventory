create or replace function public.confirm_purchase_document(
  p_document_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_doc public.purchase_documents;
  v_item jsonb;
  v_item_id uuid;
  v_product_id uuid;
  v_vendor_id uuid;
  v_category_id uuid;
  v_location_id uuid;
  v_name text;
  v_spec text;
  v_unit text;
  v_parent text;
  v_child text;
  v_location text;
  v_note text;
  v_qty integer;
  v_cost numeric;
  v_price numeric;
  v_before integer;
  v_after integer;
  v_count integer := 0;
  v_product public.products;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception '商品明細格式錯誤';
  end if;

  select * into v_doc
  from public.purchase_documents
  where id = p_document_id
    and user_id = auth.uid()
  for update;

  if not found then
    raise exception '找不到這張貨單，或你沒有權限操作';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := nullif(v_item->>'item_id','')::uuid;
    v_product_id := nullif(v_item->>'product_id','')::uuid;
    v_vendor_id := nullif(v_item->>'vendor_id','')::uuid;
    v_category_id := nullif(v_item->>'category_id','')::uuid;
    v_location_id := nullif(v_item->>'location_id','')::uuid;
    v_name := trim(coalesce(v_item->>'name',''));
    v_spec := nullif(trim(v_item->>'spec'),'');
    v_unit := coalesce(nullif(trim(v_item->>'unit'),''),'個');
    v_parent := nullif(trim(v_item->>'parent_category'),'');
    v_child := nullif(trim(v_item->>'child_category'),'');
    v_location := nullif(trim(v_item->>'location'),'');
    v_note := nullif(trim(v_item->>'note'),'');
    v_qty := greatest(0, coalesce((v_item->>'quantity')::integer,0));
    v_cost := greatest(0, coalesce((v_item->>'cost')::numeric,0));
    v_price := greatest(0, coalesce((v_item->>'price')::numeric,0));

    if v_name = '' or v_qty <= 0 then
      raise exception '貨單中有商品名稱或數量未填寫';
    end if;

    if v_vendor_id is not null then
      if not exists (
        select 1 from public.vendors where id=v_vendor_id and user_id=auth.uid()
      ) then
        v_vendor_id := null;
      end if;
    end if;

    if v_product_id is null then
      insert into public.products (
        id,user_id,name,spec,vendor_id,unit,parent_category,child_category,
        location,category_id,location_id,stock,min_stock,cost,price,record_date,note
      ) values (
        gen_random_uuid(),auth.uid(),v_name,v_spec,v_vendor_id,v_unit,v_parent,v_child,
        v_location,v_category_id,v_location_id,0,0,v_cost,v_price,current_date,v_note
      ) returning * into v_product;
      v_product_id := v_product.id;
    else
      select * into v_product
      from public.products
      where id=v_product_id and user_id=auth.uid()
      for update;
      if not found then
        raise exception '貨單對應的既有商品不存在';
      end if;

      update public.products
      set
        name = v_name,
        spec = coalesce(v_spec, spec),
        vendor_id = coalesce(v_vendor_id, vendor_id),
        unit = v_unit,
        parent_category = coalesce(v_parent, parent_category),
        child_category = coalesce(v_child, child_category),
        location = coalesce(v_location, location),
        category_id = coalesce(v_category_id, category_id),
        location_id = coalesce(v_location_id, location_id),
        cost = v_cost,
        price = case when v_price > 0 then v_price else price end,
        record_date = current_date,
        note = coalesce(v_note, note),
        updated_at = now()
      where id=v_product_id and user_id=auth.uid()
      returning * into v_product;
    end if;

    v_before := coalesce(v_product.stock,0);
    v_after := v_before + v_qty;

    update public.products
    set stock=v_after, record_date=current_date, updated_at=now()
    where id=v_product_id and user_id=auth.uid();

    insert into public.inventory_transactions (
      user_id,product_id,type,quantity,delta,before_stock,after_stock,reason
    ) values (
      auth.uid(),v_product_id,'入庫',v_qty,v_qty,v_before,v_after,'貨單入庫'
    );

    if v_item_id is not null then
      update public.purchase_document_items
      set product_id=v_product_id,
          match_status='已匹配',
          match_confidence=1,
          unit=v_unit,
          unit_price=case when v_cost > 0 then v_cost else unit_price end,
          updated_at=now()
      where id=v_item_id
        and document_id=p_document_id
        and user_id=auth.uid();
    end if;

    v_count := v_count + 1;
  end loop;

  update public.purchase_documents
  set status='已確認', updated_at=now()
  where id=p_document_id and user_id=auth.uid();

  return jsonb_build_object(
    'ok', true,
    'document_id', p_document_id,
    'items_confirmed', v_count
  );
end;
$$;

grant execute on function public.confirm_purchase_document(uuid, jsonb) to authenticated;
