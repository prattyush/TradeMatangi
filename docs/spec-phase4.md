#### Phase-IV PaperTrading
This phase will support PaperTrading and realtime streaming of data.

##### PAPERTRADING
1. To support papertrading, only extra that needs to be supported is to fetch current streaming data from a broker. The data will be directly streamed to the UI. Backend can decide to store it if suitable.
2. Option to choose whether the current session would be papertrading session or simulated trading session.
3. Use the same wallet for both simulated and paper trading. And the wallet should reflect the P&L.
4. While persisting trades, include an option to specify that these trades where taken in paper trading case. When doing analysis of trades, simulated and paper trading can be analyzed separately and both are very different situations and require different mental states.

