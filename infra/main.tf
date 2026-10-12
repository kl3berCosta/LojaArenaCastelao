terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Segredo JWT compartilhado por todas as instâncias do ASG
resource "random_id" "jwt" {
  byte_length = 24
}

# Sufixo aleatório para recursos que exigem nomes globais únicos (S3)
resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  project_name = var.project_name
  bucket_name  = var.banners_bucket_name != "" ? var.banners_bucket_name : "${var.project_name}-banners-${random_id.suffix.hex}"
  tags = {
    Project     = local.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
    Disciplina  = "SoftwareParaNuvem-UFC"
  }
}

# -------------------------------------------------------------------
# REDE: VPC PADRÃO & SUBNETS (Compatível com AWS Academy & Contas Padrão)
# -------------------------------------------------------------------
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# -------------------------------------------------------------------
# SECURITY GROUPS (Menor Privilégio)
# -------------------------------------------------------------------

# 1. Security Group para o Load Balancer (ALB)
resource "aws_security_group" "alb" {
  name        = "${local.project_name}-alb-sg"
  description = "Permite trafego HTTP publico da internet para o ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP da internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS da internet (usado quando acm_certificate_arn e informado)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Trafego de saida liberado"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# 2. Security Group para as Instâncias EC2 da Aplicação
resource "aws_security_group" "ec2" {
  name        = "${local.project_name}-ec2-sg"
  description = "Permite trafego vindo exclusivamente do ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "HTTP vindo do Load Balancer"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # SSH só existe se um CIDR for informado explicitamente (ex.: "203.0.113.10/32").
  dynamic "ingress" {
    for_each = var.ssh_allowed_cidr != "" ? [var.ssh_allowed_cidr] : []
    content {
      description = "SSH para administracao direta (restrito)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "Trafego de saida liberado"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# 3. Security Group para o Banco Relacional Amazon RDS PostgreSQL
resource "aws_security_group" "rds" {
  name        = "${local.project_name}-rds-sg"
  description = "Permite conexao PostgreSQL vinda das instancias EC2"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL vindo das EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# 4. Security Group para o Amazon ElastiCache Redis
resource "aws_security_group" "redis" {
  name        = "${local.project_name}-redis-sg"
  description = "Permite conexao Redis vinda das instancias EC2"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Redis vindo das EC2"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# -------------------------------------------------------------------
# IAM ROLE & INSTANCE PROFILE PARA AS INSTÂNCIAS EC2
# -------------------------------------------------------------------
resource "aws_iam_role" "ec2" {
  count = var.use_existing_lab_role ? 0 : 1
  name  = "${local.project_name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_policy" "app_permissions" {
  count = var.use_existing_lab_role ? 0 : 1
  name  = "${local.project_name}-app-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject"
        ]
        Resource = "arn:aws:s3:::${local.bucket_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.audit_logs.arn,
          "${aws_dynamodb_table.audit_logs.arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ]
        Resource = aws_sqs_queue.banner_tasks.arn
      },
      {
        # A API publica no SNS (que entrega ao SQS). O envio direto ao SQS é o fallback do código.
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = aws_sns_topic.banner_tasks.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_attach" {
  count      = var.use_existing_lab_role ? 0 : 1
  role       = aws_iam_role.ec2[0].name
  policy_arn = aws_iam_policy.app_permissions[0].arn
}

resource "aws_iam_instance_profile" "ec2" {
  count = var.use_existing_lab_role ? 0 : 1
  name  = "${local.project_name}-ec2-profile"
  role  = aws_iam_role.ec2[0].name
}

# -------------------------------------------------------------------
# PARTE 1 - SERVIÇO 3: AMAZON S3 (Arquivos Binários - Banners dos Jogos)
# -------------------------------------------------------------------
# O bucket é criado aqui (create_banners_bucket = true, padrão). Em contas com SCP que bloqueia a
# leitura de configurações do bucket (AWS Academy: s3:GetBucketObjectLockConfiguration), defina
# create_banners_bucket = false e banners_bucket_name com um bucket criado manualmente;
# nesse caso aplique a bucket policy de leitura pública de "banners/*" descrita no README.
# As imagens são públicas por BUCKET POLICY (a aplicação não usa ACL por objeto).
resource "aws_s3_bucket" "banners" {
  count         = var.create_banners_bucket ? 1 : 0
  bucket        = local.bucket_name
  force_destroy = true # permite "terraform destroy" mesmo com banners enviados

  tags = local.tags
}

resource "aws_s3_bucket_ownership_controls" "banners" {
  count  = var.create_banners_bucket ? 1 : 0
  bucket = aws_s3_bucket.banners[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "banners" {
  count  = var.create_banners_bucket ? 1 : 0
  bucket = aws_s3_bucket.banners[0].id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "banners_public_read" {
  count  = var.create_banners_bucket ? 1 : 0
  bucket = aws_s3_bucket.banners[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadBanners"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.banners[0].arn}/banners/*"
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.banners]
}

# -------------------------------------------------------------------
# PARTE 1 - SERVIÇO 5: AMAZON DYNAMODB (Auditoria NoSQL do CRUD)
# -------------------------------------------------------------------
resource "aws_dynamodb_table" "audit_logs" {
  name         = "${local.project_name}-audit-logs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  # Índice para listar a auditoria em ordem cronológica (Scan não garante ordem):
  # todo item recebe pk = "AUDIT"; a consulta usa pk + timestamp decrescente.
  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  global_secondary_index {
    name            = "by-time"
    hash_key        = "pk"
    range_key       = "timestamp"
    projection_type = "ALL"
  }

  tags = local.tags
}

# -------------------------------------------------------------------
# PARTE 1 - SERVIÇO 6: AMAZON SQS & SNS (Desacoplamento do Worker)
# -------------------------------------------------------------------
# Fila de mensagens que falharam repetidamente (evita reprocessar mensagens "venenosas" por 24h).
resource "aws_sqs_queue" "banner_tasks_dlq" {
  name                      = "${local.project_name}-banner-dlq"
  message_retention_seconds = 1209600

  tags = local.tags
}

resource "aws_sqs_queue" "banner_tasks" {
  name                       = "${local.project_name}-banner-queue"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 5

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.banner_tasks_dlq.arn
    maxReceiveCount     = 5
  })

  tags = local.tags
}

# Fluxo de desacoplamento: API -> SNS (tópico) -> SQS (assinatura) -> Worker.
resource "aws_sns_topic" "banner_tasks" {
  name = "${local.project_name}-banner-topic"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "sqs_sub" {
  topic_arn            = aws_sns_topic.banner_tasks.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.banner_tasks.arn
  raw_message_delivery = true
}

resource "aws_sqs_queue_policy" "sqs_policy" {
  queue_url = aws_sqs_queue.banner_tasks.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSNS"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.banner_tasks.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = aws_sns_topic.banner_tasks.arn
        }
      }
    }]
  })
}

# -------------------------------------------------------------------
# PARTE 1 - SERVIÇO 2: AMAZON RDS (PostgreSQL Relacional)
# -------------------------------------------------------------------
resource "aws_db_subnet_group" "rds" {
  name       = "${local.project_name}-rds-subnets"
  subnet_ids = data.aws_subnets.default.ids
  tags       = local.tags
}

resource "aws_db_instance" "postgres" {
  identifier             = "${local.project_name}-db"
  allocated_storage      = 20
  max_allocated_storage  = 50
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false # acessível apenas de dentro da VPC (Security Group libera só as EC2)
  skip_final_snapshot    = true
  storage_encrypted      = true

  lifecycle {
    # Com engine_version apenas major ("16") a AWS escolhe a minor e faz upgrades automáticos.
    ignore_changes = [engine_version]
  }

  tags = local.tags
}

# -------------------------------------------------------------------
# PARTE 1 - SERVIÇO 4: AMAZON ELASTICACHE (Redis para Cache)
# -------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.project_name}-redis-subnets"
  subnet_ids = data.aws_subnets.default.ids
  tags       = local.tags
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${local.project_name}-redis"
  engine               = "redis"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

  tags = local.tags
}

# -------------------------------------------------------------------
# PARTE 2: APPLICATION LOAD BALANCER (ALB)
# -------------------------------------------------------------------
resource "aws_lb" "app" {
  name               = "${local.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = local.tags
}

resource "aws_lb_target_group" "app" {
  name        = "${local.project_name}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "instance"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags
}

# Com certificado ACM informado: HTTP redireciona para HTTPS e o HTTPS encaminha ao Target Group.
# Sem certificado: HTTP encaminha direto (adequado só para laboratório/demonstração).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.acm_certificate_arn != "" ? "redirect" : "forward"
    target_group_arn = var.acm_certificate_arn != "" ? null : aws_lb_target_group.app.arn

    dynamic "redirect" {
      for_each = var.acm_certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# -------------------------------------------------------------------
# PARTE 2: LAUNCH TEMPLATE & AUTO SCALING GROUP (EC2)
# -------------------------------------------------------------------

# Busca AMI mais recente do Ubuntu 22.04 LTS
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_launch_template" "app" {
  name_prefix   = "${local.project_name}-template-"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.ec2.id]
  }

  iam_instance_profile {
    name = var.use_existing_lab_role ? var.lab_instance_profile_name : aws_iam_instance_profile.ec2[0].name
  }

  # Monitoramento detalhado: métricas de CPU a cada 1 minuto. Sem isso o EC2 publica a cada 5 minutos e
  # os alarmes de 60s do Auto Scaling ficam sem dados / reagem com atraso.
  monitoring {
    enabled = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tpl", {
    repo_url            = var.repo_url
    aws_region          = var.aws_region
    db_username         = urlencode(var.db_username)
    db_password         = urlencode(var.db_password) # a senha vai dentro da DATABASE_URL
    rds_endpoint        = aws_db_instance.postgres.endpoint
    db_name             = var.db_name
    redis_host          = aws_elasticache_cluster.redis.cache_nodes[0].address
    s3_bucket_name      = local.bucket_name
    dynamodb_table_name = aws_dynamodb_table.audit_logs.name
    sqs_queue_url       = aws_sqs_queue.banner_tasks.url
    sns_topic_arn       = aws_sns_topic.banner_tasks.arn
    admin_password      = var.admin_password
    jwt_secret          = random_id.jwt.hex
  }))

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.tags, {
      Name = "${local.project_name}-ec2"
    })
  }

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = var.create_banners_bucket || var.banners_bucket_name != ""
      error_message = "Com create_banners_bucket = false informe banners_bucket_name (bucket criado manualmente)."
    }
  }
}

