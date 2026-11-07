import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../services/api'
import { setNotificationAccount } from '../services/notifications'
import { BACKEND_URL } from '../config'

export interface AccountProfile { userId: string; email: string; isAdmin: boolean; accountName?: string }
function storedProfile(): AccountProfile | null {
  try {
    const parsed = JSON.parse(localStorage.getItem('auth_user') ?? 'null')
    return parsed ? { isAdmin: false, ...parsed } : null
  } catch { return null }
}
function persist(profile: AccountProfile | null) {
  try {
    if (profile) localStorage.setItem('auth_user', JSON.stringify(profile))
    else localStorage.removeItem('auth_user')
  } catch { /* A server-confirmed profile remains usable when browser writes are unavailable. */ }
}

/** Owns profile refresh/save ordering so stale requests cannot restore an old account/name. */
export function useAccountProfile() {
  const [authUser, setAuthUser] = useState<AccountProfile | null>(() => {
    const profile = storedProfile()
    setNotificationAccount(profile?.userId ?? null, BACKEND_URL)
    return profile
  })
  const current = useRef(authUser)
  const version = useRef(0)
  const apply = useCallback((profile: AccountProfile | null) => {
    current.current = profile
    persist(profile)
    setAuthUser(profile)
  }, [])
  const login = useCallback((userId: string, email: string, isAdmin = false, accountName?: string) => {
    // Requests take their identity from this cache; a new login must persist it first.
    const profile = { userId, email, isAdmin, accountName }
    localStorage.setItem('auth_user', JSON.stringify(profile))
    version.current++
    apply(profile)
    try { localStorage.setItem('user', JSON.stringify({ userId, username: email })) } catch { /* Optional legacy cache. */ }
  }, [apply])
  const logout = useCallback(() => { version.current++; apply(null) }, [apply])
  const userId = authUser?.userId
  useEffect(() => {
    if (!userId) return
    let active = true
    const requestVersion = version.current
    void api.getMe().then(me => {
      if (!active || version.current !== requestVersion || current.current?.userId !== userId || me.user_id !== userId) return
      apply({ ...current.current, isAdmin: me.is_admin ?? false, accountName: me.account_name?.trim() || undefined })
    }).catch(() => { /* Keep the cached profile and let a missing-name save report actionable errors. */ })
    return () => { active = false }
  }, [userId, apply])
  const saveAccountName = useCallback(async (name: string) => {
    const profile = current.current
    if (!profile) throw new Error('Please sign in again before saving your account name.')
    const requestVersion = ++version.current
    const me = await api.setAccountName(name.trim())
    if (version.current !== requestVersion || current.current?.userId !== profile.userId) return
    if (me.user_id !== profile.userId || !me.account_name?.trim()) throw new Error('The server did not confirm your account name. Please retry.')
    apply({ ...current.current, accountName: me.account_name.trim() })
  }, [apply])
  return { authUser, login, logout, saveAccountName }
}
