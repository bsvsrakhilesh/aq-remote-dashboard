import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { demoMode, readOnlyMode, supabase } from './supabase'

export type FileListCommandStatus =
  'queued' | 'acknowledged' | 'running' | 'completed' | 'failed' | 'expired' | 'unknown'

export interface FileListCommandResult {
  commandId: string
  status: FileListCommandStatus
}

export interface FileListStatusResult extends FileListCommandResult {
  errorMessage: string | null
}

async function invokeFileList(body: Record<string, unknown>) {
  if (readOnlyMode) throw new Error('File commands are disabled in read-only mode')
  if (demoMode) throw new Error('File commands are unavailable in demo mode')
  if (!supabase) throw new Error('Supabase is not configured')

  const client = supabase
  const invoke = () => client.functions.invoke('request-file-list', { body })
  let { data, error } = await invoke()
  if (error instanceof FunctionsHttpError && error.context.status === 401) {
    // A browser tab can outlive its access token; refresh once before retrying.
    const { error: refreshError } = await client.auth.refreshSession()
    if (!refreshError) ({ data, error } = await invoke())
  }
  if (error instanceof FunctionsHttpError) {
    const status = error.context.status
    if (status === 401) throw new Error('Your session has expired. Sign out and sign in again, then refresh the list.')
    if (status === 404) throw new Error('This logger was not found by the command service. Reload the dashboard.')
    throw new Error(`File-list request failed (HTTP ${status}). Please retry.`)
  }
  if (error instanceof FunctionsFetchError)
    throw new Error('Network connection to the command service failed. Check your internet connection and retry.')
  if (error instanceof FunctionsRelayError)
    throw new Error('The command service is temporarily unavailable. Please retry shortly.')
  if (error) throw new Error('File-list request failed. Please retry.')
  return data
}

export async function queueFileListCommand(deviceId: string): Promise<FileListCommandResult> {
  const data = await invokeFileList({ device_id: deviceId })
  if (!data || typeof data.command_id !== 'string' || typeof data.status !== 'string')
    throw new Error('The command service did not return a file-list command ID.')
  return { commandId: data.command_id, status: data.status as FileListCommandStatus }
}

export async function getFileListCommandStatuses(commandIds: string[]): Promise<FileListStatusResult[]> {
  const results: FileListStatusResult[] = []
  for (let offset = 0; offset < commandIds.length; offset += 100) {
    const data = await invokeFileList({ action: 'status', command_ids: commandIds.slice(offset, offset + 100) })
    if (!data || !Array.isArray(data.statuses))
      throw new Error('The command service did not return file-list statuses.')
    for (const row of data.statuses) {
      if (!row || typeof row.command_id !== 'string' || typeof row.status !== 'string') continue
      results.push({
        commandId: row.command_id,
        status: row.status as FileListCommandStatus,
        errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
      })
    }
  }
  return results
}
