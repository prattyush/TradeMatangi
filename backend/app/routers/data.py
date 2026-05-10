from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import HistoricalDataResponse, OHLCCandle
from app.services.data_loader import load_dataframe, resample_to_candles, candles_to_records
from app.config import PRIOR_DATES, DEFAULT_SYMBOL

router = APIRouter(prefix="/api/data", tags=["data"])


@router.get("/historical", response_model=HistoricalDataResponse)
async def get_historical(symbol: str = Query(default=DEFAULT_SYMBOL)):
    all_candles: list[OHLCCandle] = []
    for date in PRIOR_DATES:
        try:
            df = load_dataframe(symbol, date)
            candles = resample_to_candles(df)
            records = candles_to_records(candles)
            all_candles.extend(OHLCCandle(**r) for r in records)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"Data not found for {symbol} on {date}")
    return HistoricalDataResponse(symbol=symbol, dates=PRIOR_DATES, candles=all_candles)
