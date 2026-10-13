output "application_url" {
  description = "URL pública de acesso à Loja de Ingressos através do Application Load Balancer (ALB)"
  value       = "http://${aws_lb.app.dns_name}"
}

output "alb_dns_name" {
  description = "DNS Name do Application Load Balancer"
  value       = aws_lb.app.dns_name
}

output "rds_endpoint" {
  description = "Endpoint do banco de dados relacional Amazon RDS PostgreSQL"
  value       = aws_db_instance.postgres.endpoint
}

output "elasticache_endpoint" {
  description = "Endpoint do cluster de cache Amazon ElastiCache Redis"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "s3_banners_bucket" {
  description = "Nome do bucket Amazon S3 para arquivos binários (banners dos eventos)"
  value       = local.bucket_name
}

output "dynamodb_audit_table" {
  description = "Nome da tabela Amazon DynamoDB para auditoria NoSQL de ações do CRUD"
  value       = aws_dynamodb_table.audit_logs.name
}

output "sqs_queue_url" {
  description = "URL da fila Amazon SQS para processamento assíncrono de banners"
  value       = aws_sqs_queue.banner_tasks.url
}

output "sns_topic_arn" {
  description = "ARN do tópico Amazon SNS para notificações assíncronas"
  value       = aws_sns_topic.banner_tasks.arn
}

output "autoscaling_group_name" {
  description = "Nome do Auto Scaling Group gerenciando as instâncias EC2"
  value       = aws_autoscaling_group.app.name
}

output "cloudwatch_scale_out_alarm" {
  description = "Alarme do CloudWatch para CPU > 70% (adiciona +1 instância)"
  value       = aws_cloudwatch_metric_alarm.cpu_high.alarm_name
}

output "cloudwatch_scale_in_alarm" {
  description = "Alarme do CloudWatch para CPU < 25% (remove -1 instância)"
  value       = aws_cloudwatch_metric_alarm.cpu_low.alarm_name
}

output "sqs_dead_letter_queue_url" {
  description = "URL da DLQ que recebe mensagens do processamento de banners que falharam repetidamente"
  value       = aws_sqs_queue.banner_tasks_dlq.url
}

output "cloudwatch_dashboard_url" {
  description = "Dashboard do CloudWatch com CPU, instâncias, requisições, filas e vendas (use no vídeo da Parte 2)"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "sns_order_events_topic_arn" {
  description = "Tópico SNS do evento PEDIDO_CONFIRMADO (fan-out para as filas de PDF e de e-mail)"
  value       = aws_sns_topic.order_events.arn
}

output "sns_customer_emails_topic_arn" {
  description = "Tópico SNS que envia os e-mails aos clientes (assinaturas com filtro por e-mail)"
  value       = aws_sns_topic.customer_emails.arn
}

output "sqs_tickets_queue_url" {
  description = "Fila SQS que gera o PDF dos ingressos"
  value       = aws_sqs_queue.order_consumers["tickets"].url
}

output "sqs_notifications_queue_url" {
  description = "Fila SQS que envia os e-mails de confirmação"
  value       = aws_sqs_queue.order_consumers["notifications"].url
}
