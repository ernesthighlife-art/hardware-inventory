import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function clean(v: unknown, max = 300) {
  return String(v ?? '').trim().slice(0, max);
}

function norm(s: unknown) {
  return String(s ?? '').toLowerCase().replace(/[\s　×x＊*·,，、\-_/]/g, '');
}

function tokens(s: string) {
  return s
    .toLowerCase()
    .split(/[^0-9a-zA-Z一-龥]+/)
    .map(x => x.trim())
    .filter(x => x.length >= 1);
}

function scoreCandidate(item: any, p: any) {
  const target = norm(`${item.raw_name} ${item.raw_spec}`);
  const pn = norm(`${p.name} ${p.spec}`);
  if (!target || !pn) return 0;
  if (pn === target) return 1;
  let score = 0;
  if (norm(p.name) && target.includes(norm(p.name))) score += 0.45;
  if (norm(item.raw_name) && pn.includes(norm(item.raw_name))) score += 0.4;
  const tt = tokens(`${item.raw_name} ${item.raw_spec}`);
  const pp = tokens(`${p.name} ${p.spec}`);
  const hits = tt.filter(t => pp.includes(t) || pp.some(x => x.includes(t) || t.includes(x))).length;
  score += Math.min(0.35, hits * 0.08);
  if (item.raw_spec && p.spec && norm(item.raw_spec) === norm(p.spec)) score += 0.25;
  return Math.min(0.99, score);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function extractOutputText(resp: any) {
  if (typeof resp?.output_text === 'string') return resp.output_text.trim();
  const parts: string[] = [];
  for (const o of resp?.output || []) {
    for (const c of o?.content || []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = (fenced || text).trim();
  try { return JSON.parse(candidate); } catch {}
  const a = candidate.indexOf('{');
  const b = candidate.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(candidate.slice(a, b + 1));
  throw new Error('AI 回傳格式無法解析');
}

function getPublishableKey() {
  const direct = Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (direct) return direct;
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (anon) return anon;
  const raw = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Object.values(parsed || {}).filter(v => typeof v === 'string');
      if (arr.length) return arr[0] as string;
    } catch {}
  }
  return '';
}

const invoiceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vendor_name: { type: 'string' },
    document_number: { type: 'string' },
    document_date: { type: 'string' },
    total_amount: { type: ['number', 'null'] },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          raw_name: { type: 'string' },
          raw_spec: { type: 'string' },
          quantity: { type: 'integer' },
          unit: { type: 'string' },
          unit_price: { type: ['number', 'null'] },
          line_total: { type: ['number', 'null'] },
          sku: { type: 'string' },
          barcode: { type: 'string' },
          remark: { type: 'string' },
        },
        required: ['raw_name','raw_spec','quantity','unit','unit_price','line_total','sku','barcode','remark'],
      },
    },
  },
  required: ['vendor_name','document_number','document_date','total_amount','currency','items'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKey = getPublishableKey();
  const auth = req.headers.get('Authorization') || '';
  if (!openaiKey) return json({ ok: false, error: '尚未設定 OPENAI_API_KEY' }, 500);
  if (!supabaseUrl || !publishableKey) return json({ ok: false, error: 'Supabase 環境變數不完整' }, 500);
  if (!auth.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: '請先登入' }, 401);

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return json({ ok: false, error: '登入狀態已失效，請重新登入' }, 401);
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: '請提供 JSON' }, 400); }
  const documentId = clean(body?.document_id, 100);
  if (!documentId) return json({ ok: false, error: '缺少 document_id' }, 400);

  const { data: doc, error: docError } = await supabase
    .from('purchase_documents')
    .select('id,user_id,vendor_id,document_number,document_date,image_path,status')
    .eq('id', documentId)
    .eq('user_id', userId)
    .single();
  if (docError || !doc) return json({ ok: false, error: '找不到這張貨單' }, 404);
  if (!doc.image_path) return json({ ok: false, error: '貨單沒有照片' }, 400);

  const { data: file, error: downloadError } = await supabase.storage.from('inventory-photos').download(doc.image_path);
  if (downloadError || !file) return json({ ok: false, error: '讀取貨單照片失敗：' + (downloadError?.message || '未知錯誤') }, 500);
  const contentType = file.type || 'image/jpeg';
  const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));

  const vendorRows = (await supabase.from('vendors').select('id,name').order('name').limit(1000)).data || [];
  const categoryRows = (await supabase.from('categories').select('id,name,parent_id').order('name').limit(1000)).data || [];
  const locationRows = (await supabase.from('locations').select('id,name,parent_id').order('name').limit(1000)).data || [];

  const prompt = `你是五金行貨單辨識助手。請從這張台灣五金行估價單/出貨單/收據中精確辨識文字與數字。\n\n要求：\n1. 廠商名稱盡可能完整。\n2. 貨單編號、日期、總金額。\n3. 每一列商品都要拆成獨立項目。\n4. 數量、單位、單價、行小計要照圖片，不要自行計算取代圖片。\n5. 五金尺寸、材質、型號、英文數字代號要保留，例如 5尺×50米、6尺×50米、M6、304、白鐵。\n6. 看不清楚時留空字串或 null，不要猜。\n7. 使用繁體中文。\n\n以下是目前系統中的分類與位置名稱，可用來理解，但不要把不存在於圖片的資料當成貨單內容：\n分類：${JSON.stringify(categoryRows.slice(0, 300))}\n位置：${JSON.stringify(locationRows.slice(0, 300))}`;

  const aiResp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:${contentType};base64,${base64}`, detail: 'high' },
      ] }],
      text: { format: { type: 'json_schema', name: 'purchase_invoice', strict: true, schema: invoiceSchema } },
      max_output_tokens: 5000,
    }),
  });
  if (!aiResp.ok) return json({ ok: false, error: `AI 辨識服務錯誤（${aiResp.status}）：${(await aiResp.text()).slice(0, 300)}` }, 502);

  let parsed: any;
  try { parsed = parseJson(extractOutputText(await aiResp.json())); }
  catch (e) { return json({ ok: false, error: 'AI 辨識結果無法解析：' + (e instanceof Error ? e.message : String(e)) }, 502); }

  let matchedVendor = null;
  const vendorNorm = norm(parsed.vendor_name);
  if (vendorNorm) {
    matchedVendor = vendorRows.find((v: any) => norm(v.name) === vendorNorm) ||
      vendorRows.find((v: any) => vendorNorm.includes(norm(v.name)) || norm(v.name).includes(vendorNorm)) || null;
  }

  const outputItems=[];
  const dbItems=[];

  for (const it of (Array.isArray(parsed.items) ? parsed.items : [])) {
    const rawName=clean(it.raw_name,200);
    const rawSpec=clean(it.raw_spec,300);
    const qty=Math.max(0, Number(it.quantity||0));
    if(!rawName || qty<=0) continue;

    const searchTerms=[rawName, rawSpec, clean(it.sku,100), clean(it.barcode,100)].filter(x=>x.length>=2);
    let prodQuery=supabase.from('products').select('id,sku,name,spec,stock,min_stock,cost,price,unit,vendor_id,parent_category,child_category,location,category_id,location_id,barcode').limit(30);
    if(matchedVendor?.id) prodQuery=prodQuery.eq('vendor_id',matchedVendor.id);
    const orParts:string[]=[];
    for(const term of searchTerms.slice(0,4)){
      const t=term.replace(/[%(),]/g,' ').trim().slice(0,80);
      if(!t) continue;
      for(const f of ['name','spec','sku','barcode','note']) orParts.push(`${f}.ilike.%${t}%`);
    }
    if(orParts.length) prodQuery=prodQuery.or(orParts.join(','));
    const candRes=await prodQuery;
    const candidates=(candRes.data||[]).map((p:any)=>({...p,_score:scoreCandidate({raw_name:rawName,raw_spec:rawSpec},p)})).sort((a:any,b:any)=>b._score-a._score).slice(0,5);
    const top=candidates[0];
    const confidence=top?Number(top._score||0):0;
    const status=top&&confidence>=0.72?'已匹配':'待確認';
    const meta={
      candidates:candidates.map((p:any)=>({id:p.id,name:p.name,spec:p.spec,stock:p.stock,unit:p.unit,confidence:Number(p._score||0),parent_category:p.parent_category,child_category:p.child_category,location:p.location,price:p.price,cost:p.cost})),
      suggested_product_id: status==='已匹配'?top.id:null,
      suggested_parent_category: top?.parent_category||'',
      suggested_child_category: top?.child_category||'',
      suggested_location: top?.location||'',
      suggested_price: top?.price??null,
      reason: status==='已匹配' ? '找到相似的既有商品，請確認是否為同一項。' : '找不到足夠接近的既有商品，建議確認後建立新商品。',
      unit: clean(it.unit,30),
    };
    outputItems.push({raw_name:rawName,raw_spec:rawSpec,quantity:qty,unit:clean(it.unit,30)||'個',unit_price:it.unit_price==null?null:Number(it.unit_price),line_total:it.line_total==null?null:Number(it.line_total),sku:clean(it.sku,100),barcode:clean(it.barcode,100),...meta});
    dbItems.push({
      id:crypto.randomUUID(),document_id:documentId,user_id:userId,product_id:status==='已匹配'?top.id:null,
      raw_name:rawName,raw_spec:rawSpec,quantity:qty,unit:clean(it.unit,30)||'個',unit_price:it.unit_price==null?null:Number(it.unit_price),
      match_status:status,match_confidence:confidence
    });
  }

  await supabase.from('purchase_document_items').delete().eq('document_id',documentId).eq('user_id',userId);
  if(dbItems.length){
    const ins=await supabase.from('purchase_document_items').insert(dbItems);
    if(ins.error) return json({ok:false,error:'儲存貨單辨識項目失敗：'+ins.error.message},500);
  }

  const summaryParts=[
    parsed.vendor_name ? `廠商：${parsed.vendor_name}` : '廠商：未辨識',
    `商品：${outputItems.length} 筆`,
    parsed.total_amount!=null ? `合計：${parsed.total_amount}` : '合計：未辨識',
  ];
  const aiRaw={...parsed,suggested_vendor_id:matchedVendor?.id||null,items:outputItems};
  const upd={vendor_id:matchedVendor?.id||null,document_number:clean(parsed.document_number,100)||null,document_date:/^\d{4}-\d{2}-\d{2}$/.test(parsed.document_date)?parsed.document_date:doc.document_date,status:'待確認',ai_summary:summaryParts.join('｜'),ai_raw:aiRaw,updated_at:new Date().toISOString()};
  const up=await supabase.from('purchase_documents').update(upd).eq('id',documentId).eq('user_id',userId).select('id,user_id,vendor_id,document_number,document_date,image_path,status,ai_summary,ai_raw,created_at,updated_at').single();
  if(up.error) return json({ok:false,error:'更新貨單狀態失敗：'+up.error.message},500);

  return json({ok:true,document:up.data,items:dbItems,parsed:aiRaw});
});
