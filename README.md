# Loja de Ingressos para Jogos de Futebol - AWS Cloud

Trabalho Prático 1 da disciplina **Desenvolvimento de Software para Nuvem (UFC)**  
**Professores:** Dr. Paulo A. L. Rego e Dr. Fernando Antonio Mota Trinta  

---

## 🎯 Visão Geral

Plataforma de alta disponibilidade e elasticidade na nuvem AWS para venda de ingressos de jogos de futebol, implementando controle atômico de concorrência, camada de cache distribuído em memória, processamento assíncrono de banners e auditoria completa em banco NoSQL.

### Funcionalidades

- **Setores com preço próprio** (Arquibancada Norte e Sul, Cadeira Central, Camarote) escolhidos num **mapa clicável do estádio**.
- **Reserva temporária de 10 minutos** no checkout: os ingressos saem do estoque ao reservar e voltam sozinhos se a compra não for confirmada (cronômetro na tela).
- **Ingresso em PDF com QR code assinado**, gerado em segundo plano e guardado de forma privada no S3 (download por link temporário).
- **E-mail de confirmação** com o link do ingresso, enviado via **Amazon SNS** (o SES é bloqueado no AWS Academy).
- **Meus ingressos**: cada torcedor vê só as próprias compras e baixa os PDFs.
- **Painel admin** (acesso apenas pelo endereço `/admin.html`): CRUD de jogos e setores, pedidos, auditoria e monitor de instâncias.
- **Elasticidade demonstrável**: teste de carga com **k6** (relatório com gráficos) e **dashboard do CloudWatch** com CPU, instâncias, requisições, filas e vendas.

---

## 🏛️ Arquitetura na Nuvem AWS

A infraestrutura foi desenhada e provisionada em conformidade com as **duas partes** solicitadas na especificação do trabalho:

```mermaid
flowchart TD
    User["🌐 Torcedor / Cliente (Navegador)"] --> ALB["⚖️ Application Load Balancer (ALB)\nPorta 80"]

    subgraph ASG ["Auto Scaling Group (EC2 t3.micro | Min: 1, Max: 3)"]
        EC2_1["💻 Instância EC2 1\n(API Express + Worker SQS)"]
        EC2_2["💻 Instância EC2 2\n(Escala horizontal automática)"]
    end

    ALB -->|Encaminha tráfego| EC2_1
    ALB -.->|Distribui carga| EC2_2

    CW["📈 Amazon CloudWatch\nAlarme CPU > 70% (1 min) -> +1\nAlarme CPU < 25% (1 min) -> -1"] -.->|Dispara Políticas| ASG

    subgraph Services ["Serviços AWS Obrigatórios (Parte 1)"]
        RDS[("🐘 Amazon RDS\nPostgreSQL\n(Eventos e Pedidos)")]
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
    EC2_1 -->|Banner: publica tarefa| SNS
    SNS -->|Assinatura| SQS
    EC2_1 -->|Worker consome filas| SQS
    EC2_1 -->|PEDIDO_CONFIRMADO| SNSO["📢 SNS order-events"]
    SNSO -->|fan-out| QT["📬 SQS: PDF do ingresso"]
    SNSO -->|fan-out| QN["📬 SQS: e-mail"]
    QN -.->|Worker publica| SNSE["✉️ SNS e-mail do cliente"]
    EC2_1 -.->|Métricas de vendas| CW
```

---

## 📋 Conformidade com os Requisitos do Trabalho

