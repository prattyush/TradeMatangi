import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Props } from "../components/Chart";
import api, { type OHLCCandle } from "../services/api";
import { rememberChartData } from "../services/chartDataCache";
import { RecentLiveTicks } from "../services/tradingChartState";
import { checkedChartCandles, mergeKLineHistory, mergeKLineTick } from "../services/klineCandles";

export function useKLineCandles(
  props: Props,
  retained: MutableRefObject<Map<number, OHLCCandle>>,
) {
  const [rows, setRows] = useState<OHLCCandle[]>(() =>
    [...retained.current.values()].sort((a, b) => a.time - b.time),
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [rewind, setRewind] = useState(0);
  const cursorRef = useRef<number | null>(null);
  const refreshRef = useRef(props.reloadKey);
  const ticks = useRef(new RecentLiveTicks());
  const latest = useRef(props);
  latest.current = props;
  const reload = props.reloadKey ?? 0;
  useEffect(() => {
    if (refreshRef.current !== props.reloadKey) {
      refreshRef.current = props.reloadKey;
      ticks.current.clear();
      retained.current.clear();
    }
  }, [props.reloadKey, retained]);
  useEffect(() => {
    const now = props.currentSimTime;
    if (now != null && cursorRef.current != null && now < cursorRef.current) {
      const cutoff = Math.floor(now / (interval * 60)) * interval * 60;
      ticks.current.clear();
      retained.current = new Map(
        [...retained.current].filter(([time]) => time < cutoff),
      );
      setRows([...retained.current.values()]);
      setRewind((v) => v + 1);
    }
    cursorRef.current = now ?? null;
  }, [props.currentSimTime]);
  const interval = props.intervalMinutes;
  useEffect(() => {
    if (props.externalCandles !== undefined) return;
    let disposed = false;
    const p = latest.current;
    const mode = p.historyMode ?? "replay";
    setLoading(true);
    setMessage("");
    void (async () => {
      try {
        const liveTs = p.currentSimTime ?? p.latestTick?.time;
        const sameDay =
          liveTs != null &&
          new Date(liveTs * 1000).toISOString().slice(0, 10) === p.tradingDate;
        const end = sameDay
          ? new Date(liveTs! * 1000).toISOString().slice(11, 19)
          : p.startTime;
        const key = JSON.stringify([
          mode,
          p.symbol,
          p.tradingDate,
          interval,
          p.paneType,
          p.strike,
          p.expiry,
          p.right,
          p.historicalDays,
          end,
          reload,
          rewind,
        ]);
        let history: OHLCCandle[];
        if (p.paneType === "options") {
          if (!p.strike || !p.expiry || !p.right || !p.startTime) {
            setRows([]);
            return;
          }
          history = await rememberChartData(`kline:${key}`, () =>
            api
              .getOptionsHistorical(
                p.symbol,
                p.tradingDate,
                p.strike!,
                p.expiry!,
                p.right!,
                interval,
                p.historicalDays,
                reload > 0,
                mode,
                end ?? undefined,
              )
              .then((r) => r.candles),
          );
        } else {
          const [prior, session] = await Promise.all([
            rememberChartData(`kline:hist:${key}`, () =>
              api
                .getHistorical(
                  p.symbol,
                  p.tradingDate,
                  interval,
                  p.historicalDays,
                  mode,
                )
                .then((r) => r.candles),
            ),
            end
              ? rememberChartData(`kline:pre:${key}`, () =>
                  api.getPreSession(
                    p.symbol,
                    p.tradingDate,
                    end,
                    interval,
                    reload > 0,
                    mode,
                  ),
                )
              : Promise.resolve([]),
          ]);
          history = [...checkedChartCandles(prior), ...checkedChartCandles(session)];
        }
        history = checkedChartCandles(history);
        if (disposed) return;
        const now =
          latest.current.currentSimTime ?? latest.current.latestTick?.time;
        const start = p.startTime
          ? Date.parse(
              `${p.tradingDate}T${p.startTime.length === 5 ? p.startTime + ":00" : p.startTime}Z`,
            ) / 1000
          : undefined;
        const cursor = now ?? p.liveFromTs ?? start;
        const cutoff =
          cursor === undefined
            ? undefined
            : Math.floor(cursor / (interval * 60)) * interval * 60;
        // Both pre-session and cutoff-aware option history aggregate only raw
        // seconds before the requested clock. Preserve that safe partial tail.
        const boundedPartialTime = end
          ? Math.floor(
              Date.parse(
                `${p.tradingDate}T${end.length === 5 ? end + ":00" : end}Z`,
              ) /
                1000 /
                (interval * 60),
            ) *
            interval *
            60
          : undefined;
        let next = mergeKLineHistory(
          history,
          [...retained.current.values()],
          cutoff,
          boundedPartialTime,
        );
        for (const tick of ticks.current.values())
          next = mergeKLineTick(next, tick, interval);
        setRows(next);
      } catch (error) {
        if (!disposed) setMessage(String(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    props.symbol,
    props.tradingDate,
    props.paneType,
    props.strike,
    props.expiry,
    props.right,
    props.startTime,
    props.historyMode,
    props.historicalDays,
    props.liveFromTs,
    props.externalCandles !== undefined,
    interval,
    reload,
    rewind,
  ]);
  useEffect(() => {
    const tick = props.latestTick;
    if (
      !tick ||
      props.externalCandles !== undefined ||
      !ticks.current.append(tick)
    )
      return;
    props.onPriceUpdate?.(tick.close);
    setRows((current) => mergeKLineTick(current, tick, interval));
  }, [props.latestTick, interval]);
  useEffect(() => {
    const bar = props.completedBar;
    if (
      !bar ||
      props.externalCandles !== undefined ||
      bar.time % (interval * 60) !== 0
    )
      return;
    setRows((current) =>
      mergeKLineHistory(
        [...current.filter((c) => c.time !== bar.time), bar],
        [],
      ),
    );
  }, [props.completedBar, interval]);
  const actual = props.externalCandles ?? rows;
  const publish = useRef(props.onCandlesChange);
  publish.current = props.onCandlesChange;
  useEffect(() => {
    retained.current = new Map(actual.map((c) => [c.time, c]));
    const cursor =
      latest.current.currentSimTime ?? latest.current.latestTick?.time;
    const cutoff =
      cursor == null
        ? Infinity
        : Math.floor(cursor / (interval * 60)) * interval * 60;
    publish.current?.(actual.filter((c) => c.time < cutoff));
  }, [actual, interval, retained]);
  return {
    rows: actual,
    loading: props.externalLoading ?? loading,
    message: props.externalMessage ?? message,
  };
}
