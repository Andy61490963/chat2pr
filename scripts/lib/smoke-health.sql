SELECT name FROM service_health
WHERE NOT ok AND name <> 'codex_probe_deferred'
ORDER BY name;
