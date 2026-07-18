BEGIN;

UPDATE recipe_components
SET usage_per_product_unit = CASE component_id
    WHEN 'c_anchovy' THEN 0.0133
    WHEN 'c_coconut' THEN 0.0394
    WHEN 'c_cucumber' THEN 0.0275
    WHEN 'c_egg' THEN 1.0000
    WHEN 'c_fuel' THEN 0.0959
    WHEN 'c_packaging' THEN 1.0000
    WHEN 'c_peanut' THEN 0.0125
    WHEN 'c_rice' THEN 0.1000
    WHEN 'c_sambal' THEN 0.0859
END
WHERE merchant_id = 'm_kak_lina_001'
  AND product_id = 'p_nlb_001'
  AND component_id IN (
      'c_anchovy',
      'c_coconut',
      'c_cucumber',
      'c_egg',
      'c_fuel',
      'c_packaging',
      'c_peanut',
      'c_rice',
      'c_sambal'
  );

INSERT INTO schema_migrations (migration_id)
VALUES ('009_demo_recipe_usage')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
