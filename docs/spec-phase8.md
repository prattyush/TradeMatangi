#### Phase-VIII Launch

This phase is about launch. The below are changes to be done for launching the UI and server separately.

##### Older Bugs
1. Look for any open bugs in Phase 7 and resolve them.

##### Admin Mode
1. Create a admin user, if already present then communicate the password. Double check the user can log in.
2. Only for Admin user, add in settings inputs to enter ICICI session token and KITE access token. Store these values for all users, probably in DDB, as they change every day.
3. Open to suggestion, should the other values like api secret and api key be shifted to persistence storage like DDB but that would require encryption, or is it better to leave it in the file system of the backend server.

##### Link To Backend
1. I want to shift the backend to EC2 in Fastapi with 2 cores. Can you update the startbackend sccript so that fastapi launches on 2 cores.
2. Can you check that backend server would be working fine for all features, if is is deployed in backend. Will any feature fail due to deployment in backend with 2 cores.
3. What is best way to specify the backend ip address. 1) Should I include a config file in frontend with the ip. 2) Hard Code the IP in the react files directly. Open to suggestions. The IP would be http://52.66.185.106.

