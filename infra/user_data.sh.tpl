#!/bin/bash
set -ex

# Log da inicialização
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "=== INICIANDO CONFIGURAÇÃO DA INSTÂNCIA EC2 (STADIUM TICKETS) ==="

# 1. Atualiza repositórios do sistema
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl build-essential

# 2. Instala Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# 3. Clona ou faz checkout da aplicação
mkdir -p /opt/app
cd /opt/app

if [ ! -d ".git" ]; then
  git clone ${repo_url} /opt/app
fi

cd /opt/app/backend

# 4. Instala dependências do backend
npm install --omit=dev

# 5. Cria arquivo de ambiente (.env) com as credenciais da AWS provisionadas pelo Terraform
cat << 'EOF' > /opt/app/backend/.env
PORT=3000
AWS_REGION=${aws_region}
DATABASE_URL=postgresql://${db_username}:${db_password}@${rds_endpoint}/${db_name}
REDIS_HOST=${redis_host}
REDIS_PORT=6379
S3_BUCKET_NAME=${s3_bucket_name}
DYNAMODB_TABLE_NAME=${dynamodb_table_name}
SQS_QUEUE_URL=${sqs_queue_url}
SNS_TOPIC_ARN=${sns_topic_arn}
ADMIN_PASSWORD=${admin_password}
JWT_SECRET=${jwt_secret}
EOF

# 6. Cria serviço systemd para a API (Webservice)
cat << 'EOF' > /etc/systemd/system/stadium-api.service
[Unit]
Description=Stadium Tickets API Web Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/app/backend
EnvironmentFile=/opt/app/backend/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=stadium-api

[Install]
WantedBy=multi-user.target
EOF

# 7. Cria serviço systemd para o Worker Desacoplado (SQS Consumer)
cat << 'EOF' > /etc/systemd/system/stadium-worker.service
[Unit]
Description=Stadium Tickets SQS Decoupled Worker
After=network.target stadium-api.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/app/backend
EnvironmentFile=/opt/app/backend/.env
ExecStart=/usr/bin/node worker.js
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=stadium-worker

[Install]
WantedBy=multi-user.target
EOF

# 8. Habilita e inicializa os serviços
systemctl daemon-reload
systemctl enable stadium-api
systemctl enable stadium-worker
systemctl start stadium-api
systemctl start stadium-worker

echo "=== INICIALIZAÇÃO DA EC2 FINALIZADA COM SUCESSO ==="
