/**
 * The Risk : Reward drawing (pure: no klinecharts import, so it can be unit tested). Two clicks, the **stop first, then the entry**
 * (the way a trade is entered: with its stop in mind), give the levels where the trade is 1 : 1, 1.5 : 1 and 2 : 1: the entry plus 1,
 * 1.5 and 2 times the distance from the stop to the entry, upward when the stop is below the entry (a buy) and downward otherwise.
 * The Lightweight charts draw the same levels, so a saved drawing looks alike on both.
 */
export const RISK_REWARD_OVERLAY = "tmRiskReward";

export type RiskRewardKey = "stop" | "entry" | "1R" | "1.5R" | "2R";
export interface RiskRewardLevel {
  key: RiskRewardKey;
  label: string;
  price: number;
  color: string;
}

export const RISK_REWARD_COLORS: Record<RiskRewardKey, string> = {
  stop: "rgb(248,81,73)",
  entry: "rgb(230,237,243)",
  "1R": "rgb(63,185,80)",
  "1.5R": "rgb(88,166,255)",
  "2R": "rgb(188,140,255)",
};
export const RISK_REWARD_MULTIPLES: ReadonlyArray<{ key: Exclude<RiskRewardKey, "stop" | "entry">; label: string; multiple: number }> = [
  { key: "1R", label: "1 : 1", multiple: 1 },
  { key: "1.5R", label: "1.5 : 1", multiple: 1.5 },
  { key: "2R", label: "2 : 1", multiple: 2 },
];

/** The five levels, stop first. `isBuy` is true when the stop is below the entry. */
export function riskRewardLevels(stop: number, entry: number): { isBuy: boolean; risk: number; levels: RiskRewardLevel[] } {
  const isBuy = stop < entry;
  const risk = Math.abs(entry - stop);
  const sign = isBuy ? 1 : -1;
  return {
    isBuy,
    risk,
    levels: [
      { key: "stop", label: "Stop", price: stop, color: RISK_REWARD_COLORS.stop },
      { key: "entry", label: "Entry", price: entry, color: RISK_REWARD_COLORS.entry },
      ...RISK_REWARD_MULTIPLES.map(({ key, label, multiple }) => ({
        key,
        label,
        price: entry + sign * risk * multiple,
        color: RISK_REWARD_COLORS[key],
      })),
    ],
  };
}