| Requisito do Trabalho | Serviço AWS Utilizado | Como foi implementado |
| :--- | :--- | :--- |
| **1. Execução na EC2** | Amazon EC2 | Aplicação Node.js rodando em instâncias EC2 (`t3.micro`) configuradas via `systemd` e `user_data`. |
| **2. Banco Relacional** | Amazon RDS (PostgreSQL) | Fonte única de verdade para eventos, pedidos **e usuários** (compartilhados por todas as instâncias do ASG). Compra com `UPDATE ... WHERE available >= n` transacional: nunca vende mais que o estoque. Se o RDS falhar a API retorna erro (sem fallback para arquivo local). |
| **3. Arquivo Binário** | Amazon S3 | Armazenamento dos banners (`banners/raw/`) e thumbnails (`banners/processed/`). Só aceita imagens (JPEG/PNG/WEBP/GIF); leitura pública via bucket policy (sem ACL). O Terraform cria o bucket. |
| **4. Cache em Memória** | Amazon ElastiCache (Redis) | Cache acelerador de alta frequência para a listagem de jogos e estoque disponível (`events:list`), invalidado a cada nova compra. |
| **5. Auditoria NoSQL** | Amazon DynamoDB | Registro de todas as operações de CRUD (`CREATE`, `READ`, `UPDATE`, `DELETE`, `ORDER`, `RESCALE_BANNER_*`) com tipo de ação, dados manipulados e timestamp. Um índice (`by-time`) lista os registros mais recentes em ordem. |
| **6. Desacoplamento Assíncrono** | Amazon SNS / SQS | (a) **Banner**: a API grava a imagem no S3, publica no SNS (entregue ao SQS) e responde na hora; o **Worker** redimensiona com `sharp`. (b) **Compra**: a API publica um único evento `PEDIDO_CONFIRMADO` no SNS, que faz **fan-out** para duas filas SQS independentes — uma gera o **PDF com QR code** (S3 privado) e a outra envia o **e-mail** ao cliente (SNS e-mail). Cada fila tem **DLQ**. |
| **Parte 2: Elasticidade Horizontal** | ALB + Auto Scaling Group + CloudWatch | Balanceador de carga à frente de 1 a 3 instâncias com regras de escalabilidade por CPU (>70% escala +1, <25% escala -1 por mais de 1 minuto). **Dashboard do CloudWatch** com CPU, instâncias, requisições, filas e métricas de vendas; carga gerada com **k6** (`loadtest/`). |

---

## 📂 Estrutura do Repositório

```text
├── backend/
│   ├── server.js            # Ponto de entrada: sobe o Express (src/app.js) e inicializa RDS/Redis
│   ├── worker.js            # Worker desacoplado: consome a fila, redimensiona imagens (sharp)
│   ├── schema.sql           # Esquema relacional (RDS PostgreSQL) - fonte única
│   ├── test-api.test.js     # Testes automatizados da API e do Worker (Node test runner)
│   ├── package.json         # Dependências (Express, pg, redis, sharp, AWS SDK v3)
│   └── src/                 # Arquitetura MVC, um módulo (pasta) por CRUD
│       ├── app.js           # Monta o Express: middlewares + rotas de cada módulo
│       ├── bootstrap.js     # Inicialização (schema do RDS, Redis)
│       ├── config/          # Variáveis de ambiente e caminhos
│       ├── lib/             # Infra compartilhada: db (RDS), cache (Redis), storage (S3), queue (SNS/SQS), localStore (dev)
│       ├── middlewares/     # auth (JWT/admin), upload (multer), errorHandler
│       └── modules/
│           ├── events/      # CRUD de jogos: model, controller, routes, validation
│           ├── orders/      # Compra (estoque atômico), listagem (admin) e "meus ingressos": model, controller, routes
│           ├── users/       # Cadastro e login de clientes: model, controller, routes, password
│           ├── auth/        # Login do administrador
│           ├── audit/       # Auditoria no DynamoDB: model, controller, routes
│           └── system/      # /health (ALB) e /stress (teste de elasticidade)
├── frontend/
│   ├── index.html           # Vitrine, login e checkout
│   ├── meus-ingressos.html / .js # Tela "Meus ingressos": pedidos do usuário logado
│   ├── admin.html / admin.js # Painel admin: CRUD, pedidos, auditoria, monitor AWS e teste de carga
│   ├── app.js               # Integração assíncrona da vitrine/checkout
│   └── styles.css           # Estilização moderna e responsiva
├── infra/
│   ├── main.tf              # Provisionamento completo em Terraform (ALB, ASG, RDS, Cache, S3, DynamoDB, SNS/SQS + DLQ)
│   ├── variables.tf         # Declaração de variáveis
│   ├── outputs.tf           # Saídas da infraestrutura (URL do ALB, endpoints dos bancos)
│   ├── user_data.sh.tpl     # Script de bootstrap automatizado para a EC2
│   ├── terraform.tfvars.example # Exemplo de configuração
│   └── README.md            # Documentação da infraestrutura e roteiro de gravação do vídeo
├── loadtest/
│   ├── k6-elasticidade.js   # Teste de carga da Parte 2 (k6), com relatório HTML
│   └── README.md            # Como rodar o k6 e o que mostrar no vídeo
├── docker-compose.yml       # Ambiente local com PostgreSQL e Redis para testes
└── README.md                # Este documento
```

