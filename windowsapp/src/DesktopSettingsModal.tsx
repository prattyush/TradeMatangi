import { useEffect, useState } from 'react'
import { GuardrailFields, guardrailFields } from './GuardrailSettings'
import {
  sharedSettingsSections,
  sectionSettings,
  type SettingsField
} from './settingsFields'

export interface ChartSettings {
  background: string
  textColor: string
  gridColor: string
  gridOpacity: number
  gridStyle: 'solid' | 'dashed'
  gridSize: number
  movingAverageType: 'MA' | 'EMA'
  movingAveragePeriods: string
  showChartInfo: boolean
  liveProvider: 'breeze'
  horizontalLineColor: string
  horizontalLineWidth: number
  trendLineColor: string
  trendLineWidth: number
  drawingLineColor: string
  drawingLineWidth: number
  drawingFillColor: string
  drawingFillOpacity: number
}
export type AccountRequest = <T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: Record<string, unknown>
) => Promise<T>
interface Profile {
  email: string
  is_admin: boolean
  real_trading_enabled: boolean
}
interface Props {
  settings: ChartSettings
  loadSettings: () => Promise<Record<string, unknown>>
  loadChartSettings: () => Promise<ChartSettings>
  onSave: (settings: ChartSettings) => Promise<void>
  onSaveTradingSettings: (
    settings: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  saveGuardrails: (
    settings: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  accountRequest: AccountRequest
  resetWallet: (amount: number) => Promise<void>
  walletResetDisabled: boolean
  walletResetContext?: string
  onClose: () => void
}

const optionLabels: Record<string, string> = {
  currency: 'Currency',
  percent: 'Percentage',
  quantity: 'Quantity',
  funds_ratio: 'Capital %',
  risk_ratio: 'Risk %',
  longOnly: 'Long Only',
  both: 'Both Long & Short',
  otm: 'OTM',
  threshold: 'Price Threshold',
  normalized: 'Normalized',
  raw: 'Raw',
  bar: 'Bar High / Low',
  deviation: '% from Close',
  shift_sl: 'Shift stoploss',
  limit_order: 'Place limit order',
  options: 'Options',
  underlying: 'Underlying',
  off: 'Off',
  popup: 'Popup',
  button: 'Button',
  '120': '2 min',
  '180': '3 min',
  '300': '5 min'
}
const tokenLabels: Record<string, string> = {
  icici_session: 'ICICI session token',
  kite_access: 'Kite access token',
  fyers_access: 'Fyers access token',
  fyers_refresh: 'Fyers refresh token'
}

function SettingControl({
  field,
  value,
  onChange
}: {
  field: SettingsField
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (field.type === 'boolean')
    return (
      <label>
        <span>
          <input
            aria-label={field.label}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />{' '}
          {field.label}
        </span>
      </label>
    )
  return (
    <label>
      {field.label}
      {field.type === 'select' ? (
        <select
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) =>
            onChange(
              field.key === 'strategy_interval_secs'
                ? Number(e.target.value)
                : e.target.value
            )
          }
        >
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {optionLabels[option] ?? option}
            </option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input
          aria-label={field.label}
          type="number"
          required
          min={field.min}
          max={field.max}
          step={field.step}
          value={value === '' ? '' : Number(value) * (field.scale ?? 1)}
          onChange={(e) =>
            onChange(
              e.target.value === ''
                ? ''
                : Number(e.target.value) / (field.scale ?? 1)
            )
          }
        />
      ) : (
        <input
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}

export function DesktopSettingsModal({
  settings,
  loadSettings,
  loadChartSettings,
  onSave,
  onSaveTradingSettings,
  saveGuardrails,
  accountRequest,
  resetWallet,
  walletResetDisabled,
  walletResetContext,
  onClose
}: Props) {
  const [draft, setDraft] = useState(settings)
  const [userDraft, setUserDraft] = useState<Record<string, unknown>>({})
  const [tab, setTab] = useState('General')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [walletAmount, setWalletAmount] = useState('150000')
  const [totp, setTotp] = useState('')
  const [brokerStatus, setBrokerStatus] = useState<Record<string, boolean>>({})
  const [brokerError, setBrokerError] = useState('')
  const [tokens, setTokens] = useState<Record<string, string | null>>({})
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({})
  const [streamSource, setStreamSource] = useState('kite')
  const [historical, setHistorical] = useState({
    source: 'breeze',
    allow_fallback: false
  })
  const [whitelist, setWhitelist] = useState<Array<{ email: string }>>([])
  const [email, setEmail] = useState('')
  const [passwords, setPasswords] = useState({
    old: '',
    next: '',
    confirm: ''
  })

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadFailed(false)
    setStatus('')
    void (async () => {
      try {
        const [user, chart, info] = await Promise.all([
          loadSettings(),
          loadChartSettings(),
          accountRequest<Profile>('profile', 'GET')
        ])
        let adminData:
          | [
              Record<string, string | null>,
              { source: string },
              { source: string; allow_fallback: boolean },
              Array<{ email: string }>
            ]
          | null = null
        if (info.is_admin)
          adminData = await Promise.all([
            accountRequest<Record<string, string | null>>(
              'admin/tokens',
              'GET'
            ),
            accountRequest<{ source: string }>('admin/stream-source', 'GET'),
            accountRequest<{ source: string; allow_fallback: boolean }>(
              'admin/historical-source',
              'GET'
            ),
            accountRequest<Array<{ email: string }>>(
              'admin/real-trading/whitelist',
              'GET'
            )
          ])
        if (!active) return
        setUserDraft(user)
        setDraft(chart)
        setProfile(info)
        if (adminData) {
          setTokens(adminData[0])
          setStreamSource(adminData[1].source)
          setHistorical(adminData[2])
          setWhitelist(adminData[3])
        }
      } catch (error) {
        if (active) {
          setLoadFailed(true)
          setStatus(String(error))
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [attempt])

  useEffect(() => {
    if (!profile?.real_trading_enabled) return
    let active = true
    void Promise.all(
      ['kotak', 'breeze'].map(async (broker) => {
        try {
          const value = await accountRequest<{ authenticated: boolean }>(
            `${broker}/status`,
            'GET'
          )
          if (active)
            setBrokerStatus((current) => ({
              ...current,
              [broker]: value.authenticated
            }))
        } catch (error) {
          if (active) setBrokerError(String(error))
        }
      })
    )
    return () => {
      active = false
    }
  }, [profile, attempt])

  const action = async (run: () => Promise<void>, message: string) => {
    setSaving(true)
    setStatus('')
    try {
      await run()
      setStatus(message)
    } catch (error) {
      setStatus(String(error))
    } finally {
      setSaving(false)
    }
  }
  const save = async () => {
    await action(async () => {
      if (tab === 'Drawing & Display') await onSave(draft)
      else if (tab === 'GuardRails') {
        const saved = await saveGuardrails(
          Object.fromEntries(
            guardrailFields.map(([key]) => [key, userDraft[key]])
          )
        )
        setUserDraft((current) => ({ ...current, ...saved }))
      } else
        setUserDraft(
          await onSaveTradingSettings(sectionSettings(tab, userDraft))
        )
    }, 'Settings saved')
  }
  const brokerControls = (
    <section className="settings-section">
      <strong>Broker connection</strong>
      <p>
        Kotak Neo:{' '}
        {brokerStatus.kotak === undefined
          ? 'Checking…'
          : brokerStatus.kotak
            ? 'Connected'
            : 'Disconnected'}
        . ICICI Breeze:{' '}
        {brokerStatus.breeze === undefined
          ? 'Checking…'
          : brokerStatus.breeze
            ? 'Connected'
            : 'Disconnected'}
        .
      </p>
      {brokerError && <p role="alert">{brokerError}</p>}
      <label>
        Kotak TOTP
        <input
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={totp}
          onChange={(e) =>
            setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))
          }
        />
      </label>
      <button
        type="button"
        disabled={totp.length !== 6}
        onClick={() =>
          void action(async () => {
            await accountRequest('kotak/login', 'POST', { totp })
            setTotp('')
            setBrokerStatus((current) => ({ ...current, kotak: true }))
          }, 'Kotak connected')
        }
      >
        Connect Kotak Neo
      </button>
    </section>
  )
  const tabs = [
    ...Object.keys(sharedSettingsSections),
    'GuardRails',
    'Drawing & Display',
    ...(profile?.is_admin ? ['Admin'] : []),
    'Profile'
  ]
  const preferenceTab = tab !== 'Admin' && tab !== 'Profile'
  return (
    <div className="modal-backdrop">
      <section
        className="instrument-modal desktop-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header>
          <strong>Settings</strong>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="settings-layout">
            <nav role="tablist" aria-label="Settings sections">
              {tabs.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  className={tab === name ? 'selected' : ''}
                  onClick={() => setTab(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
            <fieldset
              className="settings-scroll"
              disabled={loading || loadFailed || saving}
            >
              <section
                hidden={tab !== 'Drawing & Display'}
                className="settings-section"
              >
                <strong>Chart display</strong>
                <div className="picker-fields">
                  <label>
                    Background
                    <input
                      type="color"
                      value={draft.background}
                      onChange={(event) =>
                        setDraft({ ...draft, background: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Text color
                    <input
                      type="color"
                      value={draft.textColor}
                      onChange={(event) =>
                        setDraft({ ...draft, textColor: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Grid color
                    <input
                      type="color"
                      value={draft.gridColor}
                      onChange={(event) =>
                        setDraft({ ...draft, gridColor: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Grid opacity{' '}
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.02"
                      value={draft.gridOpacity}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          gridOpacity: Number(event.target.value)
                        })
                      }
                    />
                    {Math.round(draft.gridOpacity * 100)}%
                  </label>
                  <label>
                    Grid style
                    <select
                      value={draft.gridStyle}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          gridStyle: event.target
                            .value as ChartSettings['gridStyle']
                        })
                      }
                    >
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                    </select>
                  </label>
                  <label>
                    Grid thickness
                    <select
                      value={draft.gridSize}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          gridSize: Number(event.target.value)
                        })
                      }
                    >
                      <option value="1">1px</option>
                      <option value="2">2px</option>
                    </select>
                  </label>
                  <label>
                    Moving average
                    <select
                      value={draft.movingAverageType}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          movingAverageType: event.target
                            .value as ChartSettings['movingAverageType']
                        })
                      }
                    >
                      <option value="MA">Simple MA</option>
                      <option value="EMA">Exponential MA</option>
                    </select>
                  </label>
                  <label>
                    MA/EMA periods
                    <input
                      value={draft.movingAveragePeriods}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          movingAveragePeriods: event.target.value.replace(
                            /[^0-9,]/g,
                            ''
                          )
                        })
                      }
                      placeholder="5,10,20"
                    />
                  </label>
                  <label>
                    Horizontal line color
                    <input
                      type="color"
                      value={draft.horizontalLineColor}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          horizontalLineColor: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    Horizontal line width
                    <select
                      value={draft.horizontalLineWidth}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          horizontalLineWidth: Number(event.target.value)
                        })
                      }
                    >
                      <option value="1">1px</option>
                      <option value="2">2px</option>
                      <option value="3">3px</option>
                      <option value="4">4px</option>
                    </select>
                  </label>
                  <label>
                    Trend line color
                    <input
                      type="color"
                      value={draft.trendLineColor}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          trendLineColor: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    Trend line width
                    <select
                      value={draft.trendLineWidth}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          trendLineWidth: Number(event.target.value)
                        })
                      }
                    >
                      <option value="1">1px</option>
                      <option value="2">2px</option>
                      <option value="3">3px</option>
                      <option value="4">4px</option>
                    </select>
                  </label>
                  <label>
                    Other drawing line
                    <input
                      type="color"
                      value={draft.drawingLineColor}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          drawingLineColor: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    Other drawing width
                    <select
                      value={draft.drawingLineWidth}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          drawingLineWidth: Number(event.target.value)
                        })
                      }
                    >
                      <option value="1">1px</option>
                      <option value="2">2px</option>
                      <option value="3">3px</option>
                      <option value="4">4px</option>
                    </select>
                  </label>
                  <label>
                    Shape fill color
                    <input
                      type="color"
                      value={draft.drawingFillColor}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          drawingFillColor: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    Shape fill opacity{' '}
                    <input
                      type="range"
                      min="0"
                      max="0.8"
                      step="0.02"
                      value={draft.drawingFillOpacity}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          drawingFillOpacity: Number(event.target.value)
                        })
                      }
                    />
                    {Math.round(draft.drawingFillOpacity * 100)}%
                  </label>
                </div>
                <label>
                  <span>
                    <input
                      type="checkbox"
                      checked={draft.showChartInfo}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          showChartInfo: event.target.checked
                        })
                      }
                    />{' '}
                    Show OHLC and indicator information
                  </span>
                </label>
              </section>
              {sharedSettingsSections[tab] && (
                <section className="settings-section">
                  <strong>{tab}</strong>
                  {tab === 'General' && (
                    <p>
                      Indicator ratio and automatic option-selection preferences
                      currently apply to the website.
                    </p>
                  )}
                  {tab === 'Analytics' && (
                    <p>
                      These preferences are shared with the website. Features
                      without a desktop interface currently apply there.
                    </p>
                  )}
                  {tab === 'Strategies' && (
                    <p>
                      Applies to new strategies. Strategy candles are
                      independent of chart display intervals; candle interval
                      applies to new sessions.
                    </p>
                  )}
                  {tab === 'Trading' && (
                    <p>
                      Sizing applies to new sessions. Limit gaps apply to new
                      orders and trigger edits; pending orders retain their
                      prices.
                    </p>
                  )}
                  <div className="picker-fields">
                    {sharedSettingsSections[tab].map((field) => (
                      <SettingControl
                        key={field.key}
                        field={field}
                        value={userDraft[field.key]}
                        onChange={(value) =>
                          setUserDraft((current) => ({
                            ...current,
                            [field.key]: value
                          }))
                        }
                      />
                    ))}
                  </div>
                  {tab === 'Analytics' && (
                    <div className="picker-fields">
                      {['stepwise', 'sim', 'paper', 'real'].map((kind) => {
                        const modes = (userDraft.trade_labeling_mode_by_type ??
                          {}) as Record<string, string>
                        return (
                          <SettingControl
                            key={kind}
                            field={{
                              key: kind,
                              label: `${kind} trade labeling`,
                              type: 'select',
                              options: ['off', 'popup', 'button']
                            }}
                            value={modes[kind]}
                            onChange={(value) =>
                              setUserDraft((current) => ({
                                ...current,
                                trade_labeling_mode_by_type: {
                                  ...modes,
                                  [kind]: value
                                }
                              }))
                            }
                          />
                        )
                      })}
                    </div>
                  )}
                  {tab === 'General' && (
                    <>
                      <section className="settings-section">
                        <strong>{walletResetContext ?? 'Wallet'}</strong>
                        <label>
                          Reset amount (₹)
                          <input
                            type="number"
                            min="0"
                            value={walletAmount}
                            onChange={(e) => setWalletAmount(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={
                            walletResetDisabled ||
                            !walletAmount.trim() ||
                            !Number.isFinite(Number(walletAmount)) ||
                            Number(walletAmount) < 0
                          }
                          onClick={() =>
                            void action(
                              () => resetWallet(Number(walletAmount)),
                              'Wallet reset'
                            )
                          }
                        >
                          Reset wallet
                        </button>
                        {walletResetDisabled && (
                          <p>
                            Wallet reset is unavailable during an active session
                            or while the Paper wallet is locked.
                          </p>
                        )}
                      </section>
                      {profile?.real_trading_enabled && brokerControls}
                    </>
                  )}
                </section>
              )}
              {tab === 'GuardRails' && (
                <GuardrailFields draft={userDraft} onChange={setUserDraft} />
              )}
              {tab === 'Admin' && profile?.is_admin && (
                <section className="settings-section">
                  <strong>Admin</strong>
                  <p>
                    Data source changes use the same account-wide policies as
                    the website.
                  </p>
                  <div className="picker-fields">
                    {[
                      'icici_session',
                      'kite_access',
                      'fyers_access',
                      'fyers_refresh'
                    ].map((key) => (
                      <label key={key}>
                        {tokenLabels[key]} — {tokens[key] ?? 'Not configured'}
                        <input
                          type="password"
                          autoComplete="off"
                          value={tokenDraft[key] ?? ''}
                          onChange={(e) =>
                            setTokenDraft((current) => ({
                              ...current,
                              [key]: e.target.value
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={
                      !Object.values(tokenDraft).some((value) => value.trim())
                    }
                    onClick={() =>
                      void action(async () => {
                        const values = Object.fromEntries(
                          Object.entries(tokenDraft)
                            .filter(([, value]) => value.trim())
                            .map(([key, value]) => [key, value.trim()])
                        )
                        setTokens(
                          await accountRequest('admin/tokens', 'PUT', values)
                        )
                        setTokenDraft({})
                      }, 'Tokens saved')
                    }
                  >
                    Save broker tokens
                  </button>
                  <label>
                    Live streaming source
                    <select
                      value={streamSource}
                      onChange={(e) => setStreamSource(e.target.value)}
                    >
                      {['kite', 'fyers', 'kotak', 'breeze'].map((source) => (
                        <option key={source}>{source}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      void action(async () => {
                        const value = await accountRequest<{ source: string }>(
                          'admin/stream-source',
                          'PUT',
                          { source: streamSource }
                        )
                        setStreamSource(value.source)
                      }, 'Streaming source saved')
                    }
                  >
                    Save streaming source
                  </button>
                  <label>
                    Today's historical source
                    <select
                      value={historical.source}
                      onChange={(e) =>
                        setHistorical((current) => ({
                          ...current,
                          source: e.target.value
                        }))
                      }
                    >
                      <option value="breeze">ICICI Breeze</option>
                      <option value="kite">Kite</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={historical.allow_fallback}
                      onChange={(e) =>
                        setHistorical((current) => ({
                          ...current,
                          allow_fallback: e.target.checked
                        }))
                      }
                    />{' '}
                    Allow historical fallback
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      void action(
                        async () =>
                          setHistorical(
                            await accountRequest(
                              'admin/historical-source',
                              'PUT',
                              historical
                            )
                          ),
                        'Historical source saved'
                      )
                    }
                  >
                    Save historical source
                  </button>
                  <strong>Real trading access</strong>
                  <label>
                    Email
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!email.trim()}
                    onClick={() =>
                      void action(async () => {
                        await accountRequest(
                          'admin/real-trading/whitelist',
                          'POST',
                          { email }
                        )
                        setWhitelist(
                          await accountRequest(
                            'admin/real-trading/whitelist',
                            'GET'
                          )
                        )
                        setEmail('')
                      }, 'Real trading access granted')
                    }
                  >
                    Add user
                  </button>
                  <ul>
                    {whitelist.map((item) => (
                      <li key={item.email}>
                        {item.email}{' '}
                        <button
                          type="button"
                          onClick={() =>
                            void action(async () => {
                              await accountRequest(
                                `admin/real-trading/whitelist/${encodeURIComponent(item.email)}`,
                                'DELETE'
                              )
                              setWhitelist((current) =>
                                current.filter(
                                  (entry) => entry.email !== item.email
                                )
                              )
                            }, 'Real trading access removed')
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  {profile.real_trading_enabled && brokerControls}
                </section>
              )}
              {tab === 'Profile' && (
                <section className="settings-section">
                  <strong>{profile?.email}</strong>
                  <div className="picker-fields">
                    {(['old', 'next', 'confirm'] as const).map((key) => (
                      <label key={key}>
                        {key === 'old'
                          ? 'Current password'
                          : key === 'next'
                            ? 'New password'
                            : 'Confirm new password'}
                        <input
                          type="password"
                          autoComplete={
                            key === 'old' ? 'current-password' : 'new-password'
                          }
                          value={passwords[key]}
                          onChange={(e) =>
                            setPasswords((current) => ({
                              ...current,
                              [key]: e.target.value
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={
                      !passwords.old ||
                      passwords.next.length < 6 ||
                      passwords.next !== passwords.confirm
                    }
                    onClick={() =>
                      void action(async () => {
                        await accountRequest('change-password', 'POST', {
                          old_password: passwords.old,
                          new_password: passwords.next
                        })
                        setPasswords({ old: '', next: '', confirm: '' })
                      }, 'Password changed')
                    }
                  >
                    Change password
                  </button>
                </section>
              )}
            </fieldset>
          </div>
          {loading && <p role="status">Loading settings…</p>}
          {status && <p role={loadFailed ? 'alert' : 'status'}>{status}</p>}
          {loadFailed && (
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry loading settings
            </button>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              Close
            </button>
            {preferenceTab && (
              <button
                type="submit"
                className="selected"
                disabled={loading || loadFailed || saving}
              >
                {saving ? 'Saving…' : 'Save settings'}
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  )
}
