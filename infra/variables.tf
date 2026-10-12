variable "aws_region" {
  description = "Região AWS para o deploy da infraestrutura"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefixo para identificação dos recursos AWS"
  type        = string
  default     = "stadium-tickets"
}

variable "environment" {
  description = "Ambiente da aplicação (dev, prod)"
  type        = string
  default     = "dev"
}

variable "instance_type" {
  description = "Tipo da instância EC2 (micro ou small, conforme a especificação do trabalho)"
  type        = string
  default     = "t3.micro"
}

variable "db_instance_class" {
  description = "Classe da instância do Amazon RDS PostgreSQL"
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "Nome do banco de dados relacional no RDS"
  type        = string
  default     = "stadiumdb"
}

variable "db_username" {
  description = "Usuário mestre do banco de dados relacional"
  type        = string
  default     = "postgresadmin"
}

variable "db_password" {
  description = "Senha do usuário mestre do RDS (mínimo 12 caracteres). Sem valor padrão: defina em terraform.tfvars."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.db_password) >= 12 && !can(regex("[/@\" ]", var.db_password))
    error_message = "db_password precisa ter pelo menos 12 caracteres e não pode conter '/', '@', '\"' ou espaço (restrições do RDS)."
  }
}

variable "redis_node_type" {
  description = "Tipo do nó do cluster Amazon ElastiCache Redis"
  type        = string
  default     = "cache.t3.micro"
}

variable "banners_bucket_name" {
  description = "Nome único global do bucket S3 para armazenamento dos banners (deixe em branco para gerar aleatório)"
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "URL do repositório Git (com as pastas backend/ e frontend/ na raiz) que a EC2 clona na inicialização"
  type        = string
}

variable "use_existing_lab_role" {
  description = "true no AWS Academy Learner Lab (usa a LabRole pré-existente, pois iam:CreateRole é negado). Use false em contas comuns para criar a role com menor privilégio."
  type        = bool
  default     = true
}

variable "lab_role_name" {
  description = "Nome da role/instance profile pré-existente no AWS Academy Learner Lab"
  type        = string
  default     = "LabRole"
}

variable "admin_password" {
  description = "Senha da página de administração (/admin). Sem valor padrão: defina em terraform.tfvars."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.admin_password) >= 8 && !can(regex("[\\s\"'$\\\\#]", var.admin_password))
    error_message = "admin_password precisa ter pelo menos 8 caracteres e não pode conter espaços, aspas, '$', '#' ou '\\'."
  }
}

variable "create_banners_bucket" {
  description = "true: o Terraform cria o bucket S3 dos banners. false: use um bucket criado manualmente (informe banners_bucket_name) — necessário em contas cuja SCP bloqueia a leitura das configurações do bucket, como o AWS Academy."
  type        = bool
  default     = true
}

variable "ssh_allowed_cidr" {
  description = "CIDR autorizado a acessar a porta 22 das EC2 (ex.: 203.0.113.10/32). Vazio = SSH fechado."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ARN de um certificado ACM para habilitar HTTPS no ALB (HTTP passa a redirecionar para HTTPS). Vazio = somente HTTP."
  type        = string
  default     = ""
}
