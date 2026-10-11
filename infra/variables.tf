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
  description = "Senha do usuário mestre do RDS (mínimo 8 caracteres)"
  type        = string
  default     = "StadiumPass2026!"
  sensitive   = true
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
  description = "URL do repositório Git para clonar na inicialização da EC2"
  type        = string
  default     = "https://github.com/Jeovani4lv3s/LojadeIngressos.git"
}

variable "use_existing_lab_role" {
  description = "Defina como true se estiver usando o AWS Academy Learner Lab (usa LabRole pré-existente)"
  type        = bool
  default     = false
}

variable "lab_role_name" {
  description = "Nome da role pré-existente no AWS Academy Learner Lab"
  type        = string
  default     = "LabRole"
}

variable "admin_password" {
  description = "Senha da página de administração (/admin). Altere antes do deploy."
  type        = string
  sensitive   = true
  default     = "admin123"
}
