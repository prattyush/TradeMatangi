import { test, expect } from '@playwright/test'
const owner = { userId:'owner', email:'owner@example.com', isAdmin:false }
const profile = (name?:string) => ({ user_id:'owner',email:owner.email,is_admin:false,account_name:name })
test.beforeEach(async ({page}) => {
  await page.setViewportSize({width:768,height:1024})
  await page.addInitScript(user => { if (!localStorage.getItem('auth_user')) localStorage.setItem('auth_user',JSON.stringify(user)) },owner)
})
test('cached missing name closes when server profile loads',async({page})=>{
  await page.route('**/api/auth/me',route=>route.fulfill({json:profile('Existing')}))
  await page.goto('/tests/phase22/account-profile.html')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Current profile')).toHaveText('owner:Existing')
})
test('failed save retains input, retries and persists across refresh',async({page})=>{
  let name:string|undefined, attempts=0
  await page.route('**/api/auth/me',route=>route.fulfill({json:profile(name)}))
  await page.route('**/api/auth/account-name',async route=>{
    attempts++
    expect(route.request().headers()['x-user-id']).toBe('owner')
    if(attempts===1)return route.fulfill({status:500,json:{detail:'Database unavailable; please retry'}})
    name=route.request().postDataJSON().account_name
    await route.fulfill({json:profile(name)})
  })
  await page.goto('/tests/phase22/account-profile.html')
  await page.getByLabel('Account name',{exact:true}).fill('  Tablet Name  ')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Database unavailable')
  await expect(page.getByLabel('Account name',{exact:true})).toHaveValue('  Tablet Name  ')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('auth_user')!).accountName)).toBe('Tablet Name')
  // Init script only seeded initial navigation; do not erase the confirmed cache on reload.
  await page.reload()
  await expect(page.getByLabel('Current profile')).toHaveText('owner:Tablet Name')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
test('late initial profile cannot overwrite a saved name',async({page})=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/auth/me',async route=>{await gate;await route.fulfill({json:profile()})})
  await page.route('**/api/auth/account-name',route=>route.fulfill({json:profile('Saved')}))
  await page.goto('/tests/phase22/account-profile.html')
  await page.getByLabel('Account name',{exact:true}).fill('Saved')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const refreshed = page.waitForResponse('**/api/auth/me')
  release()
  await refreshed
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('auth_user')!).accountName)).toBe('Saved')
  await expect(page.getByLabel('Current profile')).toHaveText('owner:Saved')
})
test('offline save shows error and unavailable storage writes do not invalidate server success',async({page})=>{
  await page.route('**/api/auth/me',route=>route.fulfill({json:profile()}))
  let offline=true
  await page.route('**/api/auth/account-name',route=>offline?route.abort('internetdisconnected'):route.fulfill({json:profile('Saved')}))
  await page.goto('/tests/phase22/account-profile.html')
  await page.getByLabel('Account name',{exact:true}).fill('Saved')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('no HTTP response')
  offline=false
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('Storage disabled')}})
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Current profile')).toHaveText('owner:Saved')
})
test('whitespace rejected and duplicate saves suppressed',async({page})=>{
  await page.route('**/api/auth/me',route=>route.fulfill({json:profile()}))
  let requests=0, release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/auth/account-name',async route=>{requests++;await gate;await route.fulfill({json:profile('Saved')})})
  await page.goto('/tests/phase22/account-profile.html')
  await page.getByLabel('Account name',{exact:true}).fill('   ')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Enter an account name')
  expect(requests).toBe(0)
  await page.getByLabel('Account name',{exact:true}).fill('Saved')
  await page.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
  await expect.poll(()=>requests).toBe(1)
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
for(const action of ['Sign out','Other account'])test(`pending profile and name saves cannot affect ${action}`,async({page})=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/auth/me',async route=>{if(route.request().headers()['x-user-id']==='other')return route.fulfill({json:{...profile('Other'),user_id:'other'}});await gate;await route.fulfill({json:profile('Old')})})
  await page.route('**/api/auth/account-name',async route=>{await gate;await route.fulfill({json:profile('Saved')})})
  await page.goto('/tests/phase22/account-profile.html')
  await page.getByLabel('Account name',{exact:true}).fill('Saved')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  // Test the owner lifecycle directly while the modal is saving.
  await page.getByRole('button',{name:action,exact:true}).evaluate((button:HTMLButtonElement)=>button.click())
  release()
  await expect(page.getByLabel('Current profile')).toHaveText(action==='Sign out'?':':'other:Other')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const fail of [false, true]) test(`tablet can close account name popup${fail ? ' after a 500' : ''} and use email`, async ({page}) => {
  await page.route('**/api/auth/me', route => route.fulfill({json:profile()}))
  await page.route('**/api/auth/account-name', route => route.fulfill({status:500,json:{detail:'Could not save account name. Please retry.'}}))
  await page.goto('/tests/phase22/account-profile.html')
  if (fail) {
    await page.getByLabel('Account name',{exact:true}).fill('Tablet')
    await page.getByRole('button',{name:'Save',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('Could not save')
  }
  await page.getByRole('button',{name:'Close account name popup'}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Display name')).toHaveText(owner.email)
  await page.getByRole('button',{name:'Other account',exact:true}).click()
  await expect(page.getByLabel('Display name')).toHaveText('Other')
})

test('legacy backend profile without email preserves signed-in email and saves name', async ({page}) => {
  await page.route('**/api/auth/me', route => route.fulfill({json:{...profile(), email:''}}))
  await page.route('**/api/auth/account-name', route => route.fulfill({json:{...profile('Tablet'), email:''}}))
  await page.goto('/tests/phase22/account-profile.html')
  await expect(page.getByLabel('Display name')).toHaveText(owner.email)
  await page.getByLabel('Account name',{exact:true}).fill('Tablet')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Display name')).toHaveText('Tablet')
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('auth_user')!).email)).toBe(owner.email)
})
