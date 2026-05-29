import { useState, useEffect, useRef } from 'react'
import api from '../services/api'
import KotakTOTPModal from './KotakTOTPModal'

export interface FundsRatios {
  l: number  // percentage 0-100
  m: number
  h: number
}

const DEFAULT_FUNDS_RATIOS: FundsRatios = { l: 3, m: 6, h: 12 }
const FUNDS_RATIO_MODE_KEY = 'fundsRatioMode'
const FUNDS_RATIOS_KEY = 'fundsRatios'
const TARGET_DEVIATION_KEY = 'targetDeviationPct'
const BROKERAGE_KEY = 'brokeragePerOrder'
const STRATEGY_INTERVAL_KEY = 'strategyIntervalSecs'
const AUTOSTOP_TRIGGER_TYPE_KEY = 'autostopTriggerType'
const AUTOSTOP_DEVIATION_PCT_KEY = 'autostopDeviationPct'
const HISTORICAL_DAYS_KEY = 'historicalDays'
const PNL_PCT_MODE_KEY = 'pnlPctMode'
const BREAKEVEN_MODE_KEY = 'breakevenMode'
const TARGET_PROFIT_BUFFER_TICKS_KEY = 'targetProfitBufferTicks'
const AGGR_SL_ONLY_IN_PROFIT_KEY = 'aggrSlOnlyInProfit'

const GUARDRAIL_BLOCK_BARS_KEY = 'guardrailBlockBars'
const GUARDRAIL_COOLDOWN_BLOCK_BARS_KEY = 'guardrailCooldownBlockBars'
const GUARDRAIL_COOLDOWN_LOSSES_KEY = 'guardrailCooldownLosses'
const GUARDRAIL_BAN_CAPITAL_PCT_KEY = 'guardrailBanCapitalPct'
const GUARDRAIL_BAN_LOSS_TRADE_PCT_KEY = 'guardrailBanLossTradePct'
const GUARDRAIL_BAN_ENABLED_KEY = 'guardrailBanEnabled'
const GUARDRAIL_COOLDOWN_ENABLED_KEY = 'guardrailCooldownEnabled'

