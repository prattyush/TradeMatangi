/**
 * The query of `option-metadata`. A session being set up (Replay, Stepwise, Paper, Real) asks with `purpose=trading`, which follows the
 * user's "Next expiry on expiry days" setting (the next expiry on an expiry day); Browse and the tiles leave it out and get the nearest expiry.
 */
export const metadataQuery = (symbol: string, asOfDate: string, forTrading: boolean): Record<string, string> => ({
  symbol,
  as_of_date: asOfDate,
  ...(forTrading ? { purpose: 'trading' } : {})
})
