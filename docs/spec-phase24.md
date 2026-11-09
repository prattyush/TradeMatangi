### Desktop Tools

This contains tools which will be created to support trading.

#### Trading Video Maker

##### Context
So, when we click on recording in the website, it records the screen and then it saved it as webm file. First, the webm files don't have a way to skip or go forward, I mean it doesn't have a bar that I can drag to fast forward or reverses. The 2nd problem is trading much of the time is idle, and so most of the time the video is present is of targing chart moving ohlc data, so, while reviewing through video, I have to wait to see where the trades were taken place.

##### Requirement
The requirement is to have a tools section in desktop for now, which will have this trading video editor tool. In summary it should produce a video output, which will be limited only to the trading windows, that is the time between actual entries and exits were done, and probably with a lag and lead time like 1 bar. For example we recorded video from 09:20 to 10:10 and took 3 trades, one at 09:30 to 09:38, then another at 09:39 to 09:45 and last one at 09:57 to 10:02, then at the video should have only the timings, 09:27 to 09:48 and then from 09:54 to 10:06, when candle interval chooses is 3 mins, then before each trade, previouos bar should be in video, so starts at 09:27, and so, as 2 trades were taken simulatenously closeby so due to lead and lag overlap, we have continuous video.

Also. it should be able to do following things:-
1. Firstly, it will be only in desktop as it needs to use the RAM and processor of the host computer to do the computation and work, website can't support this, doing it in server will cause
bigger issues with sharing resources for other tasks.
2. It would take input the webm file and then convert it into a format where we can go ahead and back in the video, is it possible to convert to mp4.
3. Then it can take the webm file of mp4 file and the type of trading this video is for, which date, and if this date has multiple sessions, it will ask for which session. For all is also a valid value.
4. For paper trading and real trading videos, it would take a sync second time, I mean to notify when is videos 01:00 (1 minute) time correspond to real world time is it 09:15, 09:19:32 what. User can choose video sync time and actual trading time, then the system should be able to co-related with trades taken that date or session with video times, and cut the videos.
5. For replay trading, it would take 2 sync times, because it also needs to calculate the speed of replay, or may be it can get the replay speed from somewhere else.
6. It woudl query backend to get the trades taken for that session, for paper and real it is whole day and then cut the video at required time. 
7. If the video finishes, and more trades are present after that, then fine.

These videos would be uploaded to youtube, so it would also need, 
a) The description so that the video has those bars, where user can jump to extract trade. Similar to this:- 
0:00 Introduction
2:15 Unboxing the Product
5:40 How to Setup
9:12 Performance Review 
The description should say trade id (1,2,3 ..) and P&L % of that round trip trade.

b) These details would be provided along with the finished video to the user to be uploaded to youtube.

Choose Ui as you wish, on professional side and matching desktop styling. Add the tools options in the dropdown menu same as analysis etc.

##### Additions (2026-11-09, requested after the first release)
The sections above are the original requirements. These were added later, in chat, and are tracked in `docs/spec-phase24-youtube-plan.md`.
1. **Upload to YouTube from the desktop.** The user signs in with Google; the app asks only for the permission to upload (`youtube.upload`). The finished mp4 is uploaded with its title and the chapter description. Default visibility is Private. The token stays on the PC (Windows Credential Manager).
2. **Keep the links.** Each uploaded video's link is saved on the server against the trading session(s) it covers, so it can be found again and shown on other devices.
3. **Play in the desktop.** The finished mp4 plays inside the desktop app, with the chapters as clickable seek points. Playback is of the local file; the YouTube copy opens in the browser.
4. **Recording stops with the session.** A screen recording stops by itself 10 seconds after the trading session ends (website and desktop; dev only for now).

Status of these: Connect YouTube (#789), recording auto-stop (#790) and upload (#791) are merged; saved links, with the videos shown in Analysis on website and desktop, are in review; the player is planned as the last PR (see the implementation plan status table).