export function loadGuardRailBlockBars(): number {
  const v = parseInt(localStorage.getItem(GUARDRAIL_BLOCK_BARS_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 20 ? 3 : v
}
export function loadGuardRailCooldownBlockBars(): number {
  const v = parseInt(localStorage.getItem(GUARDRAIL_COOLDOWN_BLOCK_BARS_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 20 ? 3 : v
}
export function loadGuardRailCooldownLosses(): number {
  const v = parseInt(localStorage.getItem(GUARDRAIL_COOLDOWN_LOSSES_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 20 ? 3 : v
}
export function loadGuardRailBanCapitalPct(): number {
  const v = parseFloat(localStorage.getItem(GUARDRAIL_BAN_CAPITAL_PCT_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 100 ? 10.0 : v
}
export function loadGuardRailBanLossTradePct(): number {
  const v = parseFloat(localStorage.getItem(GUARDRAIL_BAN_LOSS_TRADE_PCT_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 100 ? 60.0 : v
}
export function loadGuardRailBanEnabled(): boolean {
  return localStorage.getItem(GUARDRAIL_BAN_ENABLED_KEY) === 'true'
}
export function loadGuardRailCooldownEnabled(): boolean {
  return localStorage.getItem(GUARDRAIL_COOLDOWN_ENABLED_KEY) === 'true'
}

export function loadPnlPctMode(): boolean {
  return localStorage.getItem(PNL_PCT_MODE_KEY) === 'true'
}

export function loadFundsRatioMode(): boolean {
  return localStorage.getItem(FUNDS_RATIO_MODE_KEY) === 'true'
}

export function loadFundsRatios(): FundsRatios {
  try {
    const stored = localStorage.getItem(FUNDS_RATIOS_KEY)
    if (stored) return { ...DEFAULT_FUNDS_RATIOS, ...JSON.parse(stored) }
  } catch { /* ignore */ }
  return { ...DEFAULT_FUNDS_RATIOS }
}

// Returns deviation as a fraction (0.01 = 1%)
export function loadTargetDeviationPct(): number {
  const v = parseFloat(localStorage.getItem(TARGET_DEVIATION_KEY) ?? '')
  return isNaN(v) || v < 0 ? 0.01 : v / 100
}

// Returns brokerage per order in rupees (default ₹1)
export function loadBrokeragePerOrder(): number {
  const v = parseFloat(localStorage.getItem(BROKERAGE_KEY) ?? '')
  return isNaN(v) || v < 0 ? 1 : v
}

// Strategy interval in seconds (180 = 3min, 300 = 5min)
export function loadStrategyIntervalSecs(): number {
  const v = parseInt(localStorage.getItem(STRATEGY_INTERVAL_KEY) ?? '')
  return isNaN(v) ? 180 : v
}

// AutoStop trigger type: "bar" (high/low) or "deviation" (% from close)
export function loadAutostopTriggerType(): 'bar' | 'deviation' {
  const v = localStorage.getItem(AUTOSTOP_TRIGGER_TYPE_KEY)
  return v === 'deviation' ? 'deviation' : 'bar'
}

// AutoStop deviation % (used when trigger type = deviation; e.g. 1.0 = 1%)
export function loadAutostopDeviationPct(): number {
  const v = parseFloat(localStorage.getItem(AUTOSTOP_DEVIATION_PCT_KEY) ?? '')
  return isNaN(v) || v < 0 ? 1.0 : v
}

// Historical days for chart context (default 2)
export function loadHistoricalDays(): number {
  const v = parseInt(localStorage.getItem(HISTORICAL_DAYS_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 5 ? 2 : v
}

// Breakeven mode: "shift_sl" (default) or "limit_order"
export function loadBreakevenMode(): 'shift_sl' | 'limit_order' {
  const v = localStorage.getItem(BREAKEVEN_MODE_KEY)
  return v === 'limit_order' ? 'limit_order' : 'shift_sl'
}

// TargetProfit buffer ticks (1–5, default 3)
export function loadTargetProfitBufferTicks(): number {
  const v = parseInt(localStorage.getItem(TARGET_PROFIT_BUFFER_TICKS_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 5 ? 3 : v
}

// AggressiveStoploss: only update SL when position is in profit (default false)
export function loadAggrSlOnlyInProfit(): boolean {
  return localStorage.getItem(AGGR_SL_ONLY_IN_PROFIT_KEY) === 'true'
}

export interface GuardRailSettingsLocal {
  blockBars: number
  cooldownBlockBars: number
  cooldownLosses: number
  banCapitalPct: number
  banLossTradePct: number
  banEnabled: boolean
  cooldownEnabled: boolean
}

interface Props {
  date: string
  isAdmin?: boolean
  isRealTradingUser?: boolean
  sessionActive?: boolean
  onWalletReset: () => void
  onFundsRatioChange: (mode: boolean, ratios: FundsRatios) => void
  onTargetDeviationChange: (pct: number) => void  // fraction e.g. 0.01
  onBrokerageChange: (brokerage: number) => void  // rupees per order
  onStrategySettingsChange: (intervalSecs: number, triggerType: 'bar' | 'deviation', deviationPct: number, breakevenMode: 'shift_sl' | 'limit_order', bufferTicks: number, aggrSlOnlyInProfit: boolean) => void
  onHistoricalDaysChange?: (days: number) => void
  onPnlPctModeChange?: (enabled: boolean) => void
  onGuardRailSettingsChange?: (settings: GuardRailSettingsLocal) => void
}

export default function SettingsModal({ date, isAdmin, isRealTradingUser, sessionActive, onWalletReset, onFundsRatioChange, onTargetDeviationChange, onBrokerageChange, onStrategySettingsChange, onHistoricalDaysChange, onPnlPctModeChange, onGuardRailSettingsChange }: Props) {
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const [pnlPctMode, setPnlPctMode] = useState(loadPnlPctMode)
  const [fundsRatioMode, setFundsRatioMode] = useState(loadFundsRatioMode)
  const [ratios, setRatios] = useState<FundsRatios>(loadFundsRatios)
  const [ratioInputs, setRatioInputs] = useState<{ l: string; m: string; h: string }>(() => {
    const r = loadFundsRatios()
    return { l: String(r.l), m: String(r.m), h: String(r.h) }
  })

  // TARGET deviation state (stored as % 0-100 in localStorage, exposed as fraction)
  const [deviationInput, setDeviationInput] = useState<string>(() => {
    const stored = parseFloat(localStorage.getItem(TARGET_DEVIATION_KEY) ?? '')
    return String(isNaN(stored) ? 1 : stored)
  })

  // Brokerage per order in rupees
  const [brokerageInput, setBrokerageInput] = useState<string>(() => {
    const v = parseFloat(localStorage.getItem(BROKERAGE_KEY) ?? '')
    return String(isNaN(v) || v < 0 ? 1 : v)
  })

  // Strategy settings
  const [stratIntervalSecs, setStratIntervalSecs] = useState(loadStrategyIntervalSecs)
  const [autostopTriggerType, setAutostopTriggerType] = useState(loadAutostopTriggerType)
  const [autostopDeviationPctInput, setAutostopDeviationPctInput] = useState<string>(() =>
    String(loadAutostopDeviationPct())
  )

  // Historical days
  const [historicalDays, setHistoricalDays] = useState(loadHistoricalDays)

  // Strategies settings
  const [breakevenMode, setBreakevenMode] = useState(loadBreakevenMode)
  const [targetProfitBufferTicks, setTargetProfitBufferTicks] = useState(loadTargetProfitBufferTicks)
  const [aggrSlOnlyInProfit, setAggrSlOnlyInProfit] = useState(loadAggrSlOnlyInProfit)

  // Active tab
  const [activeTab, setActiveTab] = useState<'general' | 'strategies' | 'guardrails' | 'admin' | 'profile'>('general')

  // GuardRails settings state
  const [grBanEnabled, setGrBanEnabled] = useState(loadGuardRailBanEnabled)
  const [grCooldownEnabled, setGrCooldownEnabled] = useState(loadGuardRailCooldownEnabled)
  const [grBlockBarsInput, setGrBlockBarsInput] = useState(() => String(loadGuardRailBlockBars()))
  const [grCooldownBlockBarsInput, setGrCooldownBlockBarsInput] = useState(() => String(loadGuardRailCooldownBlockBars()))
  const [grCooldownLossesInput, setGrCooldownLossesInput] = useState(() => String(loadGuardRailCooldownLosses()))
  const [grBanCapitalInput, setGrBanCapitalInput] = useState(() => String(loadGuardRailBanCapitalPct()))
  const [grBanLossTradeInput, setGrBanLossTradeInput] = useState(() => String(loadGuardRailBanLossTradePct()))

  // Admin section — broker tokens
  const [iciciInput, setIciciInput] = useState('')
  const [kiteInput, setKiteInput] = useState('')
  const [iciciMasked, setIciciMasked] = useState<string | null>(null)
  const [kiteMasked, setKiteMasked] = useState<string | null>(null)
  const adminLoadedRef = useRef(false)

  // Admin section — live streaming source
  const [streamSource, setStreamSource] = useState<'kite' | 'kotak'>('kite')

  // Real trading whitelist (admin)
  const [whitelistOpen, setWhitelistOpen] = useState(false)
  const [whitelist, setWhitelist] = useState<{ email: string; added_at?: string }[]>([])
  const [whitelistEmailInput, setWhitelistEmailInput] = useState('')
  const [whitelistLoading, setWhitelistLoading] = useState(false)

  // Broker connection (real trading users)
  const [kotakAuthenticated, setKotakAuthenticated] = useState<boolean | null>(null)
  const [showKotakTOTP, setShowKotakTOTP] = useState(false)

  // Change password
  const [pwOld, setPwOld] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwVisible, setPwVisible] = useState(false)
  const [pwStatus, setPwStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const [pwLoading, setPwLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setPwOld(''); setPwNew(''); setPwConfirm(''); setPwVisible(false); setPwStatus(null)
      return
    }
    // Sync from backend on open
    if (open) {
      api.getUserSettings().then(s => {
        setHistoricalDays(s.historical_days)
        localStorage.setItem(HISTORICAL_DAYS_KEY, String(s.historical_days))
      }).catch(() => {})

      api.getGuardRailSettings().then(s => {
        setGrBlockBarsInput(String(s.guardrail_block_bars))
        setGrCooldownBlockBarsInput(String(s.guardrail_cooldown_block_bars))
        setGrCooldownLossesInput(String(s.guardrail_cooldown_losses))
        setGrBanCapitalInput(String(s.guardrail_ban_capital_pct))
        setGrBanLossTradeInput(String(s.guardrail_ban_loss_trade_pct))
        setGrBanEnabled(s.guardrail_ban_enabled)
        setGrCooldownEnabled(s.guardrail_cooldown_enabled)
        localStorage.setItem(GUARDRAIL_BLOCK_BARS_KEY, String(s.guardrail_block_bars))
        localStorage.setItem(GUARDRAIL_COOLDOWN_BLOCK_BARS_KEY, String(s.guardrail_cooldown_block_bars))
        localStorage.setItem(GUARDRAIL_COOLDOWN_LOSSES_KEY, String(s.guardrail_cooldown_losses))
        localStorage.setItem(GUARDRAIL_BAN_CAPITAL_PCT_KEY, String(s.guardrail_ban_capital_pct))
        localStorage.setItem(GUARDRAIL_BAN_LOSS_TRADE_PCT_KEY, String(s.guardrail_ban_loss_trade_pct))
        localStorage.setItem(GUARDRAIL_BAN_ENABLED_KEY, String(s.guardrail_ban_enabled))
        localStorage.setItem(GUARDRAIL_COOLDOWN_ENABLED_KEY, String(s.guardrail_cooldown_enabled))
      }).catch(() => {})

      // Load masked tokens and stream source on first open (admin only)
      if (isAdmin && !adminLoadedRef.current) {
        adminLoadedRef.current = true
        api.getAdminTokens().then(t => {
          setIciciMasked(t.icici_session)
          setKiteMasked(t.kite_access)
        }).catch(() => {})
        api.getStreamSource().then(r => setStreamSource(r.source)).catch(() => {})
      }

      // Load Kotak status for real trading users
      if (isRealTradingUser || isAdmin) {
        api.kotakStatus().then(s => setKotakAuthenticated(s.authenticated)).catch(() => setKotakAuthenticated(false))
      }
    }
  }, [open])

  // Persist + notify parent whenever mode or ratios change
  useEffect(() => {
    localStorage.setItem(FUNDS_RATIO_MODE_KEY, String(fundsRatioMode))
    localStorage.setItem(FUNDS_RATIOS_KEY, JSON.stringify(ratios))
    onFundsRatioChange(fundsRatioMode, ratios)
  }, [fundsRatioMode, ratios])

  const toggleMode = () => setFundsRatioMode(m => !m)

  const togglePnlPctMode = () => {
    const next = !pnlPctMode
    setPnlPctMode(next)
    localStorage.setItem(PNL_PCT_MODE_KEY, String(next))
    onPnlPctModeChange?.(next)
  }

  const saveRatios = () => {
    const l = parseFloat(ratioInputs.l)
    const m = parseFloat(ratioInputs.m)
    const h = parseFloat(ratioInputs.h)
    if ([l, m, h].some(v => isNaN(v) || v <= 0 || v > 100)) {
      setStatus('Ratios must be 1–100')
      return
    }
    setRatios({ l, m, h })
    setStatus('Saved')
    setTimeout(() => setStatus(null), 2000)
  }

  const saveDeviation = () => {
    const pct = parseFloat(deviationInput)
    if (isNaN(pct) || pct < 0 || pct > 10) {
      setStatus('Deviation must be 0–10%')
      return
    }
    localStorage.setItem(TARGET_DEVIATION_KEY, String(pct))
    onTargetDeviationChange(pct / 100)
    setStatus(`Deviation saved: ${pct}%`)
    setTimeout(() => setStatus(null), 2000)
  }

  const saveStrategySettings = () => {
    const devPct = parseFloat(autostopDeviationPctInput)
    if (isNaN(devPct) || devPct < 0 || devPct > 20) {
      setStatus('Deviation must be 0–20%')
      return
    }
    localStorage.setItem(STRATEGY_INTERVAL_KEY, String(stratIntervalSecs))
    localStorage.setItem(AUTOSTOP_TRIGGER_TYPE_KEY, autostopTriggerType)
    localStorage.setItem(AUTOSTOP_DEVIATION_PCT_KEY, String(devPct))
    localStorage.setItem(BREAKEVEN_MODE_KEY, breakevenMode)
    localStorage.setItem(TARGET_PROFIT_BUFFER_TICKS_KEY, String(targetProfitBufferTicks))
    localStorage.setItem(AGGR_SL_ONLY_IN_PROFIT_KEY, String(aggrSlOnlyInProfit))
    onStrategySettingsChange(stratIntervalSecs, autostopTriggerType, devPct, breakevenMode, targetProfitBufferTicks, aggrSlOnlyInProfit)
    setStatus('Strategy settings saved')
    setTimeout(() => setStatus(null), 2000)
  }

  const handleChangePassword = async () => {
    setPwStatus(null)
    if (pwNew !== pwConfirm) {
      setPwStatus({ msg: 'New passwords do not match', ok: false })
      return
    }
    if (pwNew.length < 6) {
      setPwStatus({ msg: 'New password must be at least 6 characters', ok: false })
      return
    }
    setPwLoading(true)
    try {
      await api.changePassword(pwOld, pwNew)
      setPwOld(''); setPwNew(''); setPwConfirm('')
      setPwStatus({ msg: 'Password changed successfully', ok: true })
    } catch (e: unknown) {
      setPwStatus({ msg: e instanceof Error ? e.message : 'Failed to change password', ok: false })
    } finally {
      setPwLoading(false)
    }
  }

  const saveGuardRailSettings = async () => {
    const blockBars = parseInt(grBlockBarsInput)
    const cooldownBlockBars = parseInt(grCooldownBlockBarsInput)
    const cooldownLosses = parseInt(grCooldownLossesInput)
    const banCapitalPct = parseFloat(grBanCapitalInput)
    const banLossTradePct = parseFloat(grBanLossTradeInput)
    if (isNaN(blockBars) || blockBars < 1 || blockBars > 20) { setStatus('Block bars must be 1–20'); return }
    if (isNaN(cooldownBlockBars) || cooldownBlockBars < 1 || cooldownBlockBars > 20) { setStatus('Cooldown block bars must be 1–20'); return }
    if (isNaN(cooldownLosses) || cooldownLosses < 1 || cooldownLosses > 20) { setStatus('Cooldown losses must be 1–20'); return }
    if (isNaN(banCapitalPct) || banCapitalPct < 1 || banCapitalPct > 100) { setStatus('Capital % must be 1–100'); return }
    if (isNaN(banLossTradePct) || banLossTradePct < 1 || banLossTradePct > 100) { setStatus('Loss trade % must be 1–100'); return }
    try {
      await api.updateGuardRailSettings({
        guardrail_block_bars: blockBars,
        guardrail_cooldown_block_bars: cooldownBlockBars,
        guardrail_cooldown_losses: cooldownLosses,
        guardrail_ban_capital_pct: banCapitalPct,
        guardrail_ban_loss_trade_pct: banLossTradePct,
        guardrail_ban_enabled: grBanEnabled,
        guardrail_cooldown_enabled: grCooldownEnabled,
      })
      localStorage.setItem(GUARDRAIL_BLOCK_BARS_KEY, String(blockBars))
      localStorage.setItem(GUARDRAIL_COOLDOWN_BLOCK_BARS_KEY, String(cooldownBlockBars))
      localStorage.setItem(GUARDRAIL_COOLDOWN_LOSSES_KEY, String(cooldownLosses))
      localStorage.setItem(GUARDRAIL_BAN_CAPITAL_PCT_KEY, String(banCapitalPct))
      localStorage.setItem(GUARDRAIL_BAN_LOSS_TRADE_PCT_KEY, String(banLossTradePct))
      localStorage.setItem(GUARDRAIL_BAN_ENABLED_KEY, String(grBanEnabled))
      localStorage.setItem(GUARDRAIL_COOLDOWN_ENABLED_KEY, String(grCooldownEnabled))
      onGuardRailSettingsChange?.({ blockBars, cooldownBlockBars, cooldownLosses, banCapitalPct, banLossTradePct, banEnabled: grBanEnabled, cooldownEnabled: grCooldownEnabled })
      setStatus('GuardRail settings saved')
      setTimeout(() => setStatus(null), 2000)
    } catch {
      setStatus('Failed to save GuardRail settings')
    }
  }

  const saveBrokerage = () => {
    const val = parseFloat(brokerageInput)
    if (isNaN(val) || val < 0) {
      setStatus('Brokerage must be ≥ 0')
      return
    }
    localStorage.setItem(BROKERAGE_KEY, String(val))
    onBrokerageChange(val)
    setStatus(`Brokerage saved: ₹${val}`)
    setTimeout(() => setStatus(null), 2000)
  }

  const saveAdminTokens = async () => {
    const tokens: { icici_session?: string; kite_access?: string } = {}
    if (iciciInput.trim()) tokens.icici_session = iciciInput.trim()
    if (kiteInput.trim()) tokens.kite_access = kiteInput.trim()
    if (!tokens.icici_session && !tokens.kite_access) {
      setStatus('Enter at least one token')
      return
    }
    try {
      const result = await api.setAdminTokens(tokens)
      setIciciMasked(result.icici_session)
      setKiteMasked(result.kite_access)
      setIciciInput('')
      setKiteInput('')
      setStatus('Tokens saved')
      setTimeout(() => setStatus(null), 2000)
    } catch {
      setStatus('Failed to save tokens')
    }
  }

  const saveStreamSource = async (src: 'kite' | 'kotak') => {
    try {
      await api.setStreamSource(src)
      setStreamSource(src)
      setStatus(`Streaming source set to: ${src === 'kite' ? 'Kite' : 'Kotak Neo'}`)
      setTimeout(() => setStatus(null), 2500)
    } catch {
      setStatus('Failed to save streaming source')
    }
  }

  const loadWhitelist = async () => {
    setWhitelistLoading(true)
    try {
      const list = await api.getRealTradingWhitelist()
      setWhitelist(list)
    } catch { /* ignore */ } finally {
      setWhitelistLoading(false)
    }
  }

  const addToWhitelist = async () => {
    const email = whitelistEmailInput.trim().toLowerCase()
    if (!email || !email.includes('@')) { setStatus('Invalid email'); return }
    try {
      await api.addToRealTradingWhitelist(email)
      setWhitelistEmailInput('')
      await loadWhitelist()
      setStatus('Added to whitelist')
      setTimeout(() => setStatus(null), 2000)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed to add')
    }
  }

  const removeFromWhitelist = async (email: string) => {
    try {
      await api.removeFromRealTradingWhitelist(email)
      setWhitelist(w => w.filter(e => e.email !== email))
    } catch {
      setStatus('Failed to remove')
    }
  }

  const reset = async (amount?: number) => {
    try {
      await api.resetWallet(date, amount)
      setStatus(amount ? `Reset to ₹${amount.toLocaleString('en-IN')}` : 'Reset to ₹1,50,000')
      onWalletReset()
      setTimeout(() => setStatus(null), 2000)
    } catch {
      setStatus('Reset failed')
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        style={{
          background: 'none', border: 'none', color: '#8b949e',
          cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 4px',
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
            padding: 24, width: 440, display: 'flex', flexDirection: 'column', gap: 16,
            maxHeight: '90vh', boxSizing: 'border-box',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3' }}>Settings</span>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 16 }}
              >✕</button>
            </div>

            {/* Tab bar */}
            <div style={{
              display: 'flex',
              borderBottom: '1px solid #21262d',
              marginBottom: 4,
              marginTop: -8,
            }}>
              {(isAdmin
                ? ['general', 'strategies', 'guardrails', 'admin', 'profile'] as const
                : ['general', 'strategies', 'guardrails', 'profile'] as const
              ).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    background: 'none',
                    border: 'none',
                    borderBottom: activeTab === tab
                      ? '2px solid #1f6feb'
                      : '2px solid transparent',
                    color: activeTab === tab ? '#79c0ff' : '#8b949e',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    letterSpacing: 0,
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>

            {/* ── General tab content ── */}
            {activeTab === 'general' && <>

            {/* Trading Mode */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>TRADING MODE</div>
              <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
                {(['Quantity', 'FundsRatio'] as const).map(mode => {
                  const isActive = mode === 'FundsRatio' ? fundsRatioMode : !fundsRatioMode
                  return (
                    <button
                      key={mode}
                      onClick={toggleMode}
                      style={{
                        flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                        border: 'none', cursor: 'pointer',
                        background: isActive ? '#1f3a5f' : '#161b22',
                        color: isActive ? '#79c0ff' : '#484f58',
                        transition: 'background 0.15s',
                      }}
                    >
                      {mode}
                    </button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                {fundsRatioMode
                  ? 'Orders sized by % of session capital (L/M/H)'
                  : 'Orders sized by explicit quantity'}
              </div>
            </div>

            {/* FundsRatio % settings */}
            {fundsRatioMode && (
              <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                  FUNDS RATIO (% of session capital)
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  {(['l', 'm', 'h'] as const).map(key => (
                    <div key={key} style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3, textAlign: 'center' }}>
                        {key.toUpperCase()}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <input
                          type="number"
                          value={ratioInputs[key]}
                          onChange={e => setRatioInputs(r => ({ ...r, [key]: e.target.value }))}
                          min={1} max={100} step={1}
                          style={{
                            width: '100%', padding: '5px 6px', background: '#0d1117',
                            border: '1px solid #30363d', borderRadius: 6,
                            color: '#e6edf3', fontSize: 13, textAlign: 'center',
                          }}
                        />
                        <span style={{ fontSize: 11, color: '#484f58' }}>%</span>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={saveRatios}
                    style={{
                      marginTop: 16, padding: '5px 12px', background: '#1f6feb',
                      border: 'none', borderRadius: 6, color: '#fff',
                      cursor: 'pointer', fontSize: 12, alignSelf: 'flex-end',
                    }}
                  >
                    Save
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#484f58' }}>
                  Current: L={ratios.l}% · M={ratios.m}% · H={ratios.h}%
                </div>
              </div>
            )}

            {/* TARGET Order Deviation */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                TARGET ORDER DEVIATION
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={deviationInput}
                  onChange={e => setDeviationInput(e.target.value)}
                  min={0} max={10} step={0.1}
                  style={{
                    width: 80, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                <button
                  onClick={saveDeviation}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Auto-limit = trigger ± {deviationInput || '1'}% for TARGET orders
              </div>
            </div>

            {/* Brokerage */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                BROKERAGE
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#8b949e' }}>₹</span>
                <input
                  type="number"
                  value={brokerageInput}
                  onChange={e => setBrokerageInput(e.target.value)}
                  min={0} step={0.5}
                  style={{
                    width: 80, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>per order</span>
                <button
                  onClick={saveBrokerage}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Flat brokerage per order + exchange charges (STT, GST) computed per trade
              </div>
            </div>

            {/* P&L Display Mode */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>P&L DISPLAY MODE</div>
              <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d', width: 'fit-content' }}>
                {([{ label: '₹ Monetary', value: false }, { label: '% of Capital', value: true }] as const).map(opt => (
                  <button
                    key={String(opt.value)}
                    onClick={() => { if (pnlPctMode !== opt.value) togglePnlPctMode() }}
                    style={{
                      padding: '5px 16px', fontSize: 12, fontWeight: 600,
                      border: 'none', cursor: 'pointer',
                      background: pnlPctMode === opt.value ? '#1f3a5f' : '#161b22',
                      color: pnlPctMode === opt.value ? '#79c0ff' : '#484f58',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Pos P&L and Session P&L show % of session capital when enabled
              </div>
            </div>

            {/* Historical Days */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                HISTORICAL DAYS
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={historicalDays}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 1 && v <= 5) setHistoricalDays(v)
                  }}
                  min={1} max={5} step={1}
                  style={{
                    width: 70, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>days (1–5)</span>
                <button
                  onClick={() => {
                    localStorage.setItem(HISTORICAL_DAYS_KEY, String(historicalDays))
                    api.updateUserSettings({ historical_days: historicalDays }).catch(() => {})
                    onHistoricalDaysChange?.(historicalDays)
                    setStatus(`Historical days saved: ${historicalDays}`)
                    setTimeout(() => setStatus(null), 2000)
                  }}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Prior trading days of chart context loaded at session start
              </div>
            </div>

            {/* Wallet */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>WALLET</div>
              <div style={{ opacity: sessionActive ? 0.4 : 1, pointerEvents: sessionActive ? 'none' : 'auto' }}>
                <button
                  onClick={() => reset()}
                  style={{
                    width: '100%', padding: '8px 12px', background: '#21262d',
                    border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3',
                    cursor: 'pointer', fontSize: 13, marginBottom: 10,
                  }}
                >
                  Reset to ₹1,50,000
                </button>

                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    value={customAmount}
                    onChange={e => setCustomAmount(e.target.value)}
                    placeholder="Custom amount"
                    style={{
                      flex: 1, padding: '6px 10px', background: '#0d1117',
                      border: '1px solid #30363d', borderRadius: 6,
                      color: '#e6edf3', fontSize: 13,
                    }}
                  />
                  <button
                    onClick={() => {
                      const amt = parseFloat(customAmount)
                      if (amt > 0) reset(amt)
                    }}
                    disabled={!customAmount || parseFloat(customAmount) <= 0}
                    style={{
                      padding: '6px 12px', background: '#1f6feb',
                      border: 'none', borderRadius: 6, color: '#fff',
                      cursor: 'pointer', fontSize: 13,
                    }}
                  >
                    Set
                  </button>
                </div>
              </div>
              {sessionActive && (
                <div style={{ fontSize: 11, color: '#8b949e', marginTop: 8 }}>
                  Wallet cannot be changed during an active session
                </div>
              )}
            </div>

            {/* Broker connection (for real trading users) */}
            {(isRealTradingUser || isAdmin) && (
              <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>BROKER</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: '#e6edf3' }}>Kotak Neo</span>
                  {kotakAuthenticated === null ? (
                    <span style={{ fontSize: 12, color: '#484f58' }}>checking…</span>
                  ) : kotakAuthenticated ? (
                    <span style={{
                      fontSize: 12, color: '#3fb950',
                      background: 'rgba(63,185,80,0.1)', border: '1px solid rgba(63,185,80,0.3)',
                      borderRadius: 4, padding: '2px 8px',
                    }}>Connected</span>
                  ) : (
                    <>
                      <span style={{
                        fontSize: 12, color: '#f85149',
                        background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                        borderRadius: 4, padding: '2px 8px',
                      }}>Not connected</span>
                      <button
                        onClick={() => setShowKotakTOTP(true)}
                        style={{
                          padding: '4px 12px', background: '#d4a017', border: 'none',
                          borderRadius: 6, color: '#0d1117', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        }}
                      >Connect</button>
                    </>
                  )}
                </div>
              </div>
            )}

            {status && (
              <div style={{ fontSize: 12, color: '#3fb950' }}>{status}</div>
            )}

            </> /* end General tab */}

            {/* ── Strategies tab content ── */}
            {activeTab === 'strategies' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

                {/* Strategy Candle Interval */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>STRATEGY CANDLE INTERVAL</div>
                  <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d', width: 'fit-content' }}>
                    {([{ label: '3 min', value: 180 }, { label: '5 min', value: 300 }] as const).map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setStratIntervalSecs(opt.value)}
                        style={{
                          padding: '5px 16px', fontSize: 12, fontWeight: 600,
                          border: 'none', cursor: 'pointer',
                          background: stratIntervalSecs === opt.value ? '#1f3a5f' : '#161b22',
                          color: stratIntervalSecs === opt.value ? '#79c0ff' : '#484f58',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* AutoStop Trigger Type */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>AUTOSTOP TRIGGER</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {([
                      { value: 'bar', label: 'Bar High / Low' },
                      { value: 'deviation', label: '% from Close' },
                    ] as const).map(opt => (
                      <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="autostopTriggerStrat"
                          checked={autostopTriggerType === opt.value}
                          onChange={() => setAutostopTriggerType(opt.value)}
                          style={{ accentColor: '#79c0ff' }}
                        />
                        <span style={{ fontSize: 12, color: autostopTriggerType === opt.value ? '#e6edf3' : '#8b949e' }}>
                          {opt.label}
                        </span>
                      </label>
                    ))}
                  </div>
                  {autostopTriggerType === 'deviation' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>Deviation</span>
                      <input
                        type="number"
                        value={autostopDeviationPctInput}
                        onChange={e => setAutostopDeviationPctInput(e.target.value)}
                        min={0} max={20} step={0.1}
                        style={{
                          width: 70, padding: '4px 8px', background: '#0d1117',
                          border: '1px solid #30363d', borderRadius: 6,
                          color: '#e6edf3', fontSize: 13, textAlign: 'center',
                        }}
                      />
                      <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                    </div>
                  )}
                </div>

                {/* Breakeven Mode */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>BREAKEVEN MODE</div>
                  <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d', width: 'fit-content' }}>
                    {([
                      { label: 'Shift SL', value: 'shift_sl' as const },
                      { label: 'Limit Order', value: 'limit_order' as const },
                    ]).map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setBreakevenMode(opt.value)}
                        style={{
                          padding: '5px 16px', fontSize: 12, fontWeight: 600,
                          border: 'none', cursor: 'pointer',
                          background: breakevenMode === opt.value ? '#1f3a5f' : '#161b22',
                          color: breakevenMode === opt.value ? '#79c0ff' : '#484f58',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                    {breakevenMode === 'shift_sl'
                      ? 'Moves stoploss trigger to breakeven + buffer when price reaches threshold'
                      : 'Cancels stoploss and places immediate limit order at breakeven + buffer'}
                  </div>
                </div>

                {/* TargetProfit Buffer Ticks */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>TARGET PROFIT BUFFER TICKS</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="number"
                      value={targetProfitBufferTicks}
                      onChange={e => {
                        const v = parseInt(e.target.value)
                        if (!isNaN(v) && v >= 1 && v <= 5) setTargetProfitBufferTicks(v)
                      }}
                      min={1} max={5} step={1}
                      style={{
                        width: 70, padding: '5px 8px', background: '#0d1117',
                        border: '1px solid #30363d', borderRadius: 6,
                        color: '#e6edf3', fontSize: 13, textAlign: 'center',
                      }}
                    />
                    <span style={{ fontSize: 12, color: '#8b949e' }}>ticks (1–5)</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                    Extra ticks past target price before limit order triggers (each tick = ₹0.05)
                  </div>
                </div>

                {/* Aggressive SL: only in profit */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>AGGRESSIVE SL</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={aggrSlOnlyInProfit}
                      onChange={e => setAggrSlOnlyInProfit(e.target.checked)}
                      style={{ accentColor: '#79c0ff' }}
                    />
                    <span style={{ fontSize: 12, color: '#e6edf3' }}>Only update SL when in profit</span>
                  </label>
                  <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                    Skip SL shift when bar closes below avg entry price
                  </div>
                </div>

                {/* Save button for all strategy settings */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <button
                    onClick={saveStrategySettings}
                    style={{
                      padding: '5px 14px', background: '#1f6feb',
                      border: 'none', borderRadius: 6, color: '#fff',
                      cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    Save
                  </button>
                  {status && (
                    <span style={{ fontSize: 12, color: '#3fb950', marginLeft: 10 }}>{status}</span>
                  )}
                </div>

              </div>
            )}

            {/* ── GuardRails tab content ── */}
            {activeTab === 'guardrails' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ fontSize: 11, color: '#8b949e', background: '#0d1117', borderRadius: 6, padding: '8px 12px' }}>
                  Settings apply to new sessions. Use the BLOCK button during a session for immediate pause.
                </div>

                {/* BLOCK guardrail */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, marginBottom: 10 }}>BLOCK</div>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10 }}>
                    Manual trigger. Stops trading for <strong style={{ color: '#e6edf3' }}>n</strong> bars from the triggered bar.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>Block bars (n)</span>
                    <input
                      type="number" min={1} max={20}
                      value={grBlockBarsInput}
                      onChange={e => setGrBlockBarsInput(e.target.value)}
                      style={{ width: 60, background: '#0d1117', border: '1px solid #30363d', borderRadius: 4, color: '#e6edf3', padding: '4px 8px', fontSize: 12 }}
                    />
                  </div>
                </div>

                {/* COOLDOWN guardrail */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, flex: 1 }}>COOLDOWN</div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={grCooldownEnabled}
                        onChange={e => setGrCooldownEnabled(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 11, color: '#8b949e' }}>Enabled</span>
                    </label>
                  </div>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10 }}>
                    Triggers a trading pause after <strong style={{ color: '#e6edf3' }}>p</strong> consecutive loss trades for <strong style={{ color: '#e6edf3' }}>n</strong> bars.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>Consecutive losses (p)</span>
                      <input
                        type="number" min={1} max={20}
                        value={grCooldownLossesInput}
                        onChange={e => setGrCooldownLossesInput(e.target.value)}
                        style={{ width: 60, background: '#0d1117', border: '1px solid #30363d', borderRadius: 4, color: '#e6edf3', padding: '4px 8px', fontSize: 12 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>Cooldown block bars (n)</span>
                      <input
                        type="number" min={1} max={20}
                        value={grCooldownBlockBarsInput}
                        onChange={e => setGrCooldownBlockBarsInput(e.target.value)}
                        style={{ width: 60, background: '#0d1117', border: '1px solid #30363d', borderRadius: 4, color: '#e6edf3', padding: '4px 8px', fontSize: 12 }}
                      />
                    </div>
                  </div>
                </div>

                {/* BAN guardrail */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: '#f85149', fontWeight: 600, flex: 1 }}>BAN</div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={grBanEnabled}
                        onChange={e => setGrBanEnabled(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 11, color: '#8b949e' }}>Enabled</span>
                    </label>
                  </div>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10 }}>
                    Permanently stops trading when capital loss exceeds x% <em>or</em> y% of trades in the session are losses. No override.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>Capital loss limit (x%)</span>
                      <input
                        type="number" min={1} max={100} step={0.5}
                        value={grBanCapitalInput}
                        onChange={e => setGrBanCapitalInput(e.target.value)}
                        style={{ width: 70, background: '#0d1117', border: '1px solid #30363d', borderRadius: 4, color: '#e6edf3', padding: '4px 8px', fontSize: 12 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#8b949e', flex: 1 }}>Losing trades limit (y%)</span>
                      <input
                        type="number" min={1} max={100} step={1}
                        value={grBanLossTradeInput}
                        onChange={e => setGrBanLossTradeInput(e.target.value)}
                        style={{ width: 70, background: '#0d1117', border: '1px solid #30363d', borderRadius: 4, color: '#e6edf3', padding: '4px 8px', fontSize: 12 }}
                      />
                    </div>
                  </div>
                </div>

                {/* Save */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={saveGuardRailSettings}
                    style={{
                      background: '#21262d', border: '1px solid #30363d', color: '#e6edf3',
                      borderRadius: 6, padding: '7px 18px', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    Save GuardRail Settings
                  </button>
                  {status && (
                    <span style={{ fontSize: 12, color: status.startsWith('Failed') ? '#f85149' : '#3fb950' }}>{status}</span>
                  )}
                </div>
              </div>
            )}

            {/* ── Admin tab content (admin only) ── */}
            {activeTab === 'admin' && isAdmin && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Broker Tokens */}
                <div>
                  <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, marginBottom: 10 }}>
                    BROKER TOKENS
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>
                        ICICI Session Token
                        {iciciMasked && (
                          <span style={{ color: '#484f58', marginLeft: 6 }}>current: {iciciMasked}</span>
                        )}
                      </div>
                      <input
                        type="password"
                        value={iciciInput}
                        onChange={e => setIciciInput(e.target.value)}
                        placeholder="Paste new token…"
                        style={{
                          width: '100%', padding: '6px 8px', background: '#0d1117',
                          border: '1px solid #30363d', borderRadius: 6,
                          color: '#e6edf3', fontSize: 12, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>
                        Kite Access Token
                        {kiteMasked && (
                          <span style={{ color: '#484f58', marginLeft: 6 }}>current: {kiteMasked}</span>
                        )}
                      </div>
                      <input
                        type="password"
                        value={kiteInput}
                        onChange={e => setKiteInput(e.target.value)}
                        placeholder="Paste new token…"
                        style={{
                          width: '100%', padding: '6px 8px', background: '#0d1117',
                          border: '1px solid #30363d', borderRadius: 6,
                          color: '#e6edf3', fontSize: 12, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <button
                      onClick={saveAdminTokens}
                      style={{
                        padding: '6px 14px', background: '#b08800',
                        border: 'none', borderRadius: 6, color: '#fff',
                        cursor: 'pointer', fontSize: 12, alignSelf: 'flex-start',
                      }}
                    >
                      Save Tokens
                    </button>
                    <div style={{ fontSize: 11, color: '#484f58' }}>
                      Tokens rotate daily. DDB values override accesskeys.ini.
                    </div>
                  </div>
                </div>

                {/* Live Streaming Source */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, marginBottom: 10 }}>
                    LIVE STREAMING SOURCE
                  </div>
                  <div style={{
                    display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden',
                    border: '1px solid #30363d', width: 'fit-content',
                  }}>
                    {([
                      { key: 'kite' as const, label: 'Kite' },
                      { key: 'kotak' as const, label: 'Kotak Neo' },
                    ]).map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => saveStreamSource(key)}
                        style={{
                          padding: '6px 20px',
                          fontSize: 12,
                          fontWeight: 600,
                          border: 'none',
                          cursor: 'pointer',
                          background: streamSource === key ? '#1f3a5f' : '#161b22',
                          color: streamSource === key ? '#79c0ff' : '#484f58',
                          transition: 'background 0.15s',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                    Applies to all new paper and real sessions.
                    Kotak Neo requires TOTP login; falls back to Kite if not authenticated.
                  </div>

                  {/* Show Kotak connection status inline when Kotak is selected */}
                  {streamSource === 'kotak' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>Kotak status:</span>
                      {kotakAuthenticated === null ? (
                        <span style={{ fontSize: 12, color: '#484f58' }}>checking…</span>
                      ) : kotakAuthenticated ? (
                        <span style={{
                          fontSize: 12, color: '#3fb950',
                          background: 'rgba(63,185,80,0.1)', border: '1px solid rgba(63,185,80,0.3)',
                          borderRadius: 4, padding: '2px 8px',
                        }}>Connected</span>
                      ) : (
                        <>
                          <span style={{
                            fontSize: 12, color: '#f85149',
                            background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                            borderRadius: 4, padding: '2px 8px',
                          }}>Not connected</span>
                          <button
                            onClick={() => setShowKotakTOTP(true)}
                            style={{
                              padding: '3px 10px', background: '#d4a017', border: 'none',
                              borderRadius: 6, color: '#0d1117', cursor: 'pointer',
                              fontSize: 11, fontWeight: 600,
                            }}
                          >Connect</button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Real Trading Whitelist */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <button
                    onClick={() => { setWhitelistOpen(o => !o); if (!whitelistOpen) loadWhitelist() }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                    }}
                  >
                    <span style={{ fontSize: 12, color: '#f0883e', fontWeight: 600 }}>REAL TRADING ACCESS</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>{whitelistOpen ? '▲' : '▼'}</span>
                  </button>
                  {whitelistOpen && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {whitelistLoading ? (
                        <span style={{ fontSize: 11, color: '#484f58' }}>Loading…</span>
                      ) : whitelist.length === 0 ? (
                        <span style={{ fontSize: 11, color: '#484f58' }}>No whitelisted users</span>
                      ) : (
                        whitelist.map(entry => (
                          <div key={entry.email} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#e6edf3' }}>
                            <span>{entry.email}</span>
                            <button
                              onClick={() => removeFromWhitelist(entry.email)}
                              style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 12 }}
                            >✕</button>
                          </div>
                        ))
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <input
                          type="email"
                          value={whitelistEmailInput}
                          onChange={e => setWhitelistEmailInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && addToWhitelist()}
                          placeholder="user@example.com"
                          style={{
                            flex: 1, padding: '5px 8px', background: '#0d1117',
                            border: '1px solid #30363d', borderRadius: 6,
                            color: '#e6edf3', fontSize: 12,
                          }}
                        />
                        <button
                          onClick={addToWhitelist}
                          style={{
                            padding: '5px 10px', background: '#1f6feb', border: 'none',
                            borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12,
                          }}
                        >Add</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Broker connection (connect Kotak for real trading / admin) */}
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, marginBottom: 10 }}>
                    BROKER CONNECTION
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, color: '#e6edf3' }}>Kotak Neo</span>
                    {kotakAuthenticated === null ? (
                      <span style={{ fontSize: 12, color: '#484f58' }}>checking…</span>
                    ) : kotakAuthenticated ? (
                      <span style={{
                        fontSize: 12, color: '#3fb950',
                        background: 'rgba(63,185,80,0.1)', border: '1px solid rgba(63,185,80,0.3)',
                        borderRadius: 4, padding: '2px 8px',
                      }}>Connected</span>
                    ) : (
                      <>
                        <span style={{
                          fontSize: 12, color: '#f85149',
                          background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                          borderRadius: 4, padding: '2px 8px',
                        }}>Not connected</span>
                        <button
                          onClick={() => setShowKotakTOTP(true)}
                          style={{
                            padding: '4px 12px', background: '#d4a017', border: 'none',
                            borderRadius: 6, color: '#0d1117', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          }}
                        >Connect</button>
                      </>
                    )}
                  </div>
                </div>

                {status && (
                  <div style={{ fontSize: 12, color: '#3fb950' }}>{status}</div>
                )}
              </div>
            )}

            {/* ── Profile tab content ── */}
            {activeTab === 'profile' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                  <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>CHANGE PASSWORD</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Current password</div>
                      <input
                        type="password"
                        value={pwOld}
                        onChange={e => setPwOld(e.target.value)}
                        placeholder="Current password"
                        style={{
                          width: '100%', padding: '6px 10px', background: '#0d1117',
                          border: '1px solid #30363d', borderRadius: 6,
                          color: '#e6edf3', fontSize: 13, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>New password</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type={pwVisible ? 'text' : 'password'}
                          value={pwNew}
                          onChange={e => setPwNew(e.target.value)}
                          placeholder="New password"
                          style={{
                            flex: 1, padding: '6px 10px', background: '#0d1117',
                            border: '1px solid #30363d', borderRadius: 6,
                            color: '#e6edf3', fontSize: 13,
                          }}
                        />
                        <button
                          onClick={() => setPwVisible(v => !v)}
                          style={{
                            padding: '6px 10px', background: '#21262d', border: '1px solid #30363d',
                            borderRadius: 6, color: '#8b949e', cursor: 'pointer', fontSize: 12,
                            flexShrink: 0,
                          }}
                        >{pwVisible ? 'Hide' : 'Show'}</button>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Confirm new password</div>
                      <input
                        type="password"
                        value={pwConfirm}
                        onChange={e => setPwConfirm(e.target.value)}
                        placeholder="Confirm new password"
                        style={{
                          width: '100%', padding: '6px 10px', background: '#0d1117',
                          border: '1px solid #30363d', borderRadius: 6,
                          color: '#e6edf3', fontSize: 13, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <button
                      onClick={handleChangePassword}
                      disabled={pwLoading || !pwOld || !pwNew || !pwConfirm}
                      style={{
                        padding: '6px 14px', background: pwLoading || !pwOld || !pwNew || !pwConfirm ? '#21262d' : '#1f6feb',
                        border: 'none', borderRadius: 6,
                        color: pwLoading || !pwOld || !pwNew || !pwConfirm ? '#484f58' : '#fff',
                        cursor: pwLoading || !pwOld || !pwNew || !pwConfirm ? 'not-allowed' : 'pointer',
                        fontSize: 12, fontWeight: 600, alignSelf: 'flex-start',
                      }}
                    >{pwLoading ? 'Changing…' : 'Change Password'}</button>
                    {pwStatus && (
                      <div style={{ fontSize: 12, color: pwStatus.ok ? '#3fb950' : '#f85149' }}>
                        {pwStatus.msg}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            </div>{/* end scrollable tab content */}
          </div>
        </div>
      )}
      {showKotakTOTP && (
        <KotakTOTPModal
          onSuccess={() => {
            setShowKotakTOTP(false)
            setKotakAuthenticated(true)
          }}
          onCancel={() => setShowKotakTOTP(false)}
        />
      )}
    </>
  )
}
