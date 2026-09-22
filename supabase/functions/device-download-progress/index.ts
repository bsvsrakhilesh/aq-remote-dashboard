import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async(request)=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:corsHeaders(request)})
  const auth=await authenticateDevice(request)
  if(!auth)return json(request,{ok:false,error:'unauthorized'},401)
  const body=await request.json()
  if(typeof body.bytes_uploaded!=='number'||typeof body.total_bytes!=='number'||body.bytes_uploaded<0||body.total_bytes<=0)return json(request,{ok:false,error:'invalid_progress'},400)
  const progress=Math.max(0,Math.min(99,Math.floor(body.bytes_uploaded/body.total_bytes*100)))
  const {error}=await auth.db.from('download_requests').update({status:'uploading',bytes_uploaded:body.bytes_uploaded,total_bytes:body.total_bytes,progress_percent:progress}).eq('id',body.request_id).eq('device_id',auth.device.id)
  return error?json(request,{ok:false,error:'write_failed'},500):json(request,{ok:true,progress_percent:progress})
})
