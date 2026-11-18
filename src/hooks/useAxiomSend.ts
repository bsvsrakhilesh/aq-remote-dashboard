import { useCallback, useState } from 'react'
import { requestAxiom } from '../services/axiom'

export function useAxiomSend() {
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const send = useCallback(async (source: Record<string, string>) => {
    setBusy(true)
    setFailed(false)
    setNotice('')
    try {
      await requestAxiom({ ...source, action: 'create' })
      setRevision((value) => value + 1)
      setNotice('Queued for Axiom. You can close this page and check back later.')
      return true
    } catch (reason) {
      setFailed(true)
      setNotice(reason instanceof Error ? reason.message : 'Could not queue the file.')
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, failed, notice, revision, send }
}
