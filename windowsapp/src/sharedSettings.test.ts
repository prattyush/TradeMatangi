import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from '../../frontend/src/services/api'
import {
  cacheSharedSettings,
  legacyBrowserSettings
} from '../../frontend/src/services/sharedSettings'
import { accountSettingsRequest } from './desktopSettingsRequest'
import {
  sectionSettings,
  sharedSettingsSections,
  strategySettingsPayload
} from './settingsFields'

let values: Map<string, string>
const response = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body
})
beforeEach(() => {
  values = new Map([['auth_user', JSON.stringify({ userId: 'shared-user' })]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(
        public type: string,
        public options: unknown
      ) {}
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('shared account preferences', () => {
  it('imports real legacy values and leaves absent/invalid fields out', () => {
    values.set('strategyIntervalSecs', '300')
    values.set('brokeragePerOrder', '2.5')
    values.set('autoStartEventSnapshots', 'false')
    values.set('targetProfitBufferTicks', 'invalid')
    values.set('autostopDeviationPct', '21')
    values.set('breakevenMode', 'invalid')
    expect(legacyBrowserSettings(localStorage)).toEqual({
      strategy_interval_secs: 300,
      brokerage_per_order: 2.5,
      auto_start_event_snapshots: false
    })
  })
  it('supports old labeling preference without importing fabricated defaults', () => {
    expect(legacyBrowserSettings(localStorage)).toEqual({})
    values.set('stepwiseLabelingPopupEnabled', 'false')
    expect(
      legacyBrowserSettings(localStorage).trade_labeling_mode_by_type
    ).toEqual({
      stepwise: 'off',
      sim: 'button',
      paper: 'button',
      real: 'button'
    })
    values.set(
      'tradeLabelingModeByType',
      JSON.stringify({
        stepwise: 'popup',
        sim: 'off',
        paper: 'button',
        real: 'button'
      })
    )
    expect(
      legacyBrowserSettings(localStorage).trade_labeling_mode_by_type?.stepwise
    ).toBe('popup')
  })
  it('keeps legacy preferences intact until the initial settings import', async () => {
    values.set('strategyIntervalSecs', '300')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ historical_days: 2, strategy_interval_secs: 180 })
        )
    )
    await api.getUserSettings()
    expect(values.get('strategyIntervalSecs')).toBe('300')
  })
  it('hydrates backend-first values after import and fetches fresh on every open', async () => {
    values.set('strategyIntervalSecs', '120')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ historical_days: 2, strategy_interval_secs: 300 })
      )
      .mockResolvedValueOnce(
        response({ historical_days: 2, strategy_interval_secs: 300 })
      )
      .mockResolvedValueOnce(
        response({ historical_days: 2, strategy_interval_secs: 180 })
      )
      .mockResolvedValueOnce(
        response({ historical_days: 2, strategy_interval_secs: 180 })
      )
    vi.stubGlobal('fetch', fetch)
    expect((await api.getUserSettings(true)).strategy_interval_secs).toBe(300)
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      strategy_interval_secs: 120
    })
    expect(fetch.mock.calls[1][0]).toContain('/settings/browser-migration')
    expect(values.get('strategyIntervalSecs')).toBe('300')
    expect((await api.getUserSettings(true)).strategy_interval_secs).toBe(180)
    expect(values.get('strategyIntervalSecs')).toBe('180')
  })
  it('failed migration keeps browser values and reports failure', async () => {
    values.set('strategyIntervalSecs', '300')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ historical_days: 2, strategy_interval_secs: 180 })
        )
        .mockResolvedValueOnce({ ok: false, status: 503 })
    )
    await expect(api.getUserSettings(true)).rejects.toThrow('Could not import')
    expect(values.get('strategyIntervalSecs')).toBe('300')
  })
  it('updates the compatibility cache only after successful saves', async () => {
    values.set('brokeragePerOrder', '3')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Unavailable' })
      })
      .mockResolvedValueOnce(
        response({ historical_days: 2, brokerage_per_order: 5 })
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      api.updateUserSettings({ brokerage_per_order: 5 })
    ).rejects.toThrow('Unavailable')
    expect(values.get('brokeragePerOrder')).toBe('3')
    await api.updateUserSettings({ brokerage_per_order: 5 })
    expect(values.get('brokeragePerOrder')).toBe('5')
  })
  it('caches labels and their legacy stepwise switch consistently', () => {
    cacheSharedSettings(
      {
        historical_days: 2,
        trade_labeling_mode_by_type: {
          stepwise: 'off',
          sim: 'button',
          paper: 'popup',
          real: 'off'
        }
      },
      localStorage
    )
    expect(values.get('stepwiseLabelingPopupEnabled')).toBe('false')
    expect(JSON.parse(values.get('tradeLabelingModeByType')!).paper).toBe(
      'popup'
    )
  })
  it('saves only the selected section without desktop-only or unrelated fields', () => {
    expect(
      sectionSettings('Strategies', {
        strategy_interval_secs: 300,
        autostop_trigger_type: 'bar',
        autostop_deviation_pct: 1,
        breakeven_mode: 'limit_order',
        target_profit_buffer_ticks: 5,
        aggr_sl_only_in_profit: true,
        desktop_hide_chart_labels: true,
        brokerage_per_order: 9
      })
    ).toEqual({
      strategy_interval_secs: 300,
      autostop_trigger_type: 'bar',
      autostop_deviation_pct: 1,
      breakeven_mode: 'limit_order',
      target_profit_buffer_ticks: 5,
      aggr_sl_only_in_profit: true
    })
    expect(
      sharedSettingsSections.Trading.find(
        (field) => field.key === 'funds_ratio_l_pct'
      )?.scale
    ).toBe(100)
    expect(
      sharedSettingsSections.Trading.find(
        (field) => field.key === 'risk_ratio_l_pct'
      )?.scale
    ).toBe(1)
  })
})

