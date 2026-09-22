import { Database, Download, FileText, Search } from 'lucide-react'
import { useState } from 'react'
import { DownloadModal } from '../components/DownloadModal'
import { useAllFiles } from '../hooks/useData'
import type { DeviceFile } from '../types'
import { formatDateTime, formatFileSize } from '../utils'

export function FilesPage(){
  const [query,setQuery]=useState(''); const [selected,setSelected]=useState<{file:DeviceFile;code:string;id:string}|null>(null); const {data,loading,error,reload}=useAllFiles()
  const rows=data.filter(r=>(r.file.filename+r.device.name).toLowerCase().includes(query.toLowerCase())); const deviceCount=new Set(data.map(r=>r.device.id)).size
  return <div className="page"><section className="page-heading"><div><span className="eyebrow">Temporary transfer centre</span><h1>Data files</h1><p>Browse SD-card catalogs and securely request full-resolution research files.</p></div></section><div className="info-banner"><Database/><span><strong>Cloud storage is temporary.</strong> Files remain on logger SD cards and are only uploaded when requested.</span></div>{error&&<div className="error-banner">Could not load the file catalog. <button onClick={reload}>Retry</button></div>}<section className="panel all-files"><div className="panel-head"><div><h2>Reported files</h2><p>{loading?'Loading catalog...':`${rows.length} files across ${deviceCount} loggers`}</p></div><label className="search"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search files..."/></label></div><div className="data-table"><div className="table-header"><span>File</span><span>Logger</span><span>Modified</span><span>Size</span><span></span></div>{rows.map(({file,device})=><div className="table-row" key={file.id}><span className="file-name-cell"><i><FileText size={17}/></i><strong>{file.filename}</strong></span><span>{device.code} · {device.name}</span><span>{formatDateTime(file.modifiedAt)}</span><span>{formatFileSize(file.size)}</span><button className="button secondary small" onClick={()=>setSelected({file,code:device.code,id:device.id})}><Download size={15}/> Request</button></div>)}</div></section>{selected&&<DownloadModal file={selected.file} deviceCode={selected.code} deviceId={selected.id} onClose={()=>setSelected(null)}/>}</div>
}
