SELECT name FROM service_health
WHERE NOT ok AND name <> 'codex_probe_deferred'
UNION
SELECT 'codex_subscription_gate' FROM settings
WHERE id=1 AND :ready_at::timestamptz IS NOT NULL
  AND value->>'ai_mode'<>'api' AND NOT (value->>'paused')::boolean
  AND NOT EXISTS (SELECT 1 FROM service_health WHERE name='codex_subscription_gate' AND checked_at>:ready_at::timestamptz)
ORDER BY name;
