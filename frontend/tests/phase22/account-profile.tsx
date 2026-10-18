import React from 'react'
import { createRoot } from 'react-dom/client'
import { useAccountProfile } from '../../src/hooks/useAccountProfile'
import AccountNamePopup from '../../src/components/AccountNamePopup'
function Fixture() {
  const { authUser, login, logout, saveAccountName } = useAccountProfile()
  return <><output aria-label="Current profile">{authUser?.userId}:{authUser?.accountName}</output><button onClick={logout}>Sign out</button><button onClick={() => login('other','other@example.com',false,'Other')}>Other account</button>{authUser && <AccountNamePopup key={authUser.userId} user={authUser} onSave={saveAccountName} />}</>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