### Padrão MVC por módulo

Cada recurso fica em sua pasta em `backend/src/modules/<recurso>/` com:

| Camada | Arquivo | Responsabilidade |
| :--- | :--- | :--- |
| **Model** | `*.model.js` | Acesso a dados (RDS ou store local em dev). Sem conhecer HTTP. |
| **Controller** | `*.controller.js` | Valida a entrada e orquestra model + S3 + cache + auditoria + fila; monta a resposta. |
| **Routes** | `*.routes.js` | Liga URL/verbo HTTP aos controllers e aplica os middlewares (admin, usuário, upload). |
| **View** | `frontend/` | Interface web que consome a API JSON. |

Para criar um novo CRUD, crie a pasta do módulo e registre suas rotas em `src/app.js`.

---

## 💻 Como Executar Localmente

### 1. Iniciar Banco e Cache Locais (Opcional)
Sem `DATABASE_URL` a API usa um arquivo local (`backend/data/store.json`) — **apenas para desenvolvimento**.
Para testar com PostgreSQL e Redis locais via Docker:
```bash
docker compose up -d
cd backend && cp .env.example .env   # já aponta para os containers
export $(grep -v '^#' .env | xargs)  # ou: node --env-file=.env server.js
```

### 2. Rodar a API e o Worker
```bash
cd backend
npm install

# Em um terminal, inicie a API:
npm start

# Em outro terminal, inicie o Worker desacoplado de fila:
npm run worker
```

Acesse a interface no navegador em: `http://localhost:3000`

### 3. Rodar os Testes Automatizados
```bash
cd backend
npm test
```
*Executa 18 testes: rotas da API, healthcheck, autenticação, validações, upload só de imagens, compras concorrentes por setor (nunca vende acima do estoque), setores, reserva temporária (confirmação, cancelamento, expiração e limpeza pelo worker), PDF + e-mail via fan-out, "Meus ingressos" (cada usuário só vê os próprios), log de auditoria e processamento desacoplado do Worker. Os testes usam pastas temporárias e podem ser repetidos à vontade. Funcionam em modo local e também com `DATABASE_URL`/`REDIS_URL` apontando para Postgres/Redis reais.*

---

## ☁️ Como Fazer o Deploy na AWS (Terraform)

Para subir a infraestrutura completa na nuvem e obter a URL do Application Load Balancer:

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # preencha db_password, admin_password e repo_url
terraform init
terraform plan
terraform apply -auto-approve
```

O Terraform imprimirá a URL pública da aplicação:
```bash
application_url = "http://stadium-tickets-alb-XXXXX.us-east-1.elb.amazonaws.com"
```

> **AWS Academy:** o `apply` usa a `LabRole` (instance profile `LabInstanceProfile`). Se a política da conta bloquear a leitura do bucket S3 pelo Terraform, crie o bucket pelo AWS CLI e use `create_banners_bucket = false` (passo a passo em [infra/README.md](infra/README.md)). A instância leva de 2 a 8 minutos após o `apply` para responder (até lá o ALB devolve 502).

### Atualizar a aplicação depois de uma mudança no código

As instâncias baixam o código do GitHub ao nascer. Depois de `git push origin main`, troque a instância para ela pegar a versão nova (o `start-instance-refresh` é bloqueado no AWS Academy):

```bash
aws autoscaling terminate-instance-in-auto-scaling-group --no-should-decrement-desired-capacity \
  --instance-id $(aws autoscaling describe-auto-scaling-groups --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)
