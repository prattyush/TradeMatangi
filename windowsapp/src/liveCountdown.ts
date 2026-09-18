export const secondsUntilCandleClose = (nowSeconds: number, intervalMinutes: number) => {
  const intervalSeconds = intervalMinutes * 60
  return intervalSeconds - (Math.floor(nowSeconds) % intervalSeconds)
}

export const formatCandleCloseCountdown = (nowSeconds: number, intervalMinutes: number) => {
  const remaining = secondsUntilCandleClose(nowSeconds, intervalMinutes)
  return `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`
}
