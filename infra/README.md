# Infraestrutura em Nuvem AWS - Loja de Ingressos (UFC)

Projeto de infraestrutura com **Terraform** desenvolvido para o **Trabalho Prático 1** da disciplina **Desenvolvimento de Software para Nuvem (UFC)**, ministrada pelos professores Dr. Paulo A. L. Rego e Dr. Fernando Antonio Mota Trinta.

---

## 🏗️ Arquitetura Provisionada

```mermaid
flowchart TD
    User["🌐 Torcedor / Cliente (Navegador Web)"] --> ALB["⚖️ Application Load Balancer (ALB)\nPorta 80"]
    
    subgraph ASG_EC2 ["Auto Scaling Group (1 a 3 Instâncias EC2 t3.micro)"]
        EC2_1["💻 EC2 Instância 1\n(API Express :3000 + SQS Worker)"]
        EC2_2["💻 EC2 Instância 2 (Escala sob Carga)\n(API Express :3000 + SQS Worker)"]
    end
    
    ALB -->|Encaminha tráfego HTTP| EC2_1
    ALB -.->|Distribui tráfego| EC2_2
    
    CW["📈 Amazon CloudWatch\nAlarme CPU > 70% (1 min) -> +1\nAlarme CPU < 25% (1 min) -> -1"] -.->|Aciona Políticas| ASG_EC2

    subgraph AWS_SERVICES ["Serviços AWS de Apoio (Parte 1)"]
        RDS[("🐘 Amazon RDS\nPostgreSQL\n(Eventos e Compras)")]
        Redis[("⚡ Amazon ElastiCache\nRedis\n(Cache de Ingressos Restantes)")]
        S3[("🪣 Amazon S3\nBucket de Banners\n(Raw e Processados)")]
        Dynamo[("📝 Amazon DynamoDB\nAuditoria NoSQL\n(Logs de CRUD com Timestamp)")]
        SQS["📬 Amazon SQS\nFila de Processamento Assíncrono"]
        SNS["📢 Amazon SNS\nTópico de Notificações"]
    end

    EC2_1 --> RDS
    EC2_1 --> Redis
    EC2_1 --> S3
    EC2_1 --> Dynamo
    EC2_1 -->|Publica tarefa| SNS
    SNS -->|Assinatura| SQS
    EC2_1 -->|Worker consome fila| SQS
```

---

## 📋 Atendimento aos Requisitos da Especificação

### Parte 1 - Os 6 Serviços AWS Obrigatórios
1. **EC2:** Aplicação Web e API executando em instâncias EC2 (`t3.micro`), inicializadas com script `user_data` que sobe a API Express e o Worker via `systemd`.
2. **Amazon RDS (PostgreSQL):** Banco relacional para dados de eventos e compras de ingressos com controle transacional de concorrência (`db.t3.micro`).
3. **Amazon S3:** Armazenamento de arquivos binários (upload dos banners oficiais dos jogos em `banners/raw/` e banners redimensionados em `banners/processed/`).
4. **Amazon ElastiCache (Redis):** Camada de cache em memória para consultas de alta frequência (`events:list`), reduzindo o consumo de banco e atualizada a cada compra.
5. **Amazon DynamoDB:** Banco NoSQL para log de auditoria obrigatório de todas as operações de CRUD (`CREATE`, `READ`, `UPDATE`, `DELETE`, `ORDER`, `RESCALE_BANNER_*`), contendo ID, ação, dados manipulados e timestamp.
6. **Amazon SNS / SQS (Desacoplamento):** Quando um evento é cadastrado com imagem, a API grava a imagem bruta no S3 e **publica uma mensagem no tópico SNS**, que entrega à **fila SQS** (assinatura com `raw_message_delivery`). O **Worker** (`worker.js`) roda em processo separado, consome a fila, aplica o redimensionamento com `sharp`, salva o thumbnail no S3 e atualiza o RDS. Mensagens que falham repetidamente vão para uma **DLQ**; falhas definitivas marcam o evento como `failed`.

### Novos recursos (fan-out, e-mail e dashboard)
* **SNS `order-events` → 2 filas SQS (fan-out):** cada compra publica um único `PEDIDO_CONFIRMADO`; a fila `tickets` gera o PDF com QR code (S3, prefixo privado `tickets/`) e a fila `notifications` envia o e-mail. Cada fila tem sua DLQ.
* **SNS `customer-emails` (e-mail aos clientes):** o **SES é bloqueado no AWS Academy** (`explicitDeny`), então o e-mail sai por um tópico SNS com protocolo `email`. No cadastro, a aplicação assina o e-mail do cliente com um **filtro pelo próprio endereço**; a AWS envia um e-mail *"AWS Notification - Subscription Confirmation"* que o cliente precisa confirmar (uma vez). Depois disso, cada compra chega por e-mail com o link do PDF.
* **Dashboard do CloudWatch** (`terraform output cloudwatch_dashboard_url`): CPU do grupo com as linhas de 70%/25%, instâncias em serviço, requisições e latência do ALB, estado dos alarmes, filas e métricas de negócio publicadas pela aplicação (namespace `StadiumTickets`: ingressos vendidos, pedidos, reservas, e-mails).

