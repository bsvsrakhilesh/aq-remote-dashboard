import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { demoMode, readOnlyMode, supabase } from './supabase'

export async function queueFileListCommand(deviceId: string): Promise<void> {
  if (readOnlyMode) throw new Error('File commands are disabled in read-only mode')
  if (demoMode) return
  if (!supabase) throw new Error('Supabase is not configured')

  const client = supabase
  const invoke = () => client.functions.invoke('request-file-list', { body: { device_id: deviceId } })
  let { error } = await invoke()
  if (error instanceof FunctionsHttpError && error.context.status === 401) {
    // A browser tab can outlive its access token; refresh once before retrying.
    const { error: refreshError } = await client.auth.refreshSession()
    if (!refreshError) ({ error } = await invoke())
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
}
