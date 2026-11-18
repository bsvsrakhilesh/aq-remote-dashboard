import { FunctionsHttpError } from '@supabase/supabase-js'
import { demoMode, readOnlyMode, supabase } from './supabase'

export const axiomEnabled = import.meta.env.VITE_AXIOM_ENABLED === 'true' && !demoMode && !readOnlyMode
export const axiomMaxBytes = 40 * 1024 * 1024

export const axiomMessages: Record<string, string> = {
  forbidden: 'Your account does not have access to Axiom transfers.',
  not_configured: 'Axiom transfers have not been configured.',
  paused: 'New Axiom transfers are paused.',
  budget: 'The Axiom transfer budget is exhausted for this month.',
  queue_full: 'The transfer queue is full. Try again after a job finishes.',
  file_missing: 'This CSV is no longer available. Refresh the logger file list.',
  file_too_large: 'This file is too large to send. Download it from the logger locally and import it into Axiom.',
  invalid_range: 'Select up to seven consecutive dates in IST.',
  empty_range: 'There are no imported minutes in this date range.',
  source_expired: 'The snapshot expired or the logger could not supply it. Request a new capture.',
  source_unavailable: 'The snapshot could not be read.',
  retry_limit: 'The transfer reached its retry limit. Request a new capture.',
  archive_full: 'The lab machine is low on storage. Free space before sending again.',
}

export async function requestAxiom<T>(body: Record<string, string>): Promise<T> {
  if (!axiomEnabled || !supabase) throw new Error('Axiom transfers are unavailable.')
  const { data, error } = await supabase.functions.invoke('axiom-transfers', { body })
  if (error) {
    const result = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) : null
    throw new Error(axiomMessages[result?.error] ?? 'Axiom transfers are temporarily unavailable.')
  }
  return data as T
}