### Parte 2 - Elasticidade e Auto Scaling
* **Application Load Balancer (ALB):** À frente das instâncias distribuindo a carga de trabalho, com health check periódico na rota `/health`.
* **Monitoramento detalhado (1 min) habilitado no Launch Template**, necessário para os alarmes de 60s receberem dados. O `health_check_grace_period` é de 600s para dar tempo ao bootstrap (apt + Node + npm) da instância.
* **Capacidade:** Inicia com **1 instância** (`min_size = 1`, `desired = 1`) e pode crescer até no máximo **3 instâncias** (`max_size = 3`).
* **Regra c) Scale Out:** Se a média de CPU das instâncias exceder **70% por mais de 1 minuto**, uma nova instância é criada.
* **Regra d) Scale In:** Se a média de CPU cair abaixo de **25% por mais de 1 minuto**, uma instância excedente é encerrada.

---

## 🚀 Como Fazer o Deploy com Terraform

### 1. Pré-requisitos
* Terraform instalado (>= 1.5.0)
* AWS CLI configurado com credenciais (`aws configure`)

### 2. Configurar Variáveis
Copie o arquivo de exemplo:
```bash
cp terraform.tfvars.example terraform.tfvars
```
**Obrigatório preencher** `db_password`, `admin_password` e `repo_url` (não há senhas padrão). O `repo_url` deve apontar para o repositório que contém `backend/` e `frontend/` na raiz.

> [!TIP]
> **AWS Academy Learner Lab:** `use_existing_lab_role = true` (usa o instance profile `LabInstanceProfile`, que carrega a role `LabRole`) já é o padrão.
> Se o Terraform falhar ao criar/ler o bucket S3 por causa da SCP do Academy
> (`s3:GetBucketObjectLockConfiguration`), crie o bucket manualmente e use:
> ```hcl
> create_banners_bucket = false
> banners_bucket_name   = "nome-do-seu-bucket"
> ```
> Neste caso, no console do S3 do bucket: desmarque *Block public access* (somente "policies"), e aplique a policy
> `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::nome-do-seu-bucket/banners/*"}]}`.
> A aplicação não usa ACLs: a leitura pública é feita exclusivamente por essa policy.
>
> **Conta comum:** use `use_existing_lab_role = false` para criar a role com menor privilégio.
>
> **Opcionais:** `ssh_allowed_cidr` (SSH fechado por padrão) e `acm_certificate_arn` (habilita HTTPS no ALB).
>
> **Limitação conhecida:** as senhas do RDS/admin são injetadas via `user_data` (visíveis a quem puder ler os metadados da
> instância/estado do Terraform). Em produção real, use AWS Secrets Manager ou SSM Parameter Store.

### 3. Provisionar a Infraestrutura
```bash
cd infra
terraform init
terraform plan
terraform apply -auto-approve
```

Ao finalizar, o Terraform exibirá as saídas (`outputs`), incluindo o link do balanceador:
```bash
application_url = "http://stadium-tickets-alb-XXXXX.us-east-1.elb.amazonaws.com"
```

Acesse esse endereço no seu navegador para utilizar a loja de ingressos!

---

## 🎥 Roteiro para Gravação do Vídeo da Parte 2

A especificação do trabalho exige um link de vídeo demonstrando a Parte 2 funcionando. Siga este roteiro de 2 a 3 minutos:

1. **Mostrar o estado inicial:**
   * Abra o **dashboard do CloudWatch** (`terraform output cloudwatch_dashboard_url`): CPU baixa e **1 instância**.
   * Abra o painel `http://<ALB-URL>/admin.html` → Infraestrutura → **Monitorar** (1 hostname respondendo).
2. **Disparar a carga com o k6** (detalhes em `loadtest/README.md`):
   ```bash
   cd loadtest
   BASE_URL=http://<ALB-URL> ADMIN_PASSWORD='sua-senha' \
   K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=relatorio-k6.html k6 run k6-elasticidade.js
   ```
   * O k6 chama `/stress` (só admin), que ocupa as 2 vCPUs da t3.micro; o painel ao vivo do k6 fica em http://localhost:5665.
3. **Mostrar o Scale Out no dashboard:**
   * A CPU passa da linha de **70%**, o alarme `stadium-tickets-cpu-high-gt-70` vai para **ALARM** e o gráfico de instâncias sobe para **2** (e, com carga sustentada, **3**).
   * No admin, aparecem novos hostnames respondendo (o ALB distribuindo).
   * Opcional: **Auto Scaling Groups → Activity** mostra a criação da instância.
4. **Demonstrar o Scale In:**
   * Ao fim do k6 a CPU cai abaixo de **25%**, o alarme `stadium-tickets-cpu-low-lt-25` dispara e o grupo volta a **1** instância.
   * Mostre o `relatorio-k6.html` com os gráficos do teste completo.

---

## 🧹 Como Destruir os Recursos para Evitar Custos
Após testar e gravar o vídeo, destrua todos os recursos criados:
```bash
terraform destroy -auto-approve
```
