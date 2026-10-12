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
> **AWS Academy Learner Lab:** `use_existing_lab_role = true` (usa a `LabRole`) já é o padrão.
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
   * Abra o console da AWS em **EC2 -> Auto Scaling Groups** e **Target Groups**.
   * Mostre que há apenas **1 instância** saudável executando no Target Group.
   * Abra o painel administrativo `http://<ALB-URL>/admin.html` e entre com a `admin_password`.
2. **Disparar a carga de CPU:**
   * No painel, vá na seção de **teste de carga / elasticidade**, use **8 a 15 requisições simultâneas** e duração de **300 segundos**, e clique em **"⚡ Iniciar carga"**.
   * A rota `/stress` é restrita ao administrador (exige o token do login) e cada requisição dura 4s; o painel dispara várias em paralelo até a CPU passar de 70%.
   * Acompanhe a lista de hosts: ao entrar a 2ª instância, aparecerá um novo hostname atendendo.
3. **Mostrar o CloudWatch e o Scale Out:**
   * Vá em **CloudWatch -> Alarms** e mostre o alarme `stadium-tickets-cpu-high-gt-70` entrando em estado **ALARM** (CPU média > 70%).
   * Vá em **Auto Scaling Groups -> Activity History** e mostre o ASG provisionando a **2ª instância**.
   * Vá em **Target Groups** e mostre a nova instância sendo registrada.
4. **Demonstrar o Scale In:**
   * Clique em **"Parar"** (ou aguarde o fim) e a CPU cai para menos de 25%.
   * Mostre o alarme `stadium-tickets-cpu-low-lt-25` acionando o Scale-In.
   * O Auto Scaling encerra a instância extra e retorna à capacidade mínima de 1 instância.

---

## 🧹 Como Destruir os Recursos para Evitar Custos
Após testar e gravar o vídeo, destrua todos os recursos criados:
```bash
terraform destroy -auto-approve
```