describe('desktop account actions', () => {
  it('uses desktop bearer auth and handles empty successful responses', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn().mockRejectedValue(new Error('empty'))
    })
    vi.stubGlobal('fetch', fetch)
    expect(
      await accountSettingsRequest('http://localhost:8700/', 'token')(
        'change-password',
        'POST',
        { old_password: 'old', new_password: 'new' }
      )
    ).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8700/api/desktop/v1/settings/change-password',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json'
        }
      })
    )
  })
  it('surfaces authorization and validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Admin access required'
      })
    )
    await expect(
      accountSettingsRequest('http://localhost:8700', 'token')(
        'admin/tokens',
        'GET'
      )
    ).rejects.toThrow('Admin access required')
  })
  it('delegates native actions and rejects paths outside the settings API', async () => {
    const native = vi.fn().mockResolvedValue({ source: 'kite' })
    const request = accountSettingsRequest(
      'http://localhost:8700',
      'token',
      native
    )
    await request('admin/stream-source', 'PUT', { source: 'kite' })
    expect(native).toHaveBeenCalledWith('admin/stream-source', 'PUT', {
      source: 'kite'
    })
    await expect(request('../admin/tokens', 'GET')).rejects.toThrow(
      'Invalid settings path'
    )
    expect(native).toHaveBeenCalledTimes(1)
  })
})

it('uses saved strategy preferences without converting AutoStop percentage points', () => {
  expect(
    strategySettingsPayload({
      autostop_trigger_type: 'deviation',
      autostop_deviation_pct: 2.5,
      breakeven_mode: 'limit_order',
      target_profit_buffer_ticks: 5,
      aggr_sl_only_in_profit: true,
      target_deviation_pct: 0.02
    })
  ).toEqual({
    autostop_trigger_type: 'deviation',
    autostop_deviation_pct: 2.5,
    breakeven_mode: 'limit_order',
    target_profit_buffer_ticks: 5,
    only_in_profit: true
  })
})