resource "aws_autoscaling_group" "app" {
  name_prefix         = "${local.project_name}-asg-"
  min_size            = 1
  max_size            = 3
  desired_capacity    = 1
  vpc_zone_identifier = data.aws_subnets.default.ids
  target_group_arns   = [aws_lb_target_group.app.arn]
  health_check_type   = "ELB"
  # O user_data instala Node, dependências nativas (sharp) e sobe os serviços numa t3.micro:
  # precisa de folga para não ser terminada pelo health check do ELB antes de ficar pronta.
  health_check_grace_period = 600

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }

  lifecycle {
    create_before_destroy = true
  }

  tag {
    key                 = "Name"
    value               = "${local.project_name}-asg-instance"
    propagate_at_launch = true
  }
}

# -------------------------------------------------------------------
# PARTE 2: REGRAS DE ELASTICIDADE (CloudWatch Alarms & Scaling Policies)
# -------------------------------------------------------------------

# REGRA c): Se CPU > 70% por mais de 1 minuto -> Adiciona +1 instância (Máx 3)
resource "aws_autoscaling_policy" "scale_out" {
  name                   = "${local.project_name}-scale-out"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 60
  autoscaling_group_name = aws_autoscaling_group.app.name
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${local.project_name}-cpu-high-gt-70"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60 # 1 minuto
  statistic           = "Average"
  threshold           = 70 # 70%
  treat_missing_data  = "notBreaching"
  alarm_description   = "Aciona Scale-Out se uso medio de CPU exceder 70% por mais de 1 minuto"
  alarm_actions       = [aws_autoscaling_policy.scale_out.arn]

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.app.name
  }
}

# REGRA d): Se CPU < 25% por mais de 1 minuto -> Remove -1 instância (Mín 1)
resource "aws_autoscaling_policy" "scale_in" {
  name                   = "${local.project_name}-scale-in"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 60
  autoscaling_group_name = aws_autoscaling_group.app.name
}

resource "aws_cloudwatch_metric_alarm" "cpu_low" {
  alarm_name          = "${local.project_name}-cpu-low-lt-25"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60 # 1 minuto
  statistic           = "Average"
  threshold           = 25 # 25%
  treat_missing_data  = "notBreaching"
  alarm_description   = "Aciona Scale-In se uso medio de CPU ficar abaixo de 25% por mais de 1 minuto"
  alarm_actions       = [aws_autoscaling_policy.scale_in.arn]

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.app.name
  }
}
