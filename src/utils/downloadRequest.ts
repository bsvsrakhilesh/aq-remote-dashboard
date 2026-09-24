export function describeDownloadRequestFailure(status?: number, code?: string, transport?: 'network' | 'relay') {
  if (transport === 'network') return 'Could not reach the transfer service. Check your connection and retry.'
  if (transport === 'relay') return 'The transfer service is temporarily unavailable. Please retry.'
  if (status === 401 || code === 'unauthorized')
    return 'Your session has expired. Sign out and sign in again, then retry the download.'
  if (code === 'file_not_found') return 'This file is no longer in the catalog. Refresh the file list and retry.'
  if (code === 'command_failed') return 'The logger command could not be queued. Please retry.'
  if (code === 'request_failed') return 'Supabase could not create the transfer request. Please retry.'
  if (code === 'invalid_request') return 'The file request is invalid. Refresh the file list and retry.'
  return status
    ? `The transfer service rejected the request (HTTP ${status}). Please retry.`
    : 'Could not start the transfer. Please retry.'
}
