#### Phase-X Enhancements

##### Minor UI Updates
1. Make Combined P&L a collapsable view. It may not be required for everybody as it only makes sense for some options strategies. Having it collapsed gives more space in UI.
2. Can the target and limit order placed under 1 tab. This is because lower section a new guardrail is introduced, to make up space for it. However, feel free to design UI as suited. This is just a sugggestion.

##### GuardRails
GuardRails are programs which when triggered will run for limited time or till the end of the session. For long running guardrails they will keep checking conditions, if they are met then its gets activated. The end work for all guardrails when active is to stop trading. 
1. BLOCK -> This guardrail when triggered will stop trading for n number of bars. Let's say for a 3 bar interval trades, it is triggered on 09:20. Then it would stop trading including the current bar + n more bars. Lets say n is 3 which is 9 minutes. So, then is not possible till 09:29:59. Use of this guardrail for users to use when they feel their emotional response is too much to handle and need a quick break. Include the value of n in the settings. This guardrail once triggered or started cannot be stopped until n bars when it automatically stops itself.
2. COOLDOWN -> This guardrail is a long running guardrail and once started will run till session expires. This guardrail is triggered when the user takes p consequetive loss trades and then it would trigger a COOLDOWN time. The cooldown time is similar to BLOCK Guardrail basically it blocks user from taking any trades for n bars. The same BLOCk Guardrail does. The configuration of p and n in this guardrail should be part of settings.
3. BAN -> This guardrail should be triggered for a session or not is part of settings. If the settings says yes, then it would trigger for all sessions. This guardrail checks if a trader has suffered > x% of capital in losses, or % trades taken in a session are in loss. When the trigger hits, it stop trading completely. The % of capital loss or % of losing trades are part of settings. There is no stop option for this guardrail. 
4. Guardrail settings -> Include another tab in settings for GuardRail settings.
5. For all guardrail when are active, if user tries to trade, a popup with reason is shown on why his trading is stopped.


##### Bugs
1. Check if Target Profit when used with %, does it calculate that percentage for the current trade against the session's starting capital. Also, the Pos P&L shows high percentage when trade is open, when it is closed everything is right. Can you check if the Position P&L Percentage calculation is also right and used teh % of capital at the session start. Capital here means wallet value.

##### More
1. More bugs or features will be added in discussion.