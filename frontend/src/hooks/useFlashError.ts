import { useEffect } from 'react'
import { flashError } from '../services/notifications'
/** Bridge local validation/error state to the shared floating journal. */
export function useFlashError(error: string | null | undefined, source: string) {
  useEffect(() => { if (error) flashError(error, source) }, [error, source])
}
