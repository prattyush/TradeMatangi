#### AI Helper
This phase includes support of LLM to enchance trading experience. It would be a chat based LLM which would provide users ability to give commands like:-
1. Custom Entry -> Let's say in a strong trend. The user says :- "When the first bar comes whose low is below the low of the previous bar, Buy L Ratio Quantity At Market Price."
2. Custom Exit -> Again when the user already has a position in a strong trend, the user says :- "When the first pullback bar (first bar of opposite color from the current trend) comes in this trend, start a TakeProfit Strategy at the high (BUY posiiton)/low (SELL Position) of the bar before the pullback bar"
3. Partial Exit -> "When total Profit % reaches 6%, exit 50% position, and exit the rest 50% when the profit percentage reaches 6% of the remaining quantity."
4. Trade Analysis -> The llm would analyze the traddes taken by user and come up with suggestions on how to improve, also pointing bad patterns. Like :- "Always entering at bad price w.r.t a bar open price. Losing % of trades increases in 2nd half of trading, after initial 2 hours etc. Also, averaging entries are causing more losses. Profits % are smaller compared to loss %." etc etc.


For Planning:- Please think yourself a principal engineer and plan for future complicated cases as well. We will also include Guardrails like (NeMo) and observability either through Galellileo AI or LangFuse to monitor LLM usaage. Also, think about whether the architecture should be that a new server is created which talks to the current present backend, gets ticks values through another SSE and gets chat prompts entered from UI. It interacts with backend for all trade actions. The trade actions can also be reflected on UI through SSE Events. Another architecture option is that the LLM server is called internally from backend server, The UI doesn't call the LLM Server directly. Third architeccture is no need of another server, the backend can be expanded to cover LLLM Use-cases. 

Feel free to write the architecture in the docs/architecture doc if required. Have created a new folder called aihelper if a new server is required for LLMs


##### EntryFeatures
1. Users can define entry criteria for taking trades. To keep it simple for now, entry criteria should have following information, it can be passed as form of chat. 
 a) Quantity or Ratio (Ratio of Wallet value at start of session, limited to values L, M, H). b) Order Type :- Order type can be market, limit or target. In case of all order types, the backend will always treat them as as they do for trades done from UI. c) Entry Symbol:- For Equity it is same one as shown. For Options. Whetehr it is PE or CE should be mentioned. d) Trigger Criteria:- For Simplicity now, the user needs to say exactly based on bars behavior, no inputs like double top or double bottom, it should be explicit like:- if CE bars low crosses low of previous bar, and the bar is a bear bar, then place a target order at the mid value of the bar (open + close)/2 with quantity of ratio of L.
 2. Validate if the entry criteria is valid based on above points. If not ask user to be more explicit. You can give the above example or below instruction.
 ```
For adding command, please mention
1) Order Type (Limit, Market, Target)
2) Quantity or Ratio of Wallet recorded at start of the session [Ratio values are L, M or H]
3) Symbol in case of Options - CE or PE.
4) Entry Criteria:- Definiing entry criteria based on bars parameters i.e ( low, high, close, open, bear, bull)

Examples:- 
1) "If CE bars low crosses low of previous bar, and the bar is a bear bar, then place a target order at the mid value of the bar (open + close)/2 with quantity of ratio of L."
2) "If CE bars close cross 89.5, then place a target order at close price + 0.5 with trade quantity of ratio L"

 ```


 ##### ExitFeatures
 1. Users can define exit criteria for exiting trades. To keep it simple for now, the same bar criteria would be used i.e. ( low, high, close, open, bear, bull) and comparison with previous bars. For now it would exit the entire position, we will complicate it later. The required parameters are:- a) Exit Criteria based on Bars. b) Symbol information, c) Action:- Can be update stoploss or exit position or start take profit strategy with exit price which can be calculated based on bars params. 
 2. For stoploss update, if possible it can find if a stoploss is already present, if yes update that, or create one if not present.
 3. For exit position, it can do something similar to what take profit strategy does, or internally, the system can trigger a take profit strategy such that the position is immediately exited like putting take profit at 10% below current market price, or percentage decrement against the last close price.
 4. All exit criterias for now will be evaluated at bar close as was with entry criterias.
 5. Exit features will be active till it is condition fulfils, session is stopped, or users cancels it or at bar close it finds no position is open to monitor.
 6. Validate if the exit criteria is valid based on above points. If not ask user to be more explicit. You can give the above example or below instruction.
 ```
For adding command, please mention
1) Symbol in case of Options - CE or PE. 
3) Action:- Can be update stoploss to some static price or calculated price or starting the take profit strategy at a calculated price or static price, or exit immediately.
4) Exit Criteria:- Definiing exit criteria based on bars parameters i.e ( low, high, close, open, bear, bull)

Examples:- 
1) "Exit the position in CE, when the first bar with bear body is encountered."
2) "Start a Take Profit Strategy in CE, at the open price of the bar which is the first bear body bar."
3) "Exit position in CE when a bull bar body comes whose total height (close-open) is greater than 30% of height when compared to last 5 bars ir-respective of bull or bear body."

 ```
7. Make sure other good practices are followed like strike price change etc.
8. One critical update, when the AIHelper command is triggered, the hook will be applied to backend to send last 15 bars on bar close. For the first bar close after aihelper command is started the backend sends only 1 bar. Can it be changed to send last 15 (max) bars of today. If the comamnd is fired at 09:30 we will have only 5 bars which is fine. This will apply for all hooks be it exit or entry criteria.
9. Checks can be added to see if a position is already open in the provided symbol for accepting the command.