```

Mudanças em `infra/` (ou em variáveis como senhas) exigem `terraform apply` antes da troca.

---

## 🔗 Como acessar (depois do deploy)

Use a `application_url` do `terraform output` (sempre `http://`, sem certificado):

| Página | Endereço | Acesso |
| :--- | :--- | :--- |
| Loja (vitrine, mapa de setores, checkout) | `http://<ALB>/` | Público; comprar exige cadastro/login |
| Meus ingressos (pedidos e PDFs) | `http://<ALB>/meus-ingressos.html` | Torcedor logado |
| Painel administrativo | `http://<ALB>/admin.html` | Senha `admin_password` do `terraform.tfvars`. **Não há link na loja**: o acesso é só pelo endereço |
| Status dos serviços | `http://<ALB>/health` | Público (usado pelo health check do ALB) |
| Dashboard do CloudWatch | `terraform output cloudwatch_dashboard_url` | Console da AWS (ver abaixo) |

**Dashboard e console da AWS:** os links do console exigem estar logado na conta. No AWS Academy, abra o console pelo botão **AWS** do Learner Lab (com a sessão ativa) e só então abra o link do dashboard, ou navegue por *CloudWatch → Dashboards → stadium-tickets-elasticidade*.

**E-mails de confirmação de compra:** o SES é bloqueado no AWS Academy, então os e-mails saem pelo **Amazon SNS**. Ao se cadastrar, o torcedor recebe um e-mail **"AWS Notification - Subscription Confirmation"** e precisa clicar em **Confirm subscription** uma única vez (veja também o spam). A partir daí, cada compra chega por e-mail com o link do PDF do ingresso. Contas antigas podem ativar em *Meus ingressos → Ativar e-mails*.

**Senha do admin:** troque o valor de exemplo de `admin_password` no `terraform.tfvars` antes de publicar (ele é público no `terraform.tfvars.example`), rode `terraform apply` e troque a instância.

**Ao terminar:** `terraform destroy` (e, se o bucket foi criado pelo CLI, `aws s3 rb s3://<bucket> --force`). RDS, ALB e ElastiCache são cobrados por hora.

### Documentos de apoio

- [Guia-Apresentacao-Video.pdf](Guia-Apresentacao-Video.pdf): como cada serviço foi usado, glossário e roteiro do vídeo.
- [Servicos-AWS-Implementacao.pdf](Servicos-AWS-Implementacao.pdf): implementação detalhada de cada serviço da AWS.
- [loadtest/README.md](loadtest/README.md): teste de carga com k6.

---

## 🎥 Demonstração da Parte 2 (Vídeo do Auto Scaling)

A especificação do trabalho exige um vídeo demonstrando o Auto Scaling respondendo à carga:
1. Abra o **dashboard do CloudWatch** (`terraform output cloudwatch_dashboard_url`) e o painel `http://<URL-do-ALB>/admin.html` → Infraestrutura → **Monitorar**.
2. Rode o teste de carga com o **k6** (ver [loadtest/README.md](loadtest/README.md)): ele chama a rota `/stress` (restrita ao admin) e gera um relatório HTML com gráficos.
   ```bash
   cd loadtest
   BASE_URL=http://<ALB> ADMIN_PASSWORD='<admin_password do tfvars>' \
   K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=relatorio-k6.html k6 run k6-elasticidade.js
   ```
   Se o login de admin falhar (HTTP 401), a senha passada não é a do `terraform.tfvars`.
3. No console da AWS, acompanhe:
   - A CPU média subindo acima de 70% por 1 minuto.
   - O alarme do **CloudWatch** disparando a política de Scale-Out.
   - O **Auto Scaling Group** criando uma nova instância EC2 e registrando-a no Target Group do ALB.
   - Após o término do teste, a CPU caindo abaixo de 25% e o Auto Scaling encerrando a instância excedente.
