# TradeMatangi
This repository will hold the backend and frontend for a trading website which will run simulated and paper trading, replaying older days ohlc data with advanced entry and exits strategies with AI Assist for Market Structure Understanding in real-time. It also adds essential risk management features like funds ratio based position sizing based on trade probabilities.


## Deployment
The current repo can be deployed by first creating a data folder and adding a accesskeys.ini with the below details
```
[icicidirect]
api_key=
api_secret=
session_token=

[aws]
access_key=
secret_access_key=
region=us-east-1
url=http://localhost:8000

[ip]
backend_server_ip=<public-ip>
aihelper_server_ip=


[kite]
api_key=
api_secret=
access_token=


[fyers]
app_id=
app_secret=
redirect_url=
app_pin=
sha_hash=
access_token=
refresh_token=


[kotakneo]
access_token=
mobile=
ucc=
mpin=

[paths]
ohlcdata=/home/ec2-user/dbfolder/ohlcdata
logs=/home/ec2-user/dbfolder/tradelogs
alarm=/home/ec2-user/dbfolder/alarms/alarm01.mp3


[langfusecloud]
secret_key=
publickey=
baseurl=https://us.cloud.langfuse.com

[llm]
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
OPEN_ROUTER_API_KEY=
CLAUDE_API_KEY=
GEMINI_API_KEY=

[llm-models]
OPEN_ROUTER=openrouter/free
CLAUDE=claude-haiku-4-5-20251001
OPEN_AI=gpt-5.4-nano
DEEP_SEEK=deepseek/deepseek-v4-pro
GEMINI=gemini/gemini-2.5-flash
```
Further, it also needs dynamodbLocal to be installed. And setup a virtual environment and running pip with requirements.txt in the backend folder shoulld get the work done.
Also, needs nodejs to be installed.  Howerver, the start backend.sh and frontend.sh should also take care of installing dependencies, just be vigilant for the same.
The scripts to run are
```
Setup Tables
./scripts/start-dynamodb.sh
./scripts/setup-dynamodb-tables.py

Run Backend
./scripts/start-backend.sh


Run Frontend
./scripts/start-frontend.sh

```

Installing docker with ddb local for application in AWS EC2.
```
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user
## Log out and log back in
docker run -d -p 8000:8000 amazon/dynamodb-local

# Update package index
sudo yum update -y
# or on AL2023: sudo dnf update -y

# Install Git
sudo yum install -y git
# or on AL2023: sudo dnf install -y git

# Verify
git --version

# (Optional) Basic config
git config --global user.name "Your Name"
git config --global user.email "you@example.com"

# Create plugin directory
sudo mkdir -p /usr/libexec/docker/cli-plugins

# Download latest docker-compose plugin binary
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/libexec/docker/cli-plugins/docker-compose

# Make it executable
sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# Verify
docker compose version


# Stop ddb local running in docker if it is running through docker ps and docker stop container id. Then run
./scripts/start-dynamodb-ec2.sh

sudo dnf install -y python3.11

./scripts/start-dynamodb-tables-ec2.sh
python3 /scripts/setup-dynamodb-tables.py
./scripts/start-backend-ec2.sh



# 1. Install dependencies (if not present)
sudo dnf install -y curl

# 2. Add NodeSource repo (pick the LTS version you want; 20.x is common)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -

# 3. Install Node.js (npm comes with it)
sudo dnf install -y nodejs

# 4. Verify
node -v
npm -v

./scripts/start-frontend-ec2.sh

```

Configuring an HTTPS connection terminating on nginx and using certbot for EC2 
```
sudo dnf update -y
sudo dnf install -y nginx

sudo systemctl enable nginx
sudo systemctl start nginx

# Basic test
curl -I http://localhost

sudo dnf install -y python3 python3-pip

# Create virtualenv for certbot
sudo python3 -m venv /opt/certbot

# Upgrade pip and install certbot + nginx plugin
sudo /opt/certbot/bin/pip install --upgrade pip
sudo /opt/certbot/bin/pip install certbot certbot-nginx

# Make certbot available globally
sudo ln -s /opt/certbot/bin/certbot /usr/bin/certbot

certbot --version


sudo nano /etc/nginx/conf.d/<website>.conf

###copy this:-
server {
    listen 80;
    listen [::]:80;
    server_name tradematangi.co.in www.tradematangi.co.in;

    location / {
        return 200 "Nginx is working for tradematangi.co.in\n";
        add_header Content-Type text/plain;
    }
}


# Test
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d <website> -d www.<website>


```

Add these in the sudo nano /etc/nginx/conf.d/<website>.conf
```
  location / {
         proxy_pass http://127.0.0.1:5173;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /api {
         proxy_pass http://127.0.0.1:8700;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }


     location /ai {
         proxy_pass http://127.0.0.1:8701;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }


    # SSE endpoint (adjust path to match your app)
    location /sse {
        proxy_pass http://127.0.0.1:8000;

        # SSE essentials
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        gzip off;

        # Headers for SSE
        add_header Content-Type 'text/event-stream' always;
        add_header Cache-Control 'no-cache' always;
        add_header X-Accel-Buffering no;

        # Long timeouts for persistent connections
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
    }


````

Currently, it is under deployment, will update the respective links, once it is deployed in vercel, with EC2 Backend.


## Development.

The entire repository is built using coding agents and spec based coding. To have more efficient, the spec.md is actually broker into more phase wise to save context. Further, multiple optimizing including choosing the right plugins when running specific phases to reduce context. Futher, optimization used according to https://platform.claude.com/docs/en/build-with-claude/context-windows. 